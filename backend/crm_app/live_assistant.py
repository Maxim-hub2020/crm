import asyncio
import base64
import json
import logging
import os
import re
import time
import traceback
import uuid
from urllib.parse import parse_qs

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import AccessToken

from .ai_assistant import CRMAssistantService, GeminiClient, humanize_gemini_error
from .models import FinanceCategory, ProjectCustomField, ProjectStatus, User
from .subscription import has_assistant_access
from .tenancy import current_workspace

logger = logging.getLogger(__name__)

_REFERENCE_CACHE = {}
_PROJECT_CONTEXT_TOOL_NAMES = {
    "get_project_details",
    "update_project",
    "delete_project",
    "create_task",
    "create_project_tasks_from_analysis",
    "create_payment",
    "create_financial_operation",
    "list_project_comments",
    "add_project_comment",
    "add_comment",
    "list_payments",
}
_PROJECT_REFERENCE_MARKERS = (
    "этот проект",
    "этот же проект",
    "в этот",
    "в этот же",
    "в него",
    "в нем",
    "в нём",
    "к нему",
    "по нему",
    "туда",
    "туда же",
    "там же",
    "для него",
    "этой сделки",
    "эту сделку",
    "этой же сделки",
    "проект который создали",
    "проект, который создали",
)


def _is_retryable_live_error(exc):
    text = str(exc or "").lower()
    retryable_markers = [
        "keepalive ping timeout",
        "no close frame received",
        "sent 1011",
        "connectionclosederror",
        "websocket",
    ]
    return any(marker in text for marker in retryable_markers)


def _env_int(name, default):
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


def _json_safe(value):
    return json.loads(json.dumps(value, ensure_ascii=False, default=str))


def _live_stack(limit=8):
    return "".join(traceback.format_stack(limit=limit)[:-1]).strip()


def _split_env_csv(name, default=""):
    raw_value = os.getenv(name, default)
    return [item.strip() for item in raw_value.split(",") if item.strip()]


def _parse_history_param(raw_value):
    if not raw_value:
        return []
    try:
        payload = json.loads(raw_value)
    except (TypeError, ValueError):
        return []
    if not isinstance(payload, list):
        return []
    normalized = []
    for item in payload[-5:]:
        if not isinstance(item, dict):
            continue
        if item.get("user") or item.get("assistant"):
            user_text = str(item.get("user") or "").strip()
            assistant_text = str(item.get("assistant") or "").strip()
            if user_text:
                normalized.append({"role": "user", "text": user_text[:500]})
            if assistant_text:
                normalized.append({"role": "assistant", "text": assistant_text[:500]})
            continue
        role = str(item.get("role") or "").strip()[:30]
        text = str(item.get("text") or item.get("content") or "").strip()
        if role and text:
            normalized.append({"role": role, "text": text[:500]})
    return normalized[-5:]


def _extract_last_project_context(history):
    context = {}
    for item in history or []:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or item.get("content") or "").strip()
        if not text:
            continue
        project_id_match = re.search(r"\blast_project_id=(\d+)\b", text)
        if project_id_match:
            context["project_id"] = int(project_id_match.group(1))
        project_title_match = re.search(r"\blast_project_title=([^;]+)", text)
        if project_title_match:
            context["project_title"] = project_title_match.group(1).strip()
    return context


def _project_context_from_result(result):
    result = result or {}
    project = result.get("project") or {}
    payment = result.get("payment") or {}
    task = result.get("task") or {}

    project_id = project.get("project_id") or payment.get("project_id") or task.get("project_id")
    project_title = (
        project.get("title")
        or project.get("client_name")
        or payment.get("project_name")
        or task.get("project_title")
        or ""
    )
    if not project_id:
        return {}
    return {
        "project_id": int(project_id),
        "project_title": str(project_title or "").strip(),
    }


@database_sync_to_async
def _authenticate_websocket_token(raw_token):
    if not raw_token:
        return None

    try:
        token = AccessToken(raw_token)
    except TokenError:
        return None

    user_id = token.get("user_id")
    if not user_id:
        return None

    return User.objects.filter(id=user_id, is_active=True).first()


@database_sync_to_async
def _has_live_assistant_access(user):
    if user and (getattr(user, "is_superuser", False) or getattr(user, "is_admin", lambda: False)()):
        return True
    return has_assistant_access()


@database_sync_to_async
def _build_assistant_service(user):
    return CRMAssistantService(user, init_gemini_client=False, init_memory=False)


