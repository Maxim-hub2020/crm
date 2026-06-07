import asyncio
import json
import logging
import os
from urllib.parse import parse_qs

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import AccessToken

from .ai_assistant import CRMAssistantService, humanize_gemini_error
from .models import User
from .subscription import has_assistant_access

logger = logging.getLogger(__name__)


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
    return CRMAssistantService(user, init_gemini_client=False)


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
        "Для создания, изменения и удаления записей обязательно используй функции CRM, не обещай действие без функции."
    )
    return base_instruction + live_instruction


@database_sync_to_async
def _build_tool_declarations(service):
    return service._tool_declarations()


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


class AssistantLiveConsumer(AsyncWebsocketConsumer):
    input_sample_rate = 16000
    output_sample_rate = 24000

    async def connect(self):
        query = parse_qs(self.scope.get("query_string", b"").decode("utf-8", errors="ignore"))
        token = (query.get("token") or [""])[0]
        self.user = await _authenticate_websocket_token(token)

        if not self.user:
            await self.close(code=4401)
            return

        if not await _has_live_assistant_access(self.user):
            await self.close(code=4403)
            return

        await self.accept()

        self.audio_input_queue = asyncio.Queue(maxsize=80)
        self.text_input_queue = asyncio.Queue(maxsize=20)
        self.live_task = asyncio.create_task(self._run_live_session())
        await self._send_event(
            {
                "type": "ready",
                "input_sample_rate": self.input_sample_rate,
                "output_sample_rate": self.output_sample_rate,
            }
        )

    async def disconnect(self, _code):
        task = getattr(self, "live_task", None)
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

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
        await self.send(text_data=json.dumps(payload, ensure_ascii=False))

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
        system_instruction = await _build_system_instruction(service)
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
            async with client.aio.live.connect(model=model, config=config) as session:
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
                    self._send_text_to_gemini(session, types),
                    self._receive_from_gemini(session, types, service),
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            retryable = _is_retryable_live_error(exc)
            logger.warning("Assistant Live session error retryable=%s: %s", retryable, exc)
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
                    await session.send_realtime_input(activity_start=types.ActivityStart())
                elif event_type in {"activity_end", "audio_stream_end"}:
                    logger.info("Assistant Live send activity_end")
                    await session.send_realtime_input(activity_end=types.ActivityEnd())
                continue

            await session.send_realtime_input(
                audio=types.Blob(data=chunk, mimeType=f"audio/pcm;rate={self.input_sample_rate}")
            )

    async def _send_text_to_gemini(self, session, types):
        while True:
            text = await self.text_input_queue.get()
            await session.send_realtime_input(text=text)

    async def _receive_from_gemini(self, session, types, service):
        async for message in session.receive():
            server_content = getattr(message, "server_content", None)
            tool_call = getattr(message, "tool_call", None)

            if server_content:
                await self._handle_server_content(server_content)
            else:
                if getattr(message, "data", None):
                    await self.send(bytes_data=message.data)

                if getattr(message, "text", None):
                    await self._send_event({"type": "output_text", "text": message.text})

            if tool_call:
                await self._handle_tool_call(session, types, service, tool_call)

    async def _handle_server_content(self, server_content):
        model_turn = getattr(server_content, "model_turn", None)
        if model_turn and getattr(model_turn, "parts", None):
            for part in model_turn.parts:
                inline_data = getattr(part, "inline_data", None)
                if inline_data and getattr(inline_data, "data", None):
                    await self.send(bytes_data=inline_data.data)
                if getattr(part, "text", None):
                    await self._send_event({"type": "output_text", "text": part.text})

        input_transcription = getattr(server_content, "input_transcription", None)
        if input_transcription and getattr(input_transcription, "text", None):
            await self._send_event({"type": "input_transcript", "text": input_transcription.text})

        output_transcription = getattr(server_content, "output_transcription", None)
        if output_transcription and getattr(output_transcription, "text", None):
            await self._send_event({"type": "output_text", "text": output_transcription.text})

        if getattr(server_content, "interrupted", False):
            logger.info("Assistant Live server interrupted")
            await self._send_event({"type": "interrupted"})

        if getattr(server_content, "turn_complete", False):
            logger.info("Assistant Live server turn_complete")
            await self._send_event({"type": "turn_complete"})

    async def _handle_tool_call(self, session, types, service, tool_call):
        function_responses = []
        for function_call in getattr(tool_call, "function_calls", []) or []:
            tool_name = getattr(function_call, "name", "")
            arguments = dict(getattr(function_call, "args", {}) or {})
            call_id = getattr(function_call, "id", None)
            payload = await _execute_assistant_tool(service, tool_name, arguments)

            await self._send_event(
                {
                    "type": "tool_call",
                    "name": tool_name,
                    "arguments": payload["event"]["arguments"],
                    "result": payload["event"]["result"],
                    "reply": payload["reply"],
                }
            )

            function_responses.append(
                types.FunctionResponse(
                    id=call_id,
                    name=tool_name,
                    response={"output": payload["event"]["result"]},
                )
            )

        if function_responses:
            await session.send_tool_response(function_responses=function_responses)