@database_sync_to_async
def _build_system_instruction(service):
    base_instruction = service._system_instruction(message="", tools_enabled=True)
    live_instruction = (
        "\n\nLIVE-РЕЖИМ: слушай непрерывный голосовой поток, отвечай коротко и естественно. "
        "Не проговаривай названия функций, JSON, аргументы и технические действия. "
        "На общие вопросы вроде «какие проекты есть», «какие проекты в работе», «какие задачи на сегодня», "
        "«какие зависшие проекты» отвечай сразу из КЭШ-СНИМКА CRM в системной инструкции. "
        "Не вызывай функции list_projects, list_tasks, list_payments и get_crm_overview для коротких обзорных вопросов, "
        "если нужные данные уже есть в кэше. Функции используй для свежих деталей по конкретной карточке и для действий. "
        "Если вызываешь функцию CRM, сначала дождись результата функции и только потом сообщи итог. "
        "Для создания, изменения и удаления записей обязательно используй функции CRM, не обещай действие без функции. "
        "Если команда неполная, например «создай операцию» или «добавь проект», не называй это ошибкой: "
        "задай один короткий уточняющий вопрос и продолжай диалог."
    )
    return base_instruction + live_instruction


@database_sync_to_async
def _build_reference_cache(user=None):
    now = time.monotonic()
    workspace = current_workspace(user)
    cache_key = getattr(workspace, "id", None) or "default"
    cached = _REFERENCE_CACHE.get(cache_key)
    if cached and cached["payload"] and cached["expires_at"] > now:
        return cached["payload"]

    ttl_seconds = max(30, min(_env_int("CRM_ASSISTANT_REFERENCE_CACHE_TTL_SECONDS", 300), 3600))
    payload = {
        "product_types": _split_env_csv(
            "CRM_ASSISTANT_PRODUCT_TYPES",
            "зеркала,мебель,душевые,стеклянные перегородки",
        ),
        "materials": _split_env_csv(
            "CRM_ASSISTANT_MATERIALS",
            "стекло,зеркало,фурнитура,профиль,ЛДСП,МДФ",
        ),
        "deal_statuses": [
            {
                "code": status.code,
                "name": status.name,
                "stuck_after_days": status.stuck_after_days,
                "is_default": status.is_default,
            }
            for status in ProjectStatus.objects.filter(workspace=workspace).order_by("sort_order", "id")
        ],
        "finance_categories": [
            {"id": category.id, "name": category.name, "type": category.type}
            for category in FinanceCategory.objects.filter(workspace=workspace).order_by("type", "sort_order", "id")
        ],
        "project_fields": [
            {"name": field.name, "type": field.field_type}
            for field in ProjectCustomField.objects.filter(workspace=workspace).order_by("sort_order", "id")
        ],
        "response_templates": _split_env_csv(
            "CRM_ASSISTANT_RESPONSE_TEMPLATES",
            "Сделаю.,Уточните, пожалуйста.,Готово.,Нашел.",
        ),
    }
    _REFERENCE_CACHE[cache_key] = {"payload": payload, "expires_at": now + ttl_seconds}
    return payload


@database_sync_to_async
def _build_low_latency_system_instruction(service, user, current_screen, recent_history, reference_cache):
    role = "admin" if user and getattr(user, "is_admin", lambda: False)() else "manager"
    current_user = {
        "id": getattr(user, "id", None),
        "username": getattr(user, "username", ""),
        "name": (getattr(user, "get_full_name", lambda: "")() or getattr(user, "username", "")).strip(),
        "role": role,
    }

    available_functions = CRMAssistantService.LOW_LATENCY_TOOL_NAMES
    compact_context = {
        "current_user": current_user,
        "current_screen": current_screen or "/assistant",
        "recent_messages": recent_history[-5:],
        "available_functions": available_functions,
        "command_synonyms": CRMAssistantService._command_synonym_rows(available_functions),
        "reference_cache": reference_cache,
    }

    return (
        "Ты low-latency голосовой CRM-помощник. Отвечай по-русски коротко, естественно и без проговаривания "
        "названий функций, JSON, аргументов или технических действий. Для любых действий в CRM обязательно вызывай "
        "function calling, не обещай создание или изменение без результата функции. Если данных не хватает, задай один "
        "короткий уточняющий вопрос и продолжай диалог. Не запрашивай и не анализируй всю CRM целиком: используй только "
        "текущего пользователя, текущий экран, последние 3-5 сообщений, список функций и кэш справочников ниже. "
        "Если пользователь говорит «этот же проект», «туда же», «в него», «по нему» или похожую ссылку, используй "
        "последний project_id из recent_messages или последнего результата функции. "
        "Фразы-синонимы команд бери из command_synonyms: пользователь может говорить «заведи сделку», «поставь задачу», "
        "«зафиксируй аванс», «оставь заметку», «перекинь проект» и похожие формулировки. "
        "Для финансовых команд вроде «создай аванс 30000», «внеси расход на доставку», «добавь оплату клиента» "
        "сам выводи operation_kind и category_name из finance_categories и всегда передавай raw_text с исходной фразой пользователя. "
        "Адреса по умолчанию ищи в Ростове-на-Дону и Ростовской области. "
        "Адрес объекта передавай в object_address; backend проверит Dadata и попросит уточнение, если адрес неполный или похожий. "
        "client_phone необязателен: если пользователь говорит «без телефона» или «телефона нет», оставляй client_phone пустым и не жди номер. "
        "При создании проекта не спрашивай повторно уже названное название. Если названия хватает, но нет клиента, спроси "
        "только клиента и предложи сразу назвать бюджет, адрес или статус. Если клиент и название есть, но optional-данных "
        "нет, один раз спроси, указать ли бюджет, адрес или статус; если пользователь говорит «нет», «не надо», "
        "«без бюджета», «без телефона», «создавай так», вызывай create_deal со skip_optional_details=true. "
        "Для длинных операций используй enqueue_long_operation и сразу отвечай, что задача запущена в фоне. "
        "Если пользователь просит список или состояние, отвечай кратко; детали раскрывай только по уточнению.\n\n"
        f"LOW_LATENCY_CONTEXT:\n{json.dumps(compact_context, ensure_ascii=False, default=str)}"
    )


@database_sync_to_async
def _build_tool_declarations(service):
    return service._low_latency_tool_declarations()


@database_sync_to_async
def _fast_mutation_clarification(service, text):
    return service._fast_mutation_clarification(text)


@database_sync_to_async
def _execute_assistant_tool(service, tool_name, arguments):
    clean_arguments = arguments if isinstance(arguments, dict) else {}
    result = service._execute_tool(tool_name, clean_arguments)
    event = {
        "name": tool_name,
        "arguments": clean_arguments,
        "result": result,
    }
    service.tool_events.append(event)

    reply = ""
    if service._is_mutating_tool(tool_name):
        reply = service._format_mutation_reply([event])

    return _json_safe({"event": event, "reply": reply})


@database_sync_to_async
def _generate_speech_event(user, text):
    clean_text = str(text or "").strip()
    if not clean_text:
        return None

    try:
        speech = GeminiClient().generate_speech(clean_text[:900])
    except Exception as exc:  # pragma: no cover - defensive network fallback
        logger.warning("Assistant Live fallback speech failed: %s", exc)
        return None

    return {
        "type": "assistant_audio",
        "audio_base64": base64.b64encode(speech["audio_bytes"]).decode("ascii"),
        "audio_mime_type": speech["mime_type"],
    }


class AssistantLiveConsumer(AsyncWebsocketConsumer):
    input_sample_rate = 16000
    output_sample_rate = 24000

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.live_session_id = uuid.uuid4().hex[:12]
        self.live_state = "initialized"

    async def connect(self):
        self.live_session_id = uuid.uuid4().hex[:12]
        self.live_state = "connecting"
        query = parse_qs(self.scope.get("query_string", b"").decode("utf-8", errors="ignore"))
        token = (query.get("token") or [""])[0]
        self.current_screen = str((query.get("screen") or ["/assistant"])[0] or "/assistant")[:120]
        self.recent_history = _parse_history_param((query.get("history") or [""])[0])
        self.live_context = list(self.recent_history)
        self.last_project_context = _extract_last_project_context(self.live_context)
        logger.info(
            "Assistant Live websocket connect requested: session=%s screen=%s history_items=%s",
            self.live_session_id,
            self.current_screen,
            len(self.live_context),
        )
        self.user = await _authenticate_websocket_token(token)

        if not self.user:
            logger.warning(
                "Assistant Live websocket close before accept: session=%s code=4401 reason=auth_failed stack=%s",
                self.live_session_id,
                _live_stack(),
            )
            await self.close(code=4401)
            return

        if not await _has_live_assistant_access(self.user):
            logger.warning(
                "Assistant Live websocket close before accept: session=%s code=4403 reason=no_subscription stack=%s",
                self.live_session_id,
                _live_stack(),
            )
            await self.close(code=4403)
            return

        await self.accept()

        self.audio_input_queue = asyncio.Queue(maxsize=80)
        self.text_input_queue = asyncio.Queue(maxsize=20)
        self.turn_metrics = self._new_turn_metrics()
        self.pending_voice_fallback_text = ""
        self.suppress_next_tool_model_turn = False
        self.background_tasks = set()
        self.live_task = asyncio.create_task(self._run_live_session())
        await self._send_event(
            {
                "type": "ready",
                "input_sample_rate": self.input_sample_rate,
                "output_sample_rate": self.output_sample_rate,
            }
        )

    async def disconnect(self, _code):
        logger.info(
            "Assistant Live websocket disconnect: session=%s code=%s state=%s stack=%s",
            getattr(self, "live_session_id", ""),
            _code,
            getattr(self, "live_state", ""),
            _live_stack(),
        )
        task = getattr(self, "live_task", None)
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        for background_task in list(getattr(self, "background_tasks", set())):
            background_task.cancel()
        if getattr(self, "background_tasks", None):
            await asyncio.gather(*self.background_tasks, return_exceptions=True)

    async def receive(self, text_data=None, bytes_data=None):
        if bytes_data:
            await self._put_latest(self.audio_input_queue, bytes_data)
            return

        if not text_data:
            return

        try:
            payload = json.loads(text_data)
        except json.JSONDecodeError:
            payload = {"type": "text", "text": text_data}

        event_type = payload.get("type")
        if event_type == "text" and payload.get("text"):
            await self._put_latest(self.text_input_queue, str(payload["text"]))
        elif event_type == "ping":
            await self._send_event({"type": "pong", "ts": payload.get("ts")})
        elif event_type in {"activity_start", "activity_end", "audio_stream_end"}:
            logger.info("Assistant Live client event: %s", event_type)
            await self._put_latest(self.audio_input_queue, {"type": event_type})

    async def _put_latest(self, queue, item):
        if queue.full():
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        await queue.put(item)

    async def _send_event(self, payload):
        payload = dict(payload or {})
        payload.setdefault("live_session_id", getattr(self, "live_session_id", ""))
        payload.setdefault("live_state", getattr(self, "live_state", ""))
        await self.send(text_data=json.dumps(payload, ensure_ascii=False))

    def _set_live_state(self, state, **details):
        self.live_state = state
        logger.info(
            "Assistant Live state: session=%s state=%s details=%s",
            getattr(self, "live_session_id", ""),
            state,
            _json_safe(details),
        )

    def _create_background_task(self, coro, label="background"):
        task = asyncio.create_task(coro)
        self.background_tasks.add(task)

        def _cleanup(done_task):
            self.background_tasks.discard(done_task)
            try:
                exception = done_task.exception()
            except asyncio.CancelledError:
                return
            if exception:
                logger.warning("Assistant Live %s task failed: %s", label, exception)

        task.add_done_callback(_cleanup)
        return task

    @staticmethod
    def _new_turn_metrics():
        return {
            "turn_started_at": 0.0,
            "activity_end_at": 0.0,
            "input_transcript_at": 0.0,
            "first_model_at": 0.0,
            "first_audio_at": 0.0,
            "turn_complete_at": 0.0,
            "crm_api_ms": 0,
        }

    def _mark_turn_start(self):
        if not self.turn_metrics.get("turn_started_at"):
            self.turn_metrics["turn_started_at"] = time.perf_counter()

    def _mark_first_model_output(self):
        self._mark_turn_start()
        if not self.turn_metrics.get("first_model_at"):
            self.turn_metrics["first_model_at"] = time.perf_counter()

    def _mark_first_audio_output(self):
        self._mark_first_model_output()
        if not self.turn_metrics.get("first_audio_at"):
            self.turn_metrics["first_audio_at"] = time.perf_counter()

    async def _finish_turn_metrics(self, reason="turn_complete"):
        metrics = self.turn_metrics
        if not metrics.get("turn_started_at"):
            self.turn_metrics = self._new_turn_metrics()
            return

        metrics["turn_complete_at"] = time.perf_counter()
        started_at = metrics["turn_started_at"]
        activity_end_at = metrics.get("activity_end_at") or started_at
        input_transcript_at = metrics.get("input_transcript_at") or activity_end_at
        first_model_at = metrics.get("first_model_at") or metrics["turn_complete_at"]
        first_audio_at = metrics.get("first_audio_at") or first_model_at

        result = {
            "speech_to_text_ms": max(0, round((input_transcript_at - activity_end_at) * 1000)),
            "gemini_ms": max(0, round((first_model_at - max(activity_end_at, input_transcript_at)) * 1000)),
            "crm_api_ms": int(metrics.get("crm_api_ms") or 0),
            "text_to_speech_ms": max(0, round((first_audio_at - first_model_at) * 1000)),
            "total_ms": max(0, round((metrics["turn_complete_at"] - started_at) * 1000)),
        }
        log_extra = {"reason": reason, "metrics": result}
        if result["total_ms"] > 3000:
            slow_reason = self._slow_turn_reason(result)
            logger.warning("Assistant Live slow turn: %s", {"slow_reason": slow_reason, **log_extra})
        else:
            logger.info("Assistant Live turn latency: %s", log_extra)

        await self._send_event({"type": "latency", "metrics": result})
        self.turn_metrics = self._new_turn_metrics()

    @staticmethod
    def _slow_turn_reason(metrics):
        candidates = {
            "speech_to_text": metrics.get("speech_to_text_ms", 0),
            "gemini": metrics.get("gemini_ms", 0),
            "crm_api": metrics.get("crm_api_ms", 0),
            "text_to_speech": metrics.get("text_to_speech_ms", 0),
        }
        return max(candidates, key=candidates.get)

    async def _run_live_session(self):
        try:
            from google import genai
            from google.genai import types
        except ImportError:
            await self._send_event(
                {
                    "type": "error",
                    "detail": "Для Gemini Live API не установлен пакет google-genai. Выполните pip install -r requirements.txt.",
                }
            )
            return

        project_id = (
            os.getenv("VERTEX_AI_PROJECT_ID", "").strip()
            or os.getenv("GOOGLE_CLOUD_PROJECT", "").strip()
            or os.getenv("GCLOUD_PROJECT", "").strip()
        )
        location = (
            os.getenv("GEMINI_LIVE_LOCATION", "").strip()
            or os.getenv("VERTEX_AI_LOCATION", "").strip()
            or "europe-west1"
        )
        if location == "global":
            location = "europe-west1"
        model = os.getenv("GEMINI_LIVE_MODEL", "gemini-live-2.5-flash-native-audio").strip()
        voice_name = os.getenv("GEMINI_LIVE_VOICE", os.getenv("GEMINI_TTS_VOICE", "Kore")).strip() or "Kore"
        silence_ms = max(0, min(_env_int("GEMINI_LIVE_SILENCE_MS", 2000), 2000))

        if not project_id:
            await self._send_event(
                {
                    "type": "error",
                    "detail": "Для Gemini Live API нужен VERTEX_AI_PROJECT_ID или GOOGLE_CLOUD_PROJECT в .env backend.",
                }
            )
            return

        service = await _build_assistant_service(self.user)
        reference_cache = await _build_reference_cache(self.user)
        system_instruction = await _build_low_latency_system_instruction(
            service,
            self.user,
            self.current_screen,
            self.live_context,
            reference_cache,
        )
        tool_declarations = await _build_tool_declarations(service)
        function_declarations = [
            types.FunctionDeclaration(
                name=declaration.get("name"),
                description=declaration.get("description", ""),
                parametersJsonSchema=declaration.get("parameters") or {"type": "object", "properties": {}},
            )
            for declaration in tool_declarations
        ]

        client = genai.Client(vertexai=True, project=project_id, location=location)
        config = types.LiveConnectConfig(
            responseModalities=[types.Modality.AUDIO],
            speechConfig=types.SpeechConfig(
                languageCode="ru-RU",
                voiceConfig=types.VoiceConfig(
                    prebuiltVoiceConfig=types.PrebuiltVoiceConfig(voiceName=voice_name)
                ),
            ),
            systemInstruction=types.Content(parts=[types.Part(text=system_instruction)]),
            inputAudioTranscription=types.AudioTranscriptionConfig(languageCodes=["ru-RU"]),
            outputAudioTranscription=types.AudioTranscriptionConfig(languageCodes=["ru-RU"]),
            realtimeInputConfig=types.RealtimeInputConfig(
                automaticActivityDetection=types.AutomaticActivityDetection(
                    disabled=True,
                ),
                activityHandling=types.ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
                turnCoverage=types.TurnCoverage.TURN_INCLUDES_ONLY_ACTIVITY,
            ),
            proactivity=types.ProactivityConfig(proactiveAudio=False),
            tools=[types.Tool(functionDeclarations=function_declarations)],
            maxOutputTokens=700,
            temperature=0.15,
        )

        try:
            logger.info(
                "Assistant Live ai.live.connect start: session=%s model=%s location=%s tools=%s",
                self.live_session_id,
                model,
                location,
                [declaration.get("name") for declaration in tool_declarations],
            )
            async with client.aio.live.connect(model=model, config=config) as session:
                self._set_live_state("connected", model=model, location=location)
                await self._send_event(
                    {
                        "type": "live_connected",
                        "model": model,
                        "voice": voice_name,
                        "silence_ms": silence_ms,
                    }
                )
                logger.info("Assistant Live connected: model=%s location=%s silence_ms=%s", model, location, silence_ms)
                await asyncio.gather(
                    self._send_audio_to_gemini(session, types),
                    self._send_text_to_gemini(session, types, service),
                    self._receive_from_gemini(session, types, service),
                )
        except asyncio.CancelledError:
            logger.info("Assistant Live ai.live.connect cancelled: session=%s stack=%s", self.live_session_id, _live_stack())
            raise
        except Exception as exc:
            retryable = _is_retryable_live_error(exc)
            logger.warning(
                "Assistant Live session error: session=%s state=%s retryable=%s error=%s stack=%s",
                self.live_session_id,
                getattr(self, "live_state", ""),
                retryable,
                exc,
                _live_stack(),
            )
            await self._send_event(
                {
                    "type": "error",
                    "detail": humanize_gemini_error(str(exc), backend="vertex_ai"),
                    "retryable": retryable,
                }
            )

    async def _send_audio_to_gemini(self, session, types):
        while True:
            chunk = await self.audio_input_queue.get()
            if isinstance(chunk, dict):
                event_type = chunk.get("type")
                if event_type == "activity_start":
                    logger.info("Assistant Live send activity_start")
                    self.turn_metrics = self._new_turn_metrics()
                    self._mark_turn_start()
                    await session.send_realtime_input(activity_start=types.ActivityStart())
                elif event_type in {"activity_end", "audio_stream_end"}:
                    logger.info("Assistant Live send activity_end")
                    self._mark_turn_start()
                    self.turn_metrics["activity_end_at"] = time.perf_counter()
                    await session.send_realtime_input(activity_end=types.ActivityEnd())
                continue

            self._mark_turn_start()
            await session.send_realtime_input(
                audio=types.Blob(data=chunk, mimeType=f"audio/pcm;rate={self.input_sample_rate}")
            )

    async def _send_text_to_gemini(self, session, types, service):
        while True:
            text = await self.text_input_queue.get()
            self.turn_metrics = self._new_turn_metrics()
            self.pending_voice_fallback_text = ""
            self._mark_turn_start()
            self.turn_metrics["activity_end_at"] = time.perf_counter()
            fast_response = await _fast_mutation_clarification(service, text)
            if fast_response:
                self.pending_voice_fallback_text = fast_response["reply"]
                await self._send_event(
                    {
                        "type": "tool_call",
                        "name": fast_response.get("intent", "clarification"),
                        "arguments": {"text": text},
                        "result": {"ok": False, "needs_clarification": True, "summary": fast_response["reply"]},
                        "reply": fast_response["reply"],
                    }
                )
                await self._send_voice_fallback_if_needed(force=True)
                await self._finish_turn_metrics(reason="fast_clarification")
                continue
            await session.send_realtime_input(text=text)

    def _append_live_context(self, role, text):
        clean_text = str(text or "").strip()
        if not clean_text:
            return
        self.live_context.append({"role": role, "text": clean_text[:700]})
        self.live_context = self.live_context[-8:]

    def _last_user_text(self):
        for item in reversed(self.live_context):
            if not isinstance(item, dict):
                continue
            if str(item.get("role") or "").lower() != "user":
                continue
            text = str(item.get("text") or item.get("content") or "").strip()
            if text:
                return text
        return ""

    def _with_contextual_project(self, tool_name, arguments):
        if tool_name not in _PROJECT_CONTEXT_TOOL_NAMES:
            return arguments
        if not isinstance(arguments, dict):
            return {}
        if arguments.get("project_id"):
            return arguments

        last_project_id = (getattr(self, "last_project_context", {}) or {}).get("project_id")
        if not last_project_id:
            return arguments

        last_user_text = self._last_user_text().lower()
        project_query_text = str(arguments.get("project_query") or "").strip().lower()
        marker_source = project_query_text or last_user_text
        has_context_reference = any(marker in marker_source for marker in _PROJECT_REFERENCE_MARKERS)
        if not has_context_reference:
            return arguments

        patched_arguments = dict(arguments)
        patched_arguments["project_id"] = last_project_id
        if project_query_text:
            patched_arguments.pop("project_query", None)
        return patched_arguments

    @staticmethod
    def _tool_context_text(event, reply=""):
        result = event.get("result") or {}
        tool_name = event.get("name") or ""
        project_context = _project_context_from_result(result)
        project_id = project_context.get("project_id")
        project_title = project_context.get("project_title")
        parts = [f"CRM tool result: {tool_name}"]
        if project_id:
            parts.append(f"last_project_id={project_id}")
        if project_title:
            parts.append(f"last_project_title={project_title}")
        if reply:
            parts.append(f"reply={reply}")
        return "; ".join(parts)

    @staticmethod
    def _function_call_summaries(tool_call):
        summaries = []
        for function_call in getattr(tool_call, "function_calls", []) or []:
            summaries.append(
                {
                    "id": getattr(function_call, "id", None),
                    "name": getattr(function_call, "name", ""),
                }
            )
        return summaries

    @staticmethod
    def _event_payload_summary(event_payload):
        if not event_payload:
            return {}
        if isinstance(event_payload, dict):
            return _json_safe(event_payload)
        summary = {}
        for attr in ("id", "ids", "name", "reason", "newHandle", "resumable"):
            if hasattr(event_payload, attr):
                summary[attr] = getattr(event_payload, attr)
        return _json_safe(summary)

    async def _receive_from_gemini(self, session, types, service):
        async for message in session.receive():
            setup_complete = getattr(message, "setup_complete", None)
            server_content = getattr(message, "server_content", None)
            tool_call = getattr(message, "tool_call", None)
            tool_call_cancellation = getattr(message, "tool_call_cancellation", None)
            go_away = getattr(message, "go_away", None)
            session_resumption_update = getattr(message, "session_resumption_update", None)
            server_content_sent_audio = False

            if setup_complete:
                logger.info("Assistant Live setupComplete: session=%s", self.live_session_id)
                await self._send_event({"type": "setup_complete"})

            if server_content:
                server_content_sent_audio = await self._handle_server_content(server_content)

            if getattr(message, "data", None) and not server_content_sent_audio:
                self._mark_first_audio_output()
                await self.send(bytes_data=message.data)

            if getattr(message, "text", None):
                self._mark_first_model_output()
                self.pending_voice_fallback_text = message.text
                await self._send_event({"type": "output_text", "text": message.text})

            if tool_call:
                self._create_background_task(
                    self._handle_tool_call(session, types, service, tool_call),
                    label="tool_call",
                )

            if tool_call_cancellation:
                payload = self._event_payload_summary(tool_call_cancellation)
                logger.info("Assistant Live toolCallCancellation: session=%s payload=%s", self.live_session_id, payload)
                self._set_live_state("connected", reason="tool_call_cancellation")
                await self._send_event({"type": "tool_call_cancellation", "payload": payload})

            if go_away:
                payload = self._event_payload_summary(go_away)
                logger.warning("Assistant Live goAway: session=%s payload=%s", self.live_session_id, payload)
                await self._send_event({"type": "go_away", "payload": payload})

            if session_resumption_update:
                payload = self._event_payload_summary(session_resumption_update)
                logger.info("Assistant Live sessionResumptionUpdate: session=%s payload=%s", self.live_session_id, payload)
                await self._send_event({"type": "session_resumption_update", "payload": payload})

    @staticmethod
    def _tool_call_has_mutation(tool_call):
        for function_call in getattr(tool_call, "function_calls", []) or []:
            tool_name = str(getattr(function_call, "name", "") or "")
            if tool_name.startswith(("create_", "update_", "delete_", "add_")):
                return True
        return False

    async def _send_voice_fallback_if_needed(self, force=False):
        text = str(getattr(self, "pending_voice_fallback_text", "") or "").strip()
        if not text:
            return
        if not force and self.turn_metrics.get("first_audio_at"):
            return

        speech_event = await _generate_speech_event(self.user, text)
        if not speech_event:
            logger.warning(
                "Assistant Live voice fallback unavailable: session=%s text_len=%s",
                self.live_session_id,
                len(text),
            )
            await self._send_event({"type": "assistant_audio_unavailable", "text": text})
            return

        self._mark_first_audio_output()
        await self._send_event(speech_event)
        self.pending_voice_fallback_text = ""

    async def _handle_server_content(self, server_content):
        sent_audio = False
        model_turn = getattr(server_content, "model_turn", None)
        if model_turn and getattr(model_turn, "parts", None):
            for part in model_turn.parts:
                inline_data = getattr(part, "inline_data", None)
                if inline_data and getattr(inline_data, "data", None):
                    self._mark_first_audio_output()
                    await self.send(bytes_data=inline_data.data)
                    sent_audio = True
                if getattr(part, "text", None):
                    self._mark_first_model_output()
                    self.pending_voice_fallback_text = part.text
                    await self._send_event({"type": "output_text", "text": part.text})

        input_transcription = getattr(server_content, "input_transcription", None)
        if input_transcription and getattr(input_transcription, "text", None):
            if not self.turn_metrics.get("input_transcript_at"):
                self.turn_metrics["input_transcript_at"] = time.perf_counter()
            self._append_live_context("user", input_transcription.text)
            await self._send_event({"type": "input_transcript", "text": input_transcription.text})

        output_transcription = getattr(server_content, "output_transcription", None)
        if output_transcription and getattr(output_transcription, "text", None):
            self._mark_first_model_output()
            self.pending_voice_fallback_text = output_transcription.text
            await self._send_event({"type": "output_text", "text": output_transcription.text})

        if getattr(server_content, "interrupted", False):
            logger.info("Assistant Live server interrupted")
            self._set_live_state("connected", reason="interrupted")
            await self._send_event({"type": "interrupted"})

        if getattr(server_content, "turn_complete", False):
            logger.info("Assistant Live server turn_complete")
            await self._send_voice_fallback_if_needed()
            self._set_live_state("connected", reason="turn_complete")
            await self._send_event({"type": "turn_complete"})
            await self._finish_turn_metrics(reason="turn_complete")

        return sent_audio

    async def _handle_tool_call(self, session, types, service, tool_call):
        function_responses = []
        tool_call_summaries = self._function_call_summaries(tool_call)
        self._set_live_state("tool_running", tool_calls=tool_call_summaries)
        logger.info("Assistant Live toolCall: session=%s calls=%s", self.live_session_id, tool_call_summaries)
        await self._send_event({"type": "tool_running", "tool_calls": tool_call_summaries})

        for function_call in getattr(tool_call, "function_calls", []) or []:
            tool_name = getattr(function_call, "name", "")
            arguments = dict(getattr(function_call, "args", {}) or {})
            arguments = self._with_contextual_project(tool_name, arguments)
            gemini_function_id = getattr(function_call, "id", None)
            tool_started_at = time.perf_counter()
            try:
                payload = await _execute_assistant_tool(service, tool_name, arguments)
            except Exception as exc:  # pragma: no cover - defensive tool safety net
                logger.exception(
                    "Assistant Live tool handler failed: session=%s id=%s name=%s args=%s",
                    self.live_session_id,
                    gemini_function_id,
                    tool_name,
                    _json_safe(arguments),
                )
                result = {
                    "ok": False,
                    "error": str(exc),
                    "message": "Не удалось выполнить команду CRM. Попробуйте повторить или уточнить данные.",
                }
                payload = _json_safe(
                    {
                        "event": {
                            "name": tool_name,
                            "arguments": arguments,
                            "result": result,
                        },
                        "reply": result["message"],
                    }
                )
            finally:
                self.turn_metrics["crm_api_ms"] += round((time.perf_counter() - tool_started_at) * 1000)
            project_context = _project_context_from_result(payload["event"].get("result"))
            if project_context:
                self.last_project_context = project_context
            context_text = self._tool_context_text(payload["event"], payload["reply"])

            await self._send_event(
                {
                    "type": "tool_call",
                    "name": tool_name,
                    "arguments": payload["event"]["arguments"],
                    "result": payload["event"]["result"],
                    "reply": payload["reply"],
                    "context_text": context_text,
                    "last_project_id": project_context.get("project_id"),
                    "last_project_title": project_context.get("project_title", ""),
                }
            )
            if payload["reply"]:
                self.pending_voice_fallback_text = payload["reply"]
            self._append_live_context("assistant", context_text)

            function_response_payload = {
                "name": tool_name,
                "response": _json_safe(payload["event"]["result"]),
            }
            if gemini_function_id:
                function_response_payload["id"] = gemini_function_id
            else:
                logger.warning("Assistant Live toolCall without id: session=%s name=%s", self.live_session_id, tool_name)

            function_responses.append(types.FunctionResponse(**function_response_payload))

        if function_responses:
            response_summaries = [
                {
                    "id": getattr(response, "id", None) or getattr(response, "kwargs", {}).get("id"),
                    "name": getattr(response, "name", None) or getattr(response, "kwargs", {}).get("name"),
                }
                for response in function_responses
            ]
            self._set_live_state("waiting_for_tool_response", function_responses=response_summaries)
            logger.info("Assistant Live toolResponse sending: session=%s responses=%s", self.live_session_id, response_summaries)
            await session.send_tool_response(function_responses=function_responses)
            logger.info("Assistant Live toolResponse sent: session=%s responses=%s", self.live_session_id, response_summaries)
            self._set_live_state("waiting_for_model_response", function_responses=response_summaries)
            await self._send_event({"type": "tool_response_sent", "function_responses": response_summaries})
        else:
            logger.warning("Assistant Live toolCall had no functionCalls: session=%s", self.live_session_id)
            self._set_live_state("connected", reason="empty_tool_call")
