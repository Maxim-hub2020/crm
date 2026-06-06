import base64
import json
import os
import re
import struct
from datetime import date, datetime, time, timedelta
from decimal import Decimal, InvalidOperation
from urllib import error as urllib_error
from urllib import request as urllib_request

from django.db.models import Sum
from django.utils import timezone

from .models import Account, FinanceCategory, Payment, Project, ProjectComment, ProjectStatus, Task, User
from .models import CRMMemorySnapshot


def normalize_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip().lower()


def truncate_text(value, limit=180):
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return f"{text[: limit - 1].rstrip()}…"


def format_money(value):
    try:
        decimal_value = Decimal(value or 0)
    except (InvalidOperation, TypeError, ValueError):
        decimal_value = Decimal("0")
    return f"{decimal_value.quantize(Decimal('1.00')):,.2f}".replace(",", " ").replace(".00", "")


def parse_iso_date(value):
    if not value:
        return None

    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def parse_iso_datetime(value):
    if not value:
        return None

    raw_value = str(value).strip()
    if not raw_value:
        return None

    try:
        parsed = datetime.fromisoformat(raw_value.replace("Z", "+00:00"))
    except ValueError:
        parsed_date = parse_iso_date(raw_value)
        if not parsed_date:
            return None
        parsed = datetime.combine(parsed_date, time.min)

    if timezone.is_naive(parsed):
        return timezone.make_aware(parsed, timezone.get_current_timezone())
    return parsed


def parse_decimal(value):
    if value in (None, ""):
        return None

    try:
        return Decimal(str(value).replace(" ", "").replace(",", "."))
    except (InvalidOperation, TypeError, ValueError):
        return None


def parse_int(value):
    if value in (None, ""):
        return None

    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def clamp_limit(value, default=10, minimum=1, maximum=25):
    parsed = parse_int(value)
    if parsed is None:
        return default
    return max(minimum, min(parsed, maximum))


def is_truthy(value):
    if isinstance(value, bool):
        return value
    return normalize_text(value) in {"1", "true", "yes", "y", "да", "подтверждаю", "confirm"}


def pcm_to_wav_bytes(pcm_bytes, sample_rate=24000, channels=1, sample_width=2):
    data_size = len(pcm_bytes)
    byte_rate = sample_rate * channels * sample_width
    block_align = channels * sample_width
    bits_per_sample = sample_width * 8
    riff_chunk_size = 36 + data_size

    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        riff_chunk_size,
        b"WAVE",
        b"fmt ",
        16,
        1,
        channels,
        sample_rate,
        byte_rate,
        block_align,
        bits_per_sample,
        b"data",
        data_size,
    )
    return header + pcm_bytes


class GeminiConfigurationError(RuntimeError):
    pass


class GeminiRequestError(RuntimeError):
    pass


GOOGLE_CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
CRM_MEMORY_SCHEMA_VERSION = 2


def humanize_gemini_error(raw_error, backend="google_ai"):
    text = str(raw_error or "").strip()
    normalized = normalize_text(text)

    if "user location is not supported for the api use" in normalized:
        if backend == "google_ai":
            return (
                "Прямой Gemini API через Google AI Studio недоступен из текущей локации сервера. "
                "Для этого проекта переключите backend на Vertex AI: "
                "GEMINI_BACKEND=vertex_ai, VERTEX_AI_PROJECT_ID=<project-id>, "
                "VERTEX_AI_LOCATION=global и настройте ADC или GOOGLE_APPLICATION_CREDENTIALS."
            )

        return (
            "Vertex AI вернул географическое ограничение для текущей конфигурации. "
            "Проверьте страну и доступность Google Cloud для вашего аккаунта, "
            "а также используемый проект и endpoint Vertex AI."
        )

    if "aiplatform.endpoints.predict" in normalized or "permission denied" in normalized:
        return (
            "Vertex AI отклонил запрос по правам доступа. "
            "Для сервисного аккаунта нужны права уровня roles/aiplatform.user "
            "и доступ к проекту VERTEX_AI_PROJECT_ID."
        )

    if "texttospeech.googleapis.com" in normalized and ("service_disabled" in normalized or "has not been used" in normalized):
        return (
            "Озвучка ответа пока недоступна: в Google Cloud проекте выключен Cloud Text-to-Speech API. "
            "Включите API texttospeech.googleapis.com для проекта VERTEX_AI_PROJECT_ID и повторите запрос через пару минут."
        )

    if text.startswith("Gemini API error:"):
        return text

    return f"Gemini API error: {text}"


class GeminiClient:
    def __init__(self):
        self.backend = (os.getenv("GEMINI_BACKEND", "google_ai").strip().lower() or "google_ai")
        if self.backend not in {"google_ai", "vertex_ai"}:
            raise GeminiConfigurationError(
                "GEMINI_BACKEND должен быть google_ai или vertex_ai."
            )

        raw_api_key = os.getenv("GEMINI_API_KEY", "").strip()
        self.api_key = "" if raw_api_key in {"your-gemini-api-key", "change-me"} else raw_api_key
        self.vertex_project = (
            os.getenv("VERTEX_AI_PROJECT_ID", "").strip()
            or os.getenv("GOOGLE_CLOUD_PROJECT", "").strip()
            or os.getenv("GCLOUD_PROJECT", "").strip()
        )
        self.vertex_location = os.getenv("VERTEX_AI_LOCATION", "global").strip() or "global"
        self.tts_language_code = os.getenv("GEMINI_TTS_LANGUAGE_CODE", "ru-RU").strip() or "ru-RU"

        default_model = "gemini-2.5-flash" if self.backend == "vertex_ai" else "gemini-3.5-flash"
        default_tts_model = "gemini-2.5-flash-tts" if self.backend == "vertex_ai" else "gemini-3.1-flash-tts-preview"

        self.model = os.getenv("GEMINI_MODEL", default_model).strip() or default_model
        self.audio_model = os.getenv("GEMINI_AUDIO_MODEL", self.model).strip() or self.model
        self.tts_model = os.getenv("GEMINI_TTS_MODEL", default_tts_model).strip() or default_tts_model
        self.tts_voice = os.getenv("GEMINI_TTS_VOICE", "Kore").strip() or "Kore"
        self.tts_style = os.getenv(
            "GEMINI_TTS_STYLE",
            "Прочитай ответ по-русски естественно, дружелюбно и уверенно, как умный голосовой CRM-помощник.",
        ).strip()
        self._vertex_credentials = None

        if self.backend == "google_ai" and not self.api_key:
            raise GeminiConfigurationError(
                "GEMINI_API_KEY не настроен. Укажите реальный ключ Gemini в рабочем .env backend."
            )
        if self.backend == "vertex_ai" and not self.vertex_project:
            raise GeminiConfigurationError(
                "Для Vertex AI нужен VERTEX_AI_PROJECT_ID или GOOGLE_CLOUD_PROJECT в .env backend."
            )

    def generate_content(
        self,
        system_instruction,
        contents,
        tools=None,
        temperature=0.2,
        max_output_tokens=4096,
        model=None,
        generation_config=None,
    ):
        payload = {
            "contents": contents,
            "generationConfig": {
                "temperature": temperature,
                "candidateCount": 1,
                "maxOutputTokens": max_output_tokens,
            },
        }

        if system_instruction:
            payload["systemInstruction"] = {
                "parts": [{"text": system_instruction}],
            }

        if generation_config:
            payload["generationConfig"].update(generation_config)

        if tools:
            payload["tools"] = [{"functionDeclarations": tools}]

        return self._post(payload, model=model or self.model)

    def transcribe_audio(self, audio_bytes, mime_type):
        if not audio_bytes:
            raise GeminiRequestError("Пустой аудиофайл для распознавания.")

        response = self.generate_content(
            model=self.audio_model,
            system_instruction=(
                "Ты распознаёшь русскую речь пользователя для CRM-помощника. "
                "Верни только точную текстовую расшифровку сказанного по-русски, без пояснений, без кавычек, без служебных фраз. "
                "Если в аудио нет понятной речи, верни пустую строку."
            ),
            contents=[
                {
                    "role": "user",
                    "parts": [
                        {"text": "Точно расшифруй речь из этого аудио."},
                        {
                            "inlineData": {
                                "mimeType": mime_type,
                                "data": base64.b64encode(audio_bytes).decode("ascii"),
                            }
                        },
                    ],
                }
            ],
            temperature=0,
            max_output_tokens=1024,
        )
        transcript = self.extract_text(self.extract_candidate_content(response)).strip()
        return transcript

    def generate_speech(self, text):
        clean_text = str(text or "").strip()
        if not clean_text:
            raise GeminiRequestError("Нельзя озвучить пустой текст.")

        return self._generate_speech_with_gemini_tts(clean_text)

    def _generate_speech_with_gemini_tts(self, clean_text):
        prompt = f"{self.tts_style}\n\nТекст ответа:\n{clean_text}"
        response = self.generate_content(
            model=self.tts_model,
            system_instruction="",
            contents=[{"role": "user", "parts": [{"text": prompt}]}],
            temperature=0.7,
            max_output_tokens=2048,
            generation_config={
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {
                        "prebuiltVoiceConfig": {
                            "voiceName": self.tts_voice,
                        }
                    }
                },
            },
        )
        content = self.extract_candidate_content(response)
        parts = content.get("parts") or []
        inline_data = next((part.get("inlineData") for part in parts if part.get("inlineData")), None)
        if not inline_data or not inline_data.get("data"):
            raise GeminiRequestError("Gemini TTS не вернул аудиоданные.")

        pcm_bytes = base64.b64decode(inline_data["data"])
        wav_bytes = pcm_to_wav_bytes(pcm_bytes)
        return {
            "audio_bytes": wav_bytes,
            "mime_type": "audio/wav",
            "voice_name": self.tts_voice,
        }

    def _post(self, payload, model):
        if self.backend == "vertex_ai":
            return self._post_vertex_ai(payload, model)
        return self._post_google_ai(payload, model)

    def _post_google_ai(self, payload, model):
        req = urllib_request.Request(
            url=f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": self.api_key,
            },
            method="POST",
        )

        try:
            with urllib_request.urlopen(req, timeout=90) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib_error.HTTPError as exc:
            try:
                body = exc.read().decode("utf-8")
            except Exception:
                body = str(exc)
            raise GeminiRequestError(humanize_gemini_error(body, backend="google_ai")) from exc
        except urllib_error.URLError as exc:
            raise GeminiRequestError(f"Не удалось связаться с Gemini: {exc}") from exc

    def _post_vertex_ai(self, payload, model):
        req = urllib_request.Request(
            url=(
                "https://aiplatform.googleapis.com/v1/projects/"
                f"{self.vertex_project}/locations/{self.vertex_location}/publishers/google/models/"
                f"{self._normalize_vertex_model_name(model)}:generateContent"
            ),
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._vertex_access_token()}",
                "x-goog-user-project": self.vertex_project,
            },
            method="POST",
        )

        try:
            with urllib_request.urlopen(req, timeout=90) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib_error.HTTPError as exc:
            try:
                body = exc.read().decode("utf-8")
            except Exception:
                body = str(exc)
            raise GeminiRequestError(humanize_gemini_error(body, backend="vertex_ai")) from exc
        except urllib_error.URLError as exc:
            raise GeminiRequestError(f"Не удалось связаться с Vertex AI Gemini: {exc}") from exc

    def _generate_speech_with_vertex_tts(self, clean_text):
        payload = {
            "input": {
                "prompt": self.tts_style,
                "text": clean_text,
            },
            "voice": {
                "languageCode": self.tts_language_code,
                "name": self.tts_voice,
                "model_name": self._normalize_vertex_model_name(self.tts_model),
            },
            "audioConfig": {
                "audioEncoding": "LINEAR16",
            },
        }

        req = urllib_request.Request(
            url="https://texttospeech.googleapis.com/v1/text:synthesize",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._vertex_access_token()}",
                "x-goog-user-project": self.vertex_project,
            },
            method="POST",
        )

        try:
            with urllib_request.urlopen(req, timeout=90) as response:
                response_data = json.loads(response.read().decode("utf-8"))
        except urllib_error.HTTPError as exc:
            try:
                body = exc.read().decode("utf-8")
            except Exception:
                body = str(exc)
            raise GeminiRequestError(humanize_gemini_error(body, backend="vertex_ai")) from exc
        except urllib_error.URLError as exc:
            raise GeminiRequestError(f"Не удалось связаться с Vertex AI TTS: {exc}") from exc

        audio_content = response_data.get("audioContent")
        if not audio_content:
            raise GeminiRequestError("Vertex AI TTS не вернул аудиоданные.")

        return {
            "audio_bytes": base64.b64decode(audio_content),
            "mime_type": "audio/wav",
            "voice_name": self.tts_voice,
        }

    def _vertex_access_token(self):
        if not self._vertex_credentials:
            try:
                from google.auth import default as google_auth_default
                from google.auth.exceptions import DefaultCredentialsError
                from google.auth.transport.requests import Request as GoogleAuthRequest
            except ImportError as exc:
                raise GeminiConfigurationError(
                    "Для Vertex AI не хватает библиотек google-auth/requests. "
                    "Обновите зависимости backend через requirements.txt."
                ) from exc

            try:
                credentials, detected_project = google_auth_default(scopes=[GOOGLE_CLOUD_SCOPE])
            except DefaultCredentialsError as exc:
                raise GeminiConfigurationError(
                    "Vertex AI не настроен: не найдены Application Default Credentials. "
                    "Укажите GOOGLE_APPLICATION_CREDENTIALS или выполните gcloud auth application-default login."
                ) from exc

            self._vertex_credentials = credentials
            if not self.vertex_project and detected_project:
                self.vertex_project = detected_project

        if not self.vertex_project:
            raise GeminiConfigurationError(
                "Vertex AI не настроен: не удалось определить проект. "
                "Укажите VERTEX_AI_PROJECT_ID или GOOGLE_CLOUD_PROJECT."
            )

        if not self._vertex_credentials.valid or self._vertex_credentials.expired or not self._vertex_credentials.token:
            from google.auth.transport.requests import Request as GoogleAuthRequest

            self._vertex_credentials.refresh(GoogleAuthRequest())

        return self._vertex_credentials.token

    @staticmethod
    def _normalize_vertex_model_name(model):
        clean_model = str(model or "").strip()
        if clean_model.startswith("google/"):
            return clean_model.split("/", 1)[1]
        return clean_model

    @staticmethod
    def extract_candidate_content(response_data):
        candidates = response_data.get("candidates") or []
        if not candidates:
            raise GeminiRequestError("Gemini не вернул кандидатов ответа.")

        content = candidates[0].get("content")
        if not content:
            raise GeminiRequestError("Gemini не вернул content в ответе.")

        return content

    @staticmethod
    def extract_text(content):
        parts = content.get("parts") or []
        text_parts = [part.get("text", "") for part in parts if part.get("text")]
        return "\n".join(part for part in text_parts if part).strip()

    @staticmethod
    def extract_function_calls(content):
        calls = []
        for part in content.get("parts") or []:
            function_call = part.get("functionCall")
            if function_call:
                calls.append(function_call)
        return calls


class CRMAssistantService:
    MAX_TOOL_ROUNDS = 4

    def __init__(self, user, client=None, init_gemini_client=True):
        self.user = user
        self.client = client if client is not None else (GeminiClient() if init_gemini_client else None)
        self.tool_events = []
        self.memory_snapshot = self._get_memory_snapshot()

    def handle_message(self, message, history=None):
        clean_message = (message or "").strip()
        if not clean_message:
            raise ValueError("Сообщение для AI-помощника не может быть пустым.")

        fast_response = self._fast_crm_answer(clean_message)
        if fast_response:
            return fast_response

        reply = self._run_gemini_conversation(clean_message, history or [])
        needs_clarification = any(
            event.get("result", {}).get("needs_clarification") for event in self.tool_events[-1:]
        )
        return {
            "reply": reply,
            "intent": self.tool_events[-1]["name"] if self.tool_events else "conversation",
            "data": {"tool_calls": self.tool_events},
            "needs_clarification": needs_clarification,
        }

    def handle_audio(self, audio_bytes, mime_type, history=None):
        transcript = self.client.transcribe_audio(audio_bytes, mime_type).strip()
        if not transcript:
            raise ValueError("Не удалось распознать речь. Попробуйте сказать команду ещё раз.")

        result = self.handle_message(transcript, history=history)
        result["transcript"] = transcript
        try:
            speech = self.client.generate_speech(result["reply"])
            result["audio_base64"] = base64.b64encode(speech["audio_bytes"]).decode("ascii")
            result["audio_mime_type"] = speech["mime_type"]
            result["voice_name"] = speech["voice_name"]
            result["speech_error"] = ""
        except GeminiRequestError as exc:
            result["audio_base64"] = ""
            result["audio_mime_type"] = ""
            result["voice_name"] = ""
            result["speech_error"] = str(exc)
        return result

    def _run_gemini_conversation(self, message, history):
        contents = self._history_to_contents(history)
        contents.append({"role": "user", "parts": [{"text": message}]})
        tools = self._tool_declarations() if self._should_enable_tools(message) else None
        mutation_requested = self._requires_mutating_tool(message)
        forced_tool_retry = False

        for _ in range(self.MAX_TOOL_ROUNDS):
            response = self.client.generate_content(
                system_instruction=self._system_instruction(message=message, tools_enabled=bool(tools)),
                contents=contents,
                tools=tools,
                temperature=0.1,
                max_output_tokens=700,
            )
            content = self.client.extract_candidate_content(response)
            function_calls = self.client.extract_function_calls(content)

            if function_calls:
                contents.append(content)
                function_response_parts = []

                for function_call in function_calls:
                    tool_name = function_call.get("name", "")
                    arguments = function_call.get("args") or {}
                    if not isinstance(arguments, dict):
                        arguments = {}
                    result = self._execute_tool(tool_name, arguments)
                    self.tool_events.append(
                        {
                            "name": tool_name,
                            "arguments": arguments,
                            "result": result,
                        }
                    )
                    function_response_parts.append(
                        {
                            "functionResponse": {
                                "name": tool_name,
                                "response": result,
                            }
                        }
                    )

                if any(self._is_mutating_tool(event["name"]) for event in self.tool_events[-len(function_calls):]):
                    return self._format_mutation_reply(self.tool_events[-len(function_calls):])

                contents.append({"role": "user", "parts": function_response_parts})
                continue

            reply = self.client.extract_text(content)
            if reply:
                if tools and mutation_requested and not self.tool_events and not forced_tool_retry:
                    contents.append(content)
                    contents.append(
                        {
                            "role": "user",
                            "parts": [
                                {
                                    "text": (
                                        "Это команда на изменение CRM. Нельзя отвечать текстом, что действие выполнено. "
                                        "Сначала вызови подходящую функцию создания, изменения или удаления. "
                                        "Если данных не хватает, вызови функцию так, чтобы она вернула уточнение."
                                    )
                                }
                            ],
                        }
                    )
                    forced_tool_retry = True
                    continue
                if mutation_requested and not self.tool_events:
                    return "Не создал запись. Повторите команду чуть конкретнее: что именно создать и для какого проекта или клиента."
                return reply

            raise GeminiRequestError("Gemini не вернул текстового ответа.")

        raise GeminiRequestError("Gemini не завершил tool-calling сценарий за разумное число шагов.")

    def _fast_crm_answer(self, message):
        text = normalize_text(message)
        if self._looks_like_mutation_request(text):
            return None

        if self._is_fast_greeting(text):
            return self._fast_response(
                "\u0417\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0443\u0439\u0442\u0435. \u0421\u043b\u0443\u0448\u0430\u044e \u0432\u0430\u0441.",
                "greeting_fast",
                {},
            )

        if self._is_fast_stuck_projects_question(text):
            return self._fast_stuck_projects_response()

        if self._is_fast_project_list_question(text):
            only_work = "\u0432 \u0440\u0430\u0431\u043e\u0442" in text
            return self._fast_project_list_response(only_work=only_work)

        return None

    def _is_fast_greeting(self, text):
        normalized = text.strip(" .,!?\u00a0")
        greeting_markers = [
            "\u043f\u0440\u0438\u0432\u0435\u0442",
            "\u0437\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0443\u0439",
            "\u0437\u0434\u0440\u0430\u0441\u0442\u0435",
            "\u0434\u043e\u0431\u0440\u044b\u0439 \u0434\u0435\u043d\u044c",
            "\u0434\u043e\u0431\u0440\u043e\u0435 \u0443\u0442\u0440\u043e",
            "\u0434\u043e\u0431\u0440\u044b\u0439 \u0432\u0435\u0447\u0435\u0440",
        ]
        return any(normalized == marker or normalized.startswith(f"{marker} ") for marker in greeting_markers)

    def _looks_like_mutation_request(self, text):
        if self._requires_mutating_tool(text):
            return True

        mutation_markers = [
            "\u0441\u043e\u0437\u0434",
            "\u0434\u043e\u0431\u0430\u0432",
            "\u043f\u043e\u0441\u0442\u0430\u0432",
            "\u0441\u0434\u0435\u043b\u0430",
            "\u0437\u0430\u0432\u0435\u0434",
            "\u0437\u0430\u043f\u043b\u0430\u043d",
            "\u0437\u0430\u043f\u0438\u0448",
            "\u043f\u043e\u0440\u0443\u0447",
            "\u043d\u0430\u0437\u043d\u0430\u0447",
            "\u0441\u043e\u0445\u0440\u0430\u043d",
            "\u0438\u0437\u043c\u0435\u043d",
            "\u043e\u0431\u043d\u043e\u0432",
            "\u043f\u043e\u043c\u0435\u043d\u044f",
            "\u043f\u0435\u0440\u0435\u043d\u0435\u0441",
            "\u0443\u0434\u0430\u043b",
            "\u0437\u0430\u043a\u0440\u043e",
            "\u043e\u0442\u043c\u0435\u0442",
            "\u0441\u0444\u043e\u0440\u043c\u0438\u0440",
            "\u0437\u0430\u0433\u0440\u0443\u0437",
        ]
        return any(marker in text for marker in mutation_markers)

    def _is_fast_project_list_question(self, text):
        if "\u043f\u0440\u043e\u0435\u043a\u0442" not in text:
            return False

        overview_markers = [
            "\u0432 \u0440\u0430\u0431\u043e\u0442",
            "\u0435\u0441\u0442\u044c",
            "\u0441\u043f\u0438\u0441\u043e\u043a",
            "\u043f\u043e\u043a\u0430\u0436",
            "\u0432\u0441\u0435 \u043f\u0440\u043e\u0435\u043a\u0442",
        ]
        detail_markers = [
            "\u043f\u043e\u0434\u0440\u043e\u0431",
            "\u0434\u0435\u0442\u0430\u043b",
            "\u0444\u0438\u043d\u0430\u043d\u0441",
            "\u043e\u043f\u043b\u0430\u0442",
            "\u043f\u043b\u0430\u0442",
            "\u043a\u043e\u043c\u043c\u0435\u043d\u0442",
            "\u0437\u0430\u0434\u0430\u0447",
            "\u043f\u0440\u043e\u0430\u043d\u0430\u043b\u0438\u0437",
            "\u0430\u043d\u0430\u043b\u0438\u0437",
        ]
        for status in self._status_rows():
            status_name = normalize_text(status.name)
            work_status = "\u0432 \u0440\u0430\u0431\u043e\u0442"
            if status_name and work_status not in status_name and status_name in text:
                return False
        return any(marker in text for marker in overview_markers) and not any(marker in text for marker in detail_markers)

    def _is_fast_stuck_projects_question(self, text):
        if "\u043f\u0440\u043e\u0435\u043a\u0442" not in text:
            return False
        stuck_markers = [
            "\u0437\u0430\u0432\u0438\u0441",
            "\u043f\u0440\u043e\u0441\u0440\u043e\u0447",
            "\u0441\u0442\u043e\u044f\u0442",
            "\u0434\u043e\u043b\u0433\u043e",
        ]
        return any(marker in text for marker in stuck_markers)

    def _fast_response(self, reply, intent, data):
        payload = {"tool_calls": [], "source": "crm_fast_path"}
        payload.update(data or {})
        return {
            "reply": reply,
            "intent": intent,
            "data": payload,
            "needs_clarification": False,
        }

    def _fast_project_line(self, project, status_map, extra=None):
        status_name = status_map.get(project.status) or project.status or "\u0431\u0435\u0437 \u0441\u0442\u0430\u0442\u0443\u0441\u0430"
        parts = [
            f"#{project.id} {project.client_name}",
            f"\u0441\u0442\u0430\u0442\u0443\u0441: {status_name}",
        ]
        if project.total_amount is not None:
            parts.append(f"\u0441\u0443\u043c\u043c\u0430: {format_money(project.total_amount)} \u0440\u0443\u0431.")
        if extra:
            parts.append(extra)
        return "- " + "; ".join(parts)

    def _fast_project_list_response(self, only_work=False):
        status_rows = self._status_rows()
        status_objects = {status.code: status for status in status_rows}
        status_map = {status.code: status.name for status in status_rows}
        projects = list(self._visible_projects().order_by("-updated_at", "-created_at"))

        if only_work:
            projects = [
                project
                for project in projects
                if not self._is_terminal_status(project.status, status_objects.get(project.status))
            ]

        shown = projects[:12]
        if not projects:
            reply = (
                "\u0412 \u0440\u0430\u0431\u043e\u0442\u0435 \u043f\u0440\u043e\u0435\u043a\u0442\u043e\u0432 \u043d\u0435\u0442."
                if only_work
                else "\u041f\u0440\u043e\u0435\u043a\u0442\u043e\u0432 \u043f\u043e\u043a\u0430 \u043d\u0435\u0442."
            )
            return self._fast_response(reply, "list_projects_fast", {"count": 0, "projects": []})

        header = (
            "\u041f\u0440\u043e\u0435\u043a\u0442\u044b \u0432 \u0440\u0430\u0431\u043e\u0442\u0435:"
            if only_work
            else "\u0412\u043e\u0442 \u043f\u0440\u043e\u0435\u043a\u0442\u044b:"
        )
        lines = [self._fast_project_line(project, status_map) for project in shown]
        hidden_count = len(projects) - len(shown)
        if hidden_count > 0:
            lines.append(f"\u0418 \u0435\u0449\u0435 {hidden_count}.")
        lines.append("\u041f\u043e \u043a\u0430\u043a\u043e\u043c\u0443 \u043f\u0440\u043e\u0435\u043a\u0442\u0443 \u0443\u0442\u043e\u0447\u043d\u0438\u0442\u044c \u043f\u043e\u0434\u0440\u043e\u0431\u043d\u0435\u0435?")
        reply = "\n".join([header, *lines])
        serialized = [self._serialize_project(project, include_payments=False, include_comments=False) for project in shown]
        return self._fast_response(reply, "list_projects_fast", {"count": len(projects), "projects": serialized})

    def _fast_stuck_projects_response(self):
        rows = self._stuck_project_rows(limit=12)
        status_map = {status.code: status.name for status in self._status_rows()}
        if not rows:
            return self._fast_response(
                "\u0417\u0430\u0432\u0438\u0441\u0448\u0438\u0445 \u043f\u0440\u043e\u0435\u043a\u0442\u043e\u0432 \u043d\u0435\u0442.",
                "list_stuck_projects_fast",
                {"count": 0, "projects": []},
            )

        lines = []
        projects = []
        for row in rows:
            project = row["project"]
            extra = (
                f"\u0431\u0435\u0437 \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u0439 {row['age_days']} "
                f"\u0434\u043d., \u043b\u0438\u043c\u0438\u0442 {row['stuck_after_days']} \u0434\u043d."
            )
            lines.append(self._fast_project_line(project, status_map, extra=extra))
            serialized = self._serialize_project(project, include_payments=False, include_comments=False)
            serialized["age_days"] = row["age_days"]
            serialized["stuck_after_days"] = row["stuck_after_days"]
            projects.append(serialized)

        reply = "\n".join(["\u0417\u0430\u0432\u0438\u0441\u0448\u0438\u0435 \u043f\u0440\u043e\u0435\u043a\u0442\u044b:", *lines])
        return self._fast_response(reply, "list_stuck_projects_fast", {"count": len(rows), "projects": projects})

    def _requires_mutating_tool(self, message):
        text = normalize_text(message)
        mutation_markers = [
            "созда",
            "создай",
            "создать",
            "добав",
            "постав",
            "сделай",
            "заведи",
            "заплан",
            "запиш",
            "поручи",
            "назнач",
            "сохрани",
            "измени",
            "обнов",
            "поменя",
            "перенеси",
            "удали",
            "закрой",
            "отмет",
            "сформир",
            "загру",
        ]
        mutation_objects = [
            "задач",
            "проект",
            "клиент",
            "операц",
            "платеж",
            "платёж",
            "оплат",
            "комментар",
            "статус",
            "пользовател",
        ]
        return any(marker in text for marker in mutation_markers) and any(obj in text for obj in mutation_objects)

    def _format_mutation_reply(self, events):
        failed_events = [event for event in events if not event.get("result", {}).get("ok")]
        if failed_events:
            result = failed_events[-1].get("result", {})
            return result.get("summary") or "Не получилось выполнить действие. Уточните данные."

        created = [event for event in events if event["name"].startswith(("create_", "add_"))]
        updated = [event for event in events if event["name"].startswith("update_")]
        deleted = [event for event in events if event["name"].startswith("delete_")]

        last_name = events[-1]["name"]
        last_result = events[-1].get("result", {})

        if last_name == "create_task":
            return "Готово, задача создана."
        if last_name == "create_project_tasks_from_analysis":
            count = len(last_result.get("tasks") or [])
            return f"Готово, создал {count} задач по проекту."
        if last_name in {"create_payment", "create_financial_operation"}:
            return "Готово, финансовая операция создана."
        if last_name == "create_project":
            return "Готово, проект создан."
        if last_name == "create_client":
            return "Готово, клиент создан."
        if last_name == "add_project_comment":
            return "Готово, комментарий добавлен."

        if created:
            return "Готово, создано."
        if updated:
            return "Готово, изменения сохранены."
        if deleted:
            return "Готово, удалено."
        return last_result.get("summary") or "Готово."

    def _should_enable_tools(self, message):
        text = normalize_text(message)
        if self._requires_mutating_tool(message):
            return True

        mutation_markers = [
            "созда",
            "добав",
            "постав",
            "сделай",
            "заведи",
            "заплан",
            "запиш",
            "измени",
            "обнов",
            "поменя",
            "перенеси",
            "назнач",
            "удали",
            "закрой",
            "отмет",
            "сформир",
            "загру",
        ]
        detail_markers = [
            "подроб",
            "детал",
            "карточк",
            "комментар",
            "операц",
            "платеж",
            "платёж",
            "оплат",
            "финанс",
            "задач",
            "проанализ",
            "анализ",
            "разлож",
            "точно",
            "актуаль",
            "обнови данные",
        ]

        if any(marker in text for marker in mutation_markers):
            return True

        if any(marker in text for marker in detail_markers):
            return True

        # Обзорные вопросы быстрее отвечаются из кэш-снимка CRM без отдельного tool-call.
        overview_markers = [
            "какие",
            "список",
            "сколько",
            "что у нас",
            "покажи",
            "зависш",
            "клиент",
            "проект",
            "статус",
            "счет",
            "счёт",
            "категор",
        ]
        return not any(marker in text for marker in overview_markers)

    def _history_to_contents(self, history):
        contents = []

        for item in history[-60:]:
            role = item.get("role")
            text = str(item.get("content") or "").strip()
            if not text or role not in {"user", "assistant", "model"}:
                continue

            contents.append(
                {
                    "role": "model" if role in {"assistant", "model"} else "user",
                    "parts": [{"text": text}],
                }
            )

        return contents

    def _memory_prompt_context(self, message="", tools_enabled=False):
        if not self.memory_snapshot:
            return "Снимок CRM пока пуст."

        payload = self.memory_snapshot.payload or {}
        text = normalize_text(message)
        lines = [
            f"Обновлено: {payload.get('refreshed_at', '')}.",
            f"Проектов всего: {payload.get('project_count', 0)}.",
        ]

        projects_by_status = payload.get("projects_by_status") or {}
        if projects_by_status:
            lines.append("По статусам: " + ", ".join(f"{name}: {count}" for name, count in projects_by_status.items()) + ".")

        stuck_projects = payload.get("stuck_projects") or []
        clients = payload.get("clients") or []
        tasks = payload.get("open_tasks") or []
        payments = payload.get("recent_payments") or []
        projects = payload.get("projects") or []
        accounts = payload.get("accounts") or []
        categories = payload.get("finance_categories") or []

        lines.append(f"Зависших проектов: {len(stuck_projects)}.")
        lines.append(f"Клиентов в снимке: {len(clients)}.")
        lines.append(f"Открытых задач в снимке: {len(tasks)}.")
        lines.append(f"Платежи за текущий месяц: {format_money(payload.get('month_payment_total'))} ₽.")

        if tools_enabled:
            lines.append("Для деталей и любых изменений используй функции. Этот снимок только для ориентира и быстрых уточнений.")
            project_limit = 8
        else:
            project_limit = 20

        wants_stuck = "завис" in text
        wants_clients = "клиент" in text
        wants_tasks = "задач" in text or "сегодня" in text or "завтра" in text
        wants_finance = any(marker in text for marker in ["финанс", "платеж", "платёж", "оплат", "счет", "счёт", "деньг", "операц"])
        wants_projects = any(marker in text for marker in ["проект", "работ", "статус", "какие", "список", "покажи"])

        if stuck_projects and (wants_stuck or not tools_enabled):
            lines.append("Зависшие проекты:")
            for project in stuck_projects[:12]:
                lines.append(
                    f"- #{project.get('project_id')} {project.get('client_name')} | {project.get('status')} | без изменений {project.get('age_days')} дн."
                )

        if projects and (wants_projects or (not tools_enabled and not any([wants_stuck, wants_clients, wants_tasks, wants_finance]))):
            lines.append("Проекты:")
            for project in projects[:project_limit]:
                parts = [
                    f"#{project.get('project_id')} {project.get('client_name')}",
                    f"статус: {project.get('status')}",
                ]
                if project.get("total_amount"):
                    parts.append(f"сумма: {format_money(project.get('total_amount'))} ₽")
                if project.get("paid_total") and Decimal(project.get("paid_total") or "0"):
                    parts.append(f"оплачено: {format_money(project.get('paid_total'))} ₽")
                lines.append("- " + " | ".join(parts))

        if clients and wants_clients:
            lines.append("Клиенты:")
            for client in clients[:15]:
                lines.append(
                    f"- {client.get('client_name')} | проектов: {client.get('project_count')} | телефон: {client.get('phone') or 'не указан'}"
                )

        if tasks and wants_tasks:
            lines.append("Задачи:")
            for task in tasks[:15]:
                lines.append(
                    f"- #{task.get('task_id')} {task.get('title')} | срок: {task.get('due_date') or 'без срока'} | {task.get('status')}"
                )

        if wants_finance:
            if accounts:
                lines.append("Счета: " + ", ".join(account.get("name", "") for account in accounts[:10]) + ".")
            if categories:
                lines.append("Категории финансов: " + ", ".join(category.get("name", "") for category in categories[:20]) + ".")
            if payments:
                lines.append("Последние платежи:")
                for payment in payments[:10]:
                    lines.append(f"- #{payment.get('payment_id')} {payment.get('project')} | {format_money(payment.get('amount'))} ₽ | {payment.get('type')}")

        return "\n".join(lines)

    def _system_instruction(self, message="", tools_enabled=False):
        today = timezone.localdate().isoformat()
        visible_statuses = ", ".join(
            f"{status.name} ({status.code})" for status in ProjectStatus.objects.all().order_by("sort_order", "id")[:20]
        )
        visible_users = ", ".join(
            (person.get_full_name() or person.username)
            for person in self._visible_users()[:20]
        )
        memory_text = self._memory_prompt_context(message=message, tools_enabled=tools_enabled)

        return (
            "Ты голосовой CRM-помощник для внутренней системы компании. "
            "Веди диалог по-русски, естественно и по делу. "
            "Отвечай коротко: обычно 1-4 короткие строки. Не делай длинных обзоров, вступлений и пояснений, если пользователь их не просил. "
            "Если пользователь спрашивает «какие проекты есть», «какие проекты в работе» или похожий общий вопрос, просто перечисли проекты коротким списком: название, статус, сумма если есть. "
            "После общего списка добавь один короткий вопрос: «По какому проекту уточнить подробнее?» "
            "Подробно разбирай проект только если пользователь назвал конкретный проект или попросил детали, финансы, комментарии, задачи или следующий шаг по нему. "
            "Если вопрос неоднозначный, сначала задай один наводящий вопрос вместо подробного ответа. "
            "Ты встроен во все основные модули CRM: дашборд, проекты, клиенты, задачи, финансы, комментарии, пользователи, статусы канбана и системные настройки. "
            "Зависшие проекты — это отдельный модуль дашборда: проекты в незавершённых статусах, которые не менялись дольше лимита этапа. "
            "Для вопросов про зависшие проекты используй список stuck_projects из кэш-снимка или функцию list_stuck_projects. "
            "Модуль клиентов сейчас строится по клиентским данным проектов; create_client создаёт клиентскую карточку в CRM как проект в первом/дефолтном статусе без суммы. "
            "Финансовая операция — это платёж по проекту; для создания операции используй create_financial_operation или create_payment. "
            "Если пользователь просит проанализировать проект и сам создать по нему задачи, используй create_project_tasks_from_analysis: выбери понятные рабочие задачи по статусу, описанию, адресу, сумме, комментариям и финансам проекта. "
            "Для общих справочных вопросов используй кэш-снимок CRM ниже и не вызывай функции без необходимости. "
            "Все фактические ответы о проектах, задачах, финансах, комментариях, пользователях и статусах строй только на основании кэш-снимка CRM или результатов доступных функций. "
            "Если нужен точный свежий ответ по конкретному объекту, детальная карточка, комментарии, финансы, создание, изменение или удаление — используй функции. "
            "Если пользователь просит что-то создать, изменить или удалить, обязательно используй функции и сообщай о результате только после успешного ответа функции. "
            "Ты можешь вызывать несколько функций подряд, если нужно сначала найти сущность, а потом изменить её. "
            "Если функция вернула needs_clarification=true, задай один короткий уточняющий вопрос и не выдумывай выполнение действия. "
            "Если пользователь просит удалить проект, задачу, платёж или статус, требуй явного подтверждения и вызывай delete-функцию только при confirm=true. "
            "Не придумывай идентификаторы, суммы, статусы и не ссылайся на данные, которых не было в функциях. "
            "Никогда не комментируй кодировку, символы, качество распознавания, технические ошибки отображения вопроса и не пиши фразы вроде "
            "«ваше сообщение отобразилось некорректно» или «судя по структуре вопроса». "
            "Если смысл вопроса понятен, отвечай сразу по фактам. "
            "Если пользователь спрашивает про один проект, используй get_project_details. Если про список проектов, используй list_projects. "
            "Если спрашивают про финансы, используй list_payments. Если про задачи, используй list_tasks. "
            "Если в вопросе назван статус проекта, передавай его в list_projects.status_name. "
            f"Сегодняшняя дата: {today}. "
            f"Доступные статусы канбана: {visible_statuses or 'пока не заданы'}. "
            f"Доступные пользователи: {visible_users or 'только текущий пользователь'}. "
            f"\n\nКЭШ-СНИМОК CRM ДЛЯ БЫСТРЫХ ОТВЕТОВ:\n{memory_text or 'Снимок пока пуст.'}"
        )

    def _tool_declarations(self):
        return [
            {
                "name": "get_crm_overview",
                "description": "Общая сводка по CRM: количество проектов, задач, платежей и распределение по статусам.",
                "parameters": {"type": "object", "properties": {}},
            },
            {
                "name": "list_projects",
                "description": "Список проектов с фильтрами по статусу и текстовому запросу.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "status_name": {"type": "string", "description": "Название или код статуса проекта."},
                        "project_query": {"type": "string", "description": "Поиск по имени клиента, телефону, адресу или описанию."},
                        "limit": {"type": "integer", "description": "Сколько проектов вернуть, максимум 20."},
                        "include_payments": {"type": "boolean", "description": "Добавить суммы и количество платежей по проекту."},
                        "include_comments": {"type": "boolean", "description": "Добавить последний комментарий по каждому проекту."},
                    },
                },
            },
            {
                "name": "list_stuck_projects",
                "description": "Список зависших проектов: незавершённые проекты без изменений дольше лимита этапа.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "limit": {"type": "integer", "description": "Сколько зависших проектов вернуть, максимум 20."},
                    },
                },
            },
            {
                "name": "list_clients",
                "description": "Список клиентов CRM. Клиенты берутся из клиентских данных проектов.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "client_query": {"type": "string", "description": "Поиск по имени, телефону, email или адресу."},
                        "limit": {"type": "integer", "description": "Сколько клиентов вернуть, максимум 25."},
                    },
                },
            },
            {
                "name": "create_client",
                "description": "Создать клиентскую карточку в CRM. Сейчас клиент хранится как проект в дефолтном статусе без суммы.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "client_name": {"type": "string"},
                        "client_phone": {"type": "string"},
                        "client_email": {"type": "string"},
                        "object_address": {"type": "string"},
                        "works_with_contract": {"type": "boolean"},
                        "comment": {"type": "string"},
                    },
                    "required": ["client_name"],
                },
            },
            {
                "name": "get_project_details",
                "description": "Подробная карточка одного проекта с финансами и комментариями.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project_id": {"type": "integer", "description": "ID проекта."},
                        "project_query": {"type": "string", "description": "Поиск проекта по имени клиента, телефону, адресу или описанию."},
                    },
                },
            },
            {
                "name": "create_project",
                "description": "Создать новый проект в CRM.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "client_name": {"type": "string"},
                        "client_phone": {"type": "string"},
                        "client_email": {"type": "string"},
                        "object_address": {"type": "string"},
                        "description": {"type": "string"},
                        "total_amount": {"type": "number"},
                        "status_name": {"type": "string"},
                        "categories": {"type": "string"},
                        "works_with_contract": {"type": "boolean"},
                        "manager_name": {"type": "string", "description": "Имя или логин менеджера, только для администратора."},
                    },
                    "required": ["client_name"],
                },
            },
            {
                "name": "update_project",
                "description": "Изменить данные проекта или его статус.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project_id": {"type": "integer"},
                        "project_query": {"type": "string"},
                        "client_name": {"type": "string"},
                        "client_phone": {"type": "string"},
                        "client_email": {"type": "string"},
                        "object_address": {"type": "string"},
                        "description": {"type": "string"},
                        "total_amount": {"type": "number"},
                        "status_name": {"type": "string"},
                        "categories": {"type": "string"},
                        "works_with_contract": {"type": "boolean"},
                        "manager_name": {"type": "string"},
                    },
                },
            },
            {
                "name": "delete_project",
                "description": "Удалить проект из CRM. Требует явного подтверждения confirm=true.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project_id": {"type": "integer"},
                        "confirm": {"type": "boolean"},
                    },
                    "required": ["project_id", "confirm"],
                },
            },
            {
                "name": "list_tasks",
                "description": "Получить список задач по сроку, исполнителю и статусу.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "date_scope": {
                            "type": "string",
                            "enum": ["today", "tomorrow", "week", "month", "all", "overdue", "specific"],
                        },
                        "due_date": {"type": "string", "description": "Дата в формате YYYY-MM-DD для specific."},
                        "assignee_name": {"type": "string"},
                        "include_done": {"type": "boolean"},
                        "limit": {"type": "integer"},
                    },
                },
            },
            {
                "name": "create_task",
                "description": "Создать задачу. Если задача относится к проекту, передай project_id или project_query.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "notes": {"type": "string"},
                        "due_date": {"type": "string"},
                        "priority": {"type": "string", "enum": ["low", "medium", "high"]},
                        "assignee_name": {"type": "string"},
                        "project_id": {"type": "integer"},
                        "project_query": {"type": "string"},
                    },
                    "required": ["title"],
                },
            },
            {
                "name": "create_project_tasks_from_analysis",
                "description": "Проанализировать конкретный проект и создать по нему несколько рабочих задач. Используй, когда пользователь просит Gemini сам понять проект и разложить его на задачи.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project_id": {"type": "integer"},
                        "project_query": {"type": "string"},
                        "assignee_name": {"type": "string"},
                        "tasks": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "title": {"type": "string"},
                                    "notes": {"type": "string"},
                                    "due_date": {"type": "string"},
                                    "priority": {"type": "string", "enum": ["low", "medium", "high"]},
                                },
                                "required": ["title"],
                            },
                        },
                    },
                },
            },
            {
                "name": "update_task",
                "description": "Изменить задачу.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "task_id": {"type": "integer"},
                        "task_query": {"type": "string"},
                        "title": {"type": "string"},
                        "notes": {"type": "string"},
                        "due_date": {"type": "string"},
                        "status": {"type": "string", "enum": ["open", "done"]},
                        "priority": {"type": "string", "enum": ["low", "medium", "high"]},
                        "assignee_name": {"type": "string"},
                    },
                },
            },
            {
                "name": "delete_task",
                "description": "Удалить задачу. Требует явного подтверждения confirm=true.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "task_id": {"type": "integer"},
                        "confirm": {"type": "boolean"},
                    },
                    "required": ["task_id", "confirm"],
                },
            },
            {
                "name": "list_payments",
                "description": "Список платежей и финансовая сводка.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "date_scope": {"type": "string", "enum": ["today", "week", "month", "all"]},
                        "project_query": {"type": "string"},
                        "payment_type": {"type": "string", "enum": ["advance", "additional", "refund", "correction"]},
                        "limit": {"type": "integer"},
                    },
                },
            },
            {
                "name": "create_payment",
                "description": "Добавить платёж по проекту.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project_id": {"type": "integer"},
                        "project_query": {"type": "string"},
                        "amount": {"type": "number"},
                        "payment_type": {"type": "string", "enum": ["advance", "additional", "refund", "correction"]},
                        "payment_method": {"type": "string", "enum": ["transfer", "cash", "card", "other"]},
                        "comment": {"type": "string"},
                        "paid_at": {"type": "string", "description": "Дата или дата-время платежа в ISO-формате."},
                    },
                    "required": ["amount"],
                },
            },
            {
                "name": "create_financial_operation",
                "description": "Добавить финансовую операцию по проекту. Алиас create_payment для голосовых команд.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project_id": {"type": "integer"},
                        "project_query": {"type": "string"},
                        "amount": {"type": "number"},
                        "payment_type": {"type": "string", "enum": ["advance", "additional", "refund", "correction"]},
                        "payment_method": {"type": "string", "enum": ["transfer", "cash", "card", "other"]},
                        "comment": {"type": "string"},
                        "paid_at": {"type": "string", "description": "Дата или дата-время платежа в ISO-формате."},
                    },
                    "required": ["amount"],
                },
            },
            {
                "name": "delete_payment",
                "description": "Удалить платёж. Требует confirm=true.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "payment_id": {"type": "integer"},
                        "confirm": {"type": "boolean"},
                    },
                    "required": ["payment_id", "confirm"],
                },
            },
            {
                "name": "list_project_comments",
                "description": "Посмотреть комментарии по одному проекту.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project_id": {"type": "integer"},
                        "project_query": {"type": "string"},
                        "limit": {"type": "integer"},
                    },
                },
            },
            {
                "name": "add_project_comment",
                "description": "Добавить комментарий в карточку проекта.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project_id": {"type": "integer"},
                        "project_query": {"type": "string"},
                        "text": {"type": "string"},
                    },
                    "required": ["text"],
                },
            },
            {
                "name": "list_project_statuses",
                "description": "Список статусов канбана и количество проектов в них.",
                "parameters": {"type": "object", "properties": {}},
            },
            {
                "name": "create_project_status",
                "description": "Создать новый статус канбана. Доступно только администратору.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "short_name": {"type": "string"},
                        "color": {"type": "string", "enum": ["sky", "emerald", "rose", "amber", "violet", "slate"]},
                        "is_default": {"type": "boolean"},
                    },
                    "required": ["name"],
                },
            },
            {
                "name": "update_project_status",
                "description": "Изменить статус канбана. Доступно только администратору.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "status_id": {"type": "integer"},
                        "status_name": {"type": "string"},
                        "name": {"type": "string"},
                        "short_name": {"type": "string"},
                        "color": {"type": "string", "enum": ["sky", "emerald", "rose", "amber", "violet", "slate"]},
                        "is_default": {"type": "boolean"},
                    },
                },
            },
            {
                "name": "delete_project_status",
                "description": "Удалить статус канбана. Требует confirm=true и доступно только администратору.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "status_id": {"type": "integer"},
                        "confirm": {"type": "boolean"},
                    },
                    "required": ["status_id", "confirm"],
                },
            },
            {
                "name": "list_users",
                "description": "Список сотрудников CRM. Администратор видит всех, менеджер только себя.",
                "parameters": {"type": "object", "properties": {}},
            },
            {
                "name": "create_user",
                "description": "Создать пользователя CRM. Доступно только администратору.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "username": {"type": "string"},
                        "password": {"type": "string"},
                        "role": {"type": "string", "enum": ["admin", "manager"]},
                        "first_name": {"type": "string"},
                        "last_name": {"type": "string"},
                        "email": {"type": "string"},
                    },
                    "required": ["username", "password"],
                },
            },
            {
                "name": "update_user",
                "description": "Изменить пользователя CRM. Доступно только администратору.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "user_id": {"type": "integer"},
                        "username": {"type": "string"},
                        "password": {"type": "string"},
                        "role": {"type": "string", "enum": ["admin", "manager"]},
                        "first_name": {"type": "string"},
                        "last_name": {"type": "string"},
                        "email": {"type": "string"},
                        "is_active": {"type": "boolean"},
                    },
                    "required": ["user_id"],
                },
            },
        ]

    def _execute_tool(self, tool_name, arguments):
        handlers = {
            "get_crm_overview": self._tool_get_crm_overview,
            "list_projects": self._tool_list_projects,
            "list_stuck_projects": self._tool_list_stuck_projects,
            "list_clients": self._tool_list_clients,
            "create_client": self._tool_create_client,
            "get_project_details": self._tool_get_project_details,
            "create_project": self._tool_create_project,
            "update_project": self._tool_update_project,
            "delete_project": self._tool_delete_project,
            "list_tasks": self._tool_list_tasks,
            "create_task": self._tool_create_task,
            "create_project_tasks_from_analysis": self._tool_create_project_tasks_from_analysis,
            "update_task": self._tool_update_task,
            "delete_task": self._tool_delete_task,
            "list_payments": self._tool_list_payments,
            "create_payment": self._tool_create_payment,
            "create_financial_operation": self._tool_create_payment,
            "delete_payment": self._tool_delete_payment,
            "list_project_comments": self._tool_list_project_comments,
            "add_project_comment": self._tool_add_project_comment,
            "list_project_statuses": self._tool_list_project_statuses,
            "create_project_status": self._tool_create_project_status,
            "update_project_status": self._tool_update_project_status,
            "delete_project_status": self._tool_delete_project_status,
            "list_users": self._tool_list_users,
            "create_user": self._tool_create_user,
            "update_user": self._tool_update_user,
        }

        handler = handlers.get(tool_name)
        if not handler:
            return {
                "ok": False,
                "needs_clarification": True,
                "summary": f"Неизвестный инструмент: {tool_name}.",
            }

        try:
            result = handler(arguments or {})
            if result.get("ok") and self._is_mutating_tool(tool_name):
                self._invalidate_memory_snapshots()
            return result
        except Exception as exc:  # pragma: no cover - safety net
            return {
                "ok": False,
                "needs_clarification": True,
                "summary": f"Ошибка выполнения {tool_name}: {exc}",
            }

    @staticmethod
    def _is_mutating_tool(tool_name):
        return tool_name.startswith(("create_", "update_", "delete_", "add_"))

    @staticmethod
    def _invalidate_memory_snapshots():
        CRMMemorySnapshot.objects.all().delete()

    def _memory_ttl_seconds(self):
        raw_ttl = parse_int(os.getenv("CRM_AI_MEMORY_TTL_SECONDS"))
        if raw_ttl is None:
            raw_ttl = 300
        return max(30, min(raw_ttl, 3600))

    def _memory_limit(self, env_name, default, maximum):
        raw_limit = parse_int(os.getenv(env_name))
        if raw_limit is None:
            raw_limit = default
        return max(1, min(raw_limit, maximum))

    def _get_memory_snapshot(self):
        if not self.user or not self.user.is_authenticated:
            return None

        ttl_seconds = self._memory_ttl_seconds()
        now = timezone.now()
        snapshot = CRMMemorySnapshot.objects.filter(owner=self.user).first()

        snapshot_schema = (snapshot.payload or {}).get("schema_version") if snapshot else None
        if (
            snapshot
            and snapshot_schema == CRM_MEMORY_SCHEMA_VERSION
            and snapshot.refreshed_at >= now - timedelta(seconds=ttl_seconds)
        ):
            return snapshot

        payload, summary_text = self._build_memory_snapshot(ttl_seconds=ttl_seconds, refreshed_at=now)
        snapshot, _ = CRMMemorySnapshot.objects.update_or_create(
            owner=self.user,
            defaults={
                "payload": payload,
                "summary_text": summary_text,
                "refreshed_at": now,
            },
        )
        return snapshot

    def _build_memory_snapshot(self, ttl_seconds, refreshed_at):
        project_limit = self._memory_limit("CRM_AI_MEMORY_PROJECT_LIMIT", default=60, maximum=150)
        task_limit = self._memory_limit("CRM_AI_MEMORY_TASK_LIMIT", default=25, maximum=80)
        payment_limit = self._memory_limit("CRM_AI_MEMORY_PAYMENT_LIMIT", default=15, maximum=50)

        today = timezone.localdate()
        month_start = today.replace(day=1)
        status_rows = self._status_rows()
        status_map = {status.code: status.name for status in status_rows}

        projects = list(self._visible_projects()[:project_limit])
        all_project_count = self._visible_projects().count()
        payments = list(self._visible_payments())
        tasks = list(self._visible_tasks()[:task_limit])
        recent_payments = payments[:payment_limit]
        accounts = list(Account.objects.all().order_by("name", "id"))
        finance_categories = list(FinanceCategory.objects.all().order_by("type", "name", "id"))

        paid_by_project = {}
        payment_count_by_project = {}
        month_total = Decimal("0")

        for payment in payments:
            paid_by_project[payment.project_id] = paid_by_project.get(payment.project_id, Decimal("0")) + payment.amount
            payment_count_by_project[payment.project_id] = payment_count_by_project.get(payment.project_id, 0) + 1
            if payment.paid_at and payment.paid_at.date() >= month_start:
                month_total += payment.amount

        latest_comments = {}
        for comment in self._visible_comments()[:300]:
            if comment.project_id not in latest_comments:
                latest_comments[comment.project_id] = comment
            if len(latest_comments) >= len(projects):
                break

        projects_by_status = {}
        for status_code in self._visible_projects().values_list("status", flat=True):
            status_name = status_map.get(status_code, status_code)
            projects_by_status[status_name] = projects_by_status.get(status_name, 0) + 1

        project_rows = []
        stuck_project_rows = []
        clients_by_key = {}

        for project in projects:
            latest_comment = latest_comments.get(project.id)
            status_obj = next((status for status in status_rows if status.code == project.status), None)
            age_days = self._project_age_days(project)
            stuck_after_days = self._project_stuck_after_days(project, status_obj)
            row = {
                "project_id": project.id,
                "client_name": project.client_name,
                "status": status_map.get(project.status, project.status),
                "status_code": project.status,
                "manager": project.manager.get_full_name() or project.manager.username,
                "phone": project.client_phone or "",
                "address": project.object_address or "",
                "total_amount": str(project.total_amount or ""),
                "paid_total": str(paid_by_project.get(project.id, Decimal("0"))),
                "payments_count": payment_count_by_project.get(project.id, 0),
                "works_with_contract": project.works_with_contract,
                "latest_comment": truncate_text(latest_comment.text, 120) if latest_comment else "",
                "updated_at": project.updated_at.isoformat() if project.updated_at else "",
                "age_days": age_days,
                "stuck_after_days": stuck_after_days,
                "is_stuck": self._is_project_stuck(project, status_obj),
            }
            project_rows.append(row)

            if row["is_stuck"]:
                stuck_project_rows.append(row)

            client_key = normalize_text(project.client_phone or project.client_email or project.client_name)
            if client_key and client_key not in clients_by_key:
                clients_by_key[client_key] = {
                    "client_name": project.client_name,
                    "phone": project.client_phone or "",
                    "email": project.client_email or "",
                    "address": project.object_address or "",
                    "works_with_contract": project.works_with_contract,
                    "project_count": 0,
                    "total_amount": Decimal("0"),
                    "paid_total": Decimal("0"),
                }
            if client_key:
                clients_by_key[client_key]["project_count"] += 1
                clients_by_key[client_key]["total_amount"] += Decimal(project.total_amount or 0)
                clients_by_key[client_key]["paid_total"] += paid_by_project.get(project.id, Decimal("0"))

        task_rows = []
        for task in tasks:
            task_rows.append(
                {
                    "task_id": task.id,
                    "title": task.title,
                    "status": task.status,
                    "priority": task.priority,
                    "due_date": task.due_date.isoformat() if task.due_date else "",
                    "assignee": task.assignee.get_full_name() or task.assignee.username,
                }
            )

        payment_rows = []
        for payment in recent_payments:
            payment_rows.append(
                {
                    "payment_id": payment.id,
                    "project_id": payment.project_id,
                    "project": payment.project.client_name,
                    "amount": str(payment.amount),
                    "type": payment.type,
                    "method": payment.method,
                    "paid_at": payment.paid_at.isoformat() if payment.paid_at else "",
                    "comment": truncate_text(payment.comment, 100),
                }
            )

        payload = {
            "schema_version": CRM_MEMORY_SCHEMA_VERSION,
            "refreshed_at": refreshed_at.isoformat(),
            "ttl_seconds": ttl_seconds,
            "visibility": "all" if self.user.is_admin() else "own",
            "project_count": all_project_count,
            "projects_by_status": projects_by_status,
            "stuck_projects": stuck_project_rows[:20],
            "month_payment_total": str(month_total),
            "projects": project_rows,
            "clients": [
                {
                    **client,
                    "total_amount": str(client["total_amount"]),
                    "paid_total": str(client["paid_total"]),
                }
                for client in list(clients_by_key.values())[:50]
            ],
            "open_tasks": task_rows,
            "recent_payments": payment_rows,
            "finance_categories": [{"name": category.name, "type": category.type} for category in finance_categories],
            "accounts": [{"name": account.name} for account in accounts],
        }

        summary_lines = [
            f"Обновлено: {timezone.localtime(refreshed_at).strftime('%d.%m.%Y %H:%M:%S')}. TTL: {ttl_seconds} секунд.",
            f"Видимость: {'вся CRM' if self.user.is_admin() else 'только данные текущего менеджера'}.",
            f"Проекты всего: {all_project_count}. По статусам: {', '.join(f'{name}: {count}' for name, count in projects_by_status.items()) or 'нет данных'}.",
            f"Зависших проектов: {len(stuck_project_rows)}.",
            f"Платежи за текущий месяц: {format_money(month_total)} ₽.",
        ]

        if accounts:
            summary_lines.append("Счета: " + ", ".join(account.name for account in accounts[:10]) + ".")
        if finance_categories:
            summary_lines.append(
                "Категории финансов: "
                + ", ".join(f"{category.name} ({'доход' if category.type == FinanceCategory.Type.INCOME else 'расход'})" for category in finance_categories[:20])
                + "."
            )

        if project_rows:
            summary_lines.append("Проекты:")
            for project in project_rows:
                parts = [
                    f"#{project['project_id']} {project['client_name']}",
                    f"статус: {project['status']}",
                ]
                if project["total_amount"]:
                    parts.append(f"сумма: {format_money(project['total_amount'])} ₽")
                if Decimal(project["paid_total"] or "0"):
                    parts.append(f"оплачено: {format_money(project['paid_total'])} ₽")
                if project["address"]:
                    parts.append(f"адрес: {truncate_text(project['address'], 70)}")
                if project["latest_comment"]:
                    parts.append(f"комментарий: {project['latest_comment']}")
                summary_lines.append("- " + " | ".join(parts))
        else:
            summary_lines.append("Проектов пока нет.")

        if stuck_project_rows:
            summary_lines.append("Зависшие проекты:")
            for project in stuck_project_rows[:12]:
                summary_lines.append(
                    f"- #{project['project_id']} {project['client_name']} | {project['status']} | без изменений {project['age_days']} дн. | лимит {project['stuck_after_days']} дн."
                )

        client_rows = payload["clients"]
        if client_rows:
            summary_lines.append("Клиенты:")
            for client in client_rows[:15]:
                summary_lines.append(
                    f"- {client['client_name']} | проектов: {client['project_count']} | телефон: {client['phone'] or 'не указан'} | адрес: {truncate_text(client['address'], 60) or 'не указан'}"
                )

        if task_rows:
            summary_lines.append("Ближайшие задачи:")
            for task in task_rows[:15]:
                due_date = task["due_date"] or "без срока"
                summary_lines.append(f"- #{task['task_id']} {task['title']} | {due_date} | {task['assignee']} | {task['status']}")

        if payment_rows:
            summary_lines.append("Последние платежи:")
            for payment in payment_rows[:10]:
                summary_lines.append(
                    f"- #{payment['payment_id']} {payment['project']} | {format_money(payment['amount'])} ₽ | {payment['type']} | {payment['paid_at'][:10]}"
                )

        return payload, "\n".join(summary_lines)

    def _status_rows(self):
        return list(ProjectStatus.objects.all().order_by("sort_order", "id"))

    def _visible_projects(self):
        queryset = Project.objects.select_related("manager").all().order_by("-created_at")
        if self.user.is_admin():
            return queryset
        return queryset.filter(manager=self.user)

    def _visible_payments(self):
        queryset = Payment.objects.select_related("project", "created_by").all().order_by("-paid_at", "-id")
        if self.user.is_admin():
            return queryset
        return queryset.filter(project__manager=self.user)

    def _visible_tasks(self):
        queryset = Task.objects.select_related("assignee", "created_by").all().order_by("status", "due_date", "-created_at")
        if self.user.is_admin():
            return queryset
        return queryset.filter(assignee=self.user)

    def _visible_comments(self):
        queryset = ProjectComment.objects.select_related("project", "author").all().order_by("-created_at")
        if self.user.is_admin():
            return queryset
        return queryset.filter(project__manager=self.user)

    def _visible_users(self):
        if self.user.is_admin():
            return list(User.objects.filter(is_active=True).order_by("first_name", "last_name", "username"))
        return [self.user]

    def _serialize_project(self, project, include_payments=False, include_comments=False):
        payload = {
            "project_id": project.id,
            "client_name": project.client_name,
            "client_phone": project.client_phone,
            "client_email": project.client_email or "",
            "object_address": project.object_address or "",
            "description": truncate_text(project.description, 400),
            "status_code": project.status,
            "status_name": self._status_name(project.status),
            "manager_name": project.manager.get_full_name() or project.manager.username,
            "total_amount": str(project.total_amount) if project.total_amount is not None else "",
            "categories": project.categories or "",
            "created_at": project.created_at.isoformat(),
            "updated_at": project.updated_at.isoformat(),
        }

        if include_payments:
            payments = list(Payment.objects.filter(project=project).order_by("-paid_at", "-id"))
            payload["payment_count"] = len(payments)
            payload["paid_total"] = str(sum(payment.amount for payment in payments))
            payload["latest_payment"] = self._serialize_payment(payments[0]) if payments else None

        if include_comments:
            comments = list(ProjectComment.objects.filter(project=project).select_related("author").order_by("-created_at")[:5])
            payload["latest_comment"] = comments[0].text if comments else ""
            payload["comments"] = [self._serialize_comment(comment) for comment in comments]

        return payload

    def _serialize_task(self, task):
        return {
            "task_id": task.id,
            "title": task.title,
            "notes": truncate_text(task.notes, 300),
            "due_date": task.due_date.isoformat() if task.due_date else "",
            "status": task.status,
            "priority": task.priority,
            "assignee_name": task.assignee.get_full_name() or task.assignee.username,
            "created_by_name": task.created_by.get_full_name() or task.created_by.username,
            "created_at": task.created_at.isoformat(),
            "updated_at": task.updated_at.isoformat(),
        }

    def _serialize_payment(self, payment):
        return {
            "payment_id": payment.id,
            "project_id": payment.project_id,
            "project_name": payment.project.client_name,
            "amount": str(payment.amount),
            "type": payment.type,
            "method": payment.method,
            "comment": payment.comment or "",
            "paid_at": payment.paid_at.isoformat() if payment.paid_at else "",
            "created_by_name": payment.created_by.get_full_name() or payment.created_by.username,
        }

    def _serialize_comment(self, comment):
        return {
            "comment_id": comment.id,
            "project_id": comment.project_id,
            "author_name": comment.author.get_full_name() or comment.author.username,
            "text": truncate_text(comment.text, 500),
            "created_at": comment.created_at.isoformat(),
        }

    def _serialize_status(self, status):
        return {
            "status_id": status.id,
            "code": status.code,
            "name": status.name,
            "short_name": status.short_name,
            "color": status.color,
            "sort_order": status.sort_order,
            "is_default": status.is_default,
            "project_count": Project.objects.filter(status=status.code).count(),
        }

    def _project_age_days(self, project):
        source = project.updated_at or project.created_at
        if not source:
            return 0
        return max(0, (timezone.now() - source).days)

    def _project_stuck_after_days(self, _project, status=None):
        return int(getattr(status, "stuck_after_days", None) or 5)

    def _is_terminal_status(self, status_code, status=None):
        text = normalize_text(" ".join([
            status_code or "",
            getattr(status, "name", "") or "",
            getattr(status, "short_name", "") or "",
        ]))
        terminal_markers = ["closed", "canceled", "cancelled", "done", "заверш", "отмен", "закры", "готов"]
        terminal_markers.extend(
            [
                "complete",
                "completed",
                "\u0437\u0430\u0432\u0435\u0440\u0448",
                "\u043e\u0442\u043c\u0435\u043d",
                "\u0437\u0430\u043a\u0440\u044b",
                "\u0433\u043e\u0442\u043e\u0432",
            ]
        )
        return any(marker in text for marker in terminal_markers)

    def _is_project_stuck(self, project, status=None):
        if self._is_terminal_status(project.status, status):
            return False
        return self._project_age_days(project) >= self._project_stuck_after_days(project, status)

    def _stuck_project_rows(self, limit=20):
        statuses = {status.code: status for status in self._status_rows()}
        rows = []
        for project in self._visible_projects():
            status = statuses.get(project.status)
            if self._is_project_stuck(project, status):
                rows.append(
                    {
                        "project": project,
                        "status": status,
                        "age_days": self._project_age_days(project),
                        "stuck_after_days": self._project_stuck_after_days(project, status),
                    }
                )

        rows.sort(key=lambda row: row["age_days"], reverse=True)
        return rows[:limit]

    def _serialize_user(self, user):
        return {
            "user_id": user.id,
            "username": user.username,
            "full_name": user.get_full_name() or user.username,
            "role": user.role,
            "email": user.email or "",
            "is_active": user.is_active,
            "is_admin": user.is_admin(),
        }

    def _status_name(self, status_code):
        status = ProjectStatus.objects.filter(code=status_code).first()
        return status.name if status else status_code

    def _match_status(self, identifier):
        if not identifier:
            return None

        wanted = normalize_text(identifier)
        statuses = self._status_rows()

        for status in statuses:
            if wanted in {
                normalize_text(status.name),
                normalize_text(status.short_name),
                normalize_text(status.code),
                str(status.id),
            }:
                return status

        for status in statuses:
            haystack = " ".join([status.name, status.short_name, status.code])
            if wanted and wanted in normalize_text(haystack):
                return status

        return None

    def _match_user(self, identifier):
        if not identifier:
            return None

        wanted = normalize_text(identifier)
        for person in self._visible_users():
            names = {
                normalize_text(person.username),
                normalize_text(person.get_full_name()),
                normalize_text(" ".join(filter(None, [person.first_name, person.last_name, person.username]))),
                str(person.id),
            }
            if wanted in names:
                return person

        for person in self._visible_users():
            haystack = normalize_text(" ".join(filter(None, [person.first_name, person.last_name, person.username])))
            if wanted and wanted in haystack:
                return person

        return None

    def _find_projects(self, query):
        if not query:
            return []

        wanted = normalize_text(query)
        matches = []
        for project in self._visible_projects():
            haystack = normalize_text(
                " ".join(
                    [
                        str(project.id),
                        project.client_name or "",
                        project.client_phone or "",
                        project.client_email or "",
                        project.object_address or "",
                        project.description or "",
                        self._status_name(project.status) or "",
                        project.status or "",
                    ]
                )
            )
            if wanted and wanted in haystack:
                matches.append(project)
        return matches

    def _find_tasks(self, query):
        if not query:
            return []

        wanted = normalize_text(query)
        matches = []
        for task in self._visible_tasks():
            haystack = normalize_text(
                " ".join(
                    [
                        str(task.id),
                        task.title or "",
                        task.notes or "",
                        task.assignee.get_full_name() or "",
                        task.assignee.username,
                    ]
                )
            )
            if wanted and wanted in haystack:
                matches.append(task)
        return matches

    def _resolve_single_project(self, project_id=None, project_query=None):
        if project_id:
            project = self._visible_projects().filter(id=project_id).first()
            if project:
                return project, None
            return None, self._clarification("Не нашёл проект с таким ID.", [])

        matches = self._find_projects(project_query)
        if not matches:
            return None, self._clarification("Не нашёл подходящий проект. Уточните клиента, адрес или телефон.", [])
        if len(matches) > 1:
            return None, self._clarification(
                "Нашёл несколько похожих проектов. Уточните, какой именно нужен.",
                [f"{project.id}: {project.client_name}" for project in matches[:6]],
            )
        return matches[0], None

    def _resolve_single_task(self, task_id=None, task_query=None):
        if task_id:
            task = self._visible_tasks().filter(id=task_id).first()
            if task:
                return task, None
            return None, self._clarification("Не нашёл задачу с таким ID.", [])

        matches = self._find_tasks(task_query)
        if not matches:
            return None, self._clarification("Не нашёл подходящую задачу. Уточните её название.", [])
        if len(matches) > 1:
            return None, self._clarification(
                "Нашёл несколько похожих задач. Уточните, какую именно нужно изменить.",
                [f"{task.id}: {task.title}" for task in matches[:6]],
            )
        return matches[0], None

    def _resolve_single_status(self, status_id=None, status_name=None):
        status = None
        if status_id:
            status = ProjectStatus.objects.filter(id=status_id).first()
        elif status_name:
            status = self._match_status(status_name)

        if status:
            return status, None

        return None, self._clarification("Не нашёл статус канбана. Уточните его название.", [])

    def _resolve_single_payment(self, payment_id=None):
        if not payment_id:
            return None, self._clarification("Нужен ID платежа.", [])

        payment = self._visible_payments().filter(id=payment_id).first()
        if payment:
            return payment, None

        return None, self._clarification("Не нашёл платёж с таким ID.", [])

    def _clarification(self, message, options):
        return {
            "ok": False,
            "needs_clarification": True,
            "summary": message,
            "options": options,
        }

    def _require_admin(self):
        if self.user.is_admin():
            return None
        return {
            "ok": False,
            "needs_clarification": True,
            "summary": "Это действие доступно только администратору CRM.",
        }

    def _tool_get_crm_overview(self, _arguments):
        projects = list(self._visible_projects())
        payments = list(self._visible_payments())
        tasks = list(self._visible_tasks())
        today = timezone.localdate()
        tomorrow = today + timedelta(days=1)
        month_start = today.replace(day=1)

        projects_by_status = {}
        for project in projects:
            status_name = self._status_name(project.status)
            projects_by_status[status_name] = projects_by_status.get(status_name, 0) + 1

        open_tasks_today = sum(1 for task in tasks if task.status == Task.Status.OPEN and task.due_date and task.due_date <= today)
        open_tasks_tomorrow = sum(1 for task in tasks if task.status == Task.Status.OPEN and task.due_date == tomorrow)
        month_total = sum(
            payment.amount
            for payment in payments
            if payment.paid_at and payment.paid_at.date() >= month_start
        )

        return {
            "ok": True,
            "needs_clarification": False,
            "summary": (
                f"В зоне видимости {len(projects)} проектов, {len(payments)} платежей и {len(tasks)} задач. "
                f"Сумма платежей за текущий месяц: {format_money(month_total)} ₽."
            ),
            "overview": {
                "project_count": len(projects),
                "payment_count": len(payments),
                "task_count": len(tasks),
                "open_tasks_today": open_tasks_today,
                "open_tasks_tomorrow": open_tasks_tomorrow,
                "month_payment_total": str(month_total),
                "projects_by_status": projects_by_status,
            },
        }

    def _tool_list_projects(self, arguments):
        projects = list(self._visible_projects())
        status = self._match_status(arguments.get("status_name"))
        project_query = arguments.get("project_query")
        include_payments = bool(arguments.get("include_payments", True))
        include_comments = bool(arguments.get("include_comments", True))
        limit = clamp_limit(arguments.get("limit"), default=10, maximum=20)

        if arguments.get("status_name") and not status:
            return self._clarification("Не нашёл такой статус проекта. Уточните его название.", [])

        if status:
            projects = [project for project in projects if project.status == status.code]

        if project_query:
            wanted_ids = {project.id for project in self._find_projects(project_query)}
            projects = [project for project in projects if project.id in wanted_ids]

        serialized = [
            self._serialize_project(project, include_payments=include_payments, include_comments=include_comments)
            for project in projects[:limit]
        ]

        summary = f"Нашёл {len(projects)} проектов"
        if status:
            summary += f" в статусе «{status.name}»"
        if project_query:
            summary += f" по запросу «{project_query}»"
        summary += "."

        return {
            "ok": True,
            "needs_clarification": False,
            "summary": summary,
            "count": len(projects),
            "projects": serialized,
        }

    def _tool_list_stuck_projects(self, arguments):
        limit = clamp_limit(arguments.get("limit"), default=10, maximum=20)
        rows = self._stuck_project_rows(limit=limit)
        projects = []
        for row in rows:
            project = row["project"]
            serialized = self._serialize_project(project, include_payments=True, include_comments=True)
            serialized["age_days"] = row["age_days"]
            serialized["stuck_after_days"] = row["stuck_after_days"]
            serialized["stuck_reason"] = (
                f"Без изменений {row['age_days']} дн.; лимит этапа {row['stuck_after_days']} дн."
            )
            projects.append(serialized)

        return {
            "ok": True,
            "needs_clarification": False,
            "summary": f"Нашёл {len(projects)} зависших проектов.",
            "count": len(projects),
            "projects": projects,
        }

    def _tool_list_clients(self, arguments):
        client_query = normalize_text(arguments.get("client_query"))
        limit = clamp_limit(arguments.get("limit"), default=15, maximum=25)
        clients = {}

        payments_by_project = {}
        for payment in self._visible_payments():
            payments_by_project[payment.project_id] = payments_by_project.get(payment.project_id, Decimal("0")) + payment.amount

        for project in self._visible_projects():
            key = normalize_text(project.client_phone or project.client_email or project.client_name)
            if not key:
                continue

            haystack = normalize_text(
                " ".join(
                    [
                        project.client_name or "",
                        project.client_phone or "",
                        project.client_email or "",
                        project.object_address or "",
                    ]
                )
            )
            if client_query and client_query not in haystack:
                continue

            if key not in clients:
                clients[key] = {
                    "client_name": project.client_name,
                    "phone": project.client_phone or "",
                    "email": project.client_email or "",
                    "address": project.object_address or "",
                    "works_with_contract": project.works_with_contract,
                    "project_count": 0,
                    "total_amount": Decimal("0"),
                    "paid_total": Decimal("0"),
                }

            clients[key]["project_count"] += 1
            clients[key]["total_amount"] += Decimal(project.total_amount or 0)
            clients[key]["paid_total"] += payments_by_project.get(project.id, Decimal("0"))

        rows = []
        for client in list(clients.values())[:limit]:
            rows.append(
                {
                    **client,
                    "total_amount": str(client["total_amount"]),
                    "paid_total": str(client["paid_total"]),
                }
            )

        return {
            "ok": True,
            "needs_clarification": False,
            "summary": f"Нашёл {len(rows)} клиентов.",
            "count": len(rows),
            "clients": rows,
        }

    def _tool_get_project_details(self, arguments):
        project, clarification = self._resolve_single_project(
            project_id=parse_int(arguments.get("project_id")),
            project_query=arguments.get("project_query"),
        )
        if clarification:
            return clarification

        payments = list(Payment.objects.filter(project=project).select_related("created_by").order_by("-paid_at", "-id")[:10])
        comments = list(ProjectComment.objects.filter(project=project).select_related("author").order_by("-created_at")[:10])

        return {
            "ok": True,
            "needs_clarification": False,
            "summary": f"Открыл карточку проекта «{project.client_name}».",
            "project": self._serialize_project(project, include_payments=True, include_comments=True),
            "payments": [self._serialize_payment(payment) for payment in payments],
            "comments": [self._serialize_comment(comment) for comment in comments],
        }

    def _tool_create_project(self, arguments):
        client_name = str(arguments.get("client_name") or "").strip()
        if not client_name:
            return self._clarification("Чтобы создать проект, мне нужно имя клиента или название проекта.", [])

        manager = self.user
        if self.user.is_admin() and arguments.get("manager_name"):
            matched_user = self._match_user(arguments.get("manager_name"))
            if not matched_user:
                return self._clarification("Не нашёл такого менеджера для проекта.", [])
            manager = matched_user

        matched_status = self._match_status(arguments.get("status_name"))
        if arguments.get("status_name") and not matched_status:
            return self._clarification("Не нашёл такой статус проекта. Уточните его название.", [])

        default_status = ProjectStatus.objects.filter(is_default=True).first() or ProjectStatus.objects.first()
        status_code = matched_status.code if matched_status else (default_status.code if default_status else "active")

        total_amount = parse_decimal(arguments.get("total_amount"))
        if arguments.get("total_amount") not in (None, "") and total_amount is None:
            return self._clarification("Не смог разобрать сумму проекта. Укажите её числом.", [])

        project = Project.objects.create(
            manager=manager,
            client_name=client_name,
            client_phone=str(arguments.get("client_phone") or "").strip(),
            client_email=str(arguments.get("client_email") or "").strip() or None,
            object_address=str(arguments.get("object_address") or "").strip() or None,
            description=str(arguments.get("description") or "").strip(),
            total_amount=total_amount,
            status=status_code,
            categories=str(arguments.get("categories") or "").strip(),
            works_with_contract=is_truthy(arguments.get("works_with_contract")),
        )

        return {
            "ok": True,
            "needs_clarification": False,
            "summary": f"Создан проект «{project.client_name}» со статусом «{self._status_name(project.status)}».",
            "project": self._serialize_project(project, include_payments=True, include_comments=True),
        }

    def _tool_create_client(self, arguments):
        client_name = str(arguments.get("client_name") or "").strip()
        if not client_name:
            return self._clarification("Чтобы создать клиента, мне нужно имя или название клиента.", [])

        default_status = ProjectStatus.objects.filter(is_default=True).first() or ProjectStatus.objects.first()
        project = Project.objects.create(
            manager=self.user,
            client_name=client_name,
            client_phone=str(arguments.get("client_phone") or "").strip(),
            client_email=str(arguments.get("client_email") or "").strip() or None,
            object_address=str(arguments.get("object_address") or "").strip() or None,
            works_with_contract=is_truthy(arguments.get("works_with_contract")),
            description=str(arguments.get("comment") or "Клиентская карточка создана AI-помощником.").strip(),
            total_amount=None,
            status=default_status.code if default_status else "active",
            categories="",
        )

        return {
            "ok": True,
            "needs_clarification": False,
            "summary": f"Клиент «{project.client_name}» создан.",
            "client": {
                "client_name": project.client_name,
                "phone": project.client_phone or "",
                "email": project.client_email or "",
                "address": project.object_address or "",
                "works_with_contract": project.works_with_contract,
                "project_id": project.id,
            },
        }

    def _tool_update_project(self, arguments):
        project, clarification = self._resolve_single_project(
            project_id=parse_int(arguments.get("project_id")),
            project_query=arguments.get("project_query"),
        )
        if clarification:
            return clarification

        updates = {}
        text_fields = [
            "client_name",
            "client_phone",
            "client_email",
            "object_address",
            "description",
            "categories",
        ]
        for field in text_fields:
            if field in arguments:
                value = str(arguments.get(field) or "").strip()
                if field in {"client_email", "object_address"}:
                    updates[field] = value or None
                else:
                    updates[field] = value

        if "total_amount" in arguments:
            total_amount = parse_decimal(arguments.get("total_amount"))
            if arguments.get("total_amount") not in (None, "") and total_amount is None:
                return self._clarification("Не смог разобрать сумму проекта. Укажите её числом.", [])
            updates["total_amount"] = total_amount

        if "works_with_contract" in arguments:
            updates["works_with_contract"] = is_truthy(arguments.get("works_with_contract"))

        if "status_name" in arguments:
            matched_status = self._match_status(arguments.get("status_name"))
            if not matched_status:
                return self._clarification("Не нашёл такой статус проекта. Уточните его название.", [])
            updates["status"] = matched_status.code

        if self.user.is_admin() and "manager_name" in arguments:
            matched_user = self._match_user(arguments.get("manager_name"))
            if not matched_user:
                return self._clarification("Не нашёл такого менеджера.", [])
            updates["manager"] = matched_user

        if not updates:
            return self._clarification("Не увидел, что именно нужно изменить в проекте.", [])

        for field, value in updates.items():
            setattr(project, field, value)
        project.save()

        return {
            "ok": True,
            "needs_clarification": False,
            "summary": f"Обновил проект «{project.client_name}».",
            "project": self._serialize_project(project, include_payments=True, include_comments=True),
        }

    def _tool_delete_project(self, arguments):
        project_id = parse_int(arguments.get("project_id"))
        if not project_id:
            return self._clarification("Для удаления проекта нужен его ID.", [])
        if not is_truthy(arguments.get("confirm")):
            return self._clarification("Подтвердите удаление проекта явно.", [])

        project, clarification = self._resolve_single_project(project_id=project_id)
        if clarification:
            return clarification

        project_name = project.client_name
        project.delete()
        return {
            "ok": True,
            "needs_clarification": False,
            "summary": f"Проект «{project_name}» удалён.",
        }

    def _filtered_tasks(self, date_scope, due_date, include_done, assignee_name):
        tasks = list(self._visible_tasks())
        if not include_done:
            tasks = [task for task in tasks if task.status != Task.Status.DONE]

        if assignee_name:
            assignee = self._match_user(assignee_name)
            if not assignee:
                return None, self._clarification("Не нашёл такого исполнителя задачи.", [])
            tasks = [task for task in tasks if task.assignee_id == assignee.id]

        today = timezone.localdate()
        tomorrow = today + timedelta(days=1)
        week_end = today + timedelta(days=7)
        month_end = today + timedelta(days=30)
        specific = parse_iso_date(due_date)
        if due_date and not specific:
            return None, self._clarification("Не смог разобрать дату задачи. Нужен формат YYYY-MM-DD.", [])

        filtered = []
        for task in tasks:
            if date_scope == "today":
                if task.due_date and task.due_date <= today:
                    filtered.append(task)
            elif date_scope == "tomorrow":
                if task.due_date == tomorrow:
                    filtered.append(task)
            elif date_scope == "week":
                if task.due_date and today <= task.due_date <= week_end:
                    filtered.append(task)
            elif date_scope == "month":
                if task.due_date and today <= task.due_date <= month_end:
                    filtered.append(task)
            elif date_scope == "overdue":
                if task.due_date and task.due_date < today:
                    filtered.append(task)
            elif date_scope == "specific":
                if task.due_date and specific and task.due_date == specific:
                    filtered.append(task)
            else:
                filtered.append(task)

        return filtered, None

    def _tool_list_tasks(self, arguments):
        date_scope = arguments.get("date_scope") or "today"
        include_done = bool(arguments.get("include_done"))
        tasks, clarification = self._filtered_tasks(
            date_scope=date_scope,
            due_date=arguments.get("due_date"),
            include_done=include_done,
            assignee_name=arguments.get("assignee_name"),
        )
        if clarification:
            return clarification

        limit = clamp_limit(arguments.get("limit"), default=12, maximum=20)
        return {
            "ok": True,
            "needs_clarification": False,
            "summary": f"Нашёл {len(tasks)} задач по выбранному фильтру.",
            "count": len(tasks),
            "tasks": [self._serialize_task(task) for task in tasks[:limit]],
        }

    def _tool_create_task(self, arguments):
        title = str(arguments.get("title") or "").strip()
        if not title:
            return self._clarification("Чтобы создать задачу, мне нужно её название.", [])

        project = None
        if arguments.get("project_id") or arguments.get("project_query"):
            project, clarification = self._resolve_single_project(
                project_id=parse_int(arguments.get("project_id")),
                project_query=arguments.get("project_query"),
            )
            if clarification:
                return clarification

        assignee = self.user
        if arguments.get("assignee_name"):
            matched_user = self._match_user(arguments.get("assignee_name"))
            if not matched_user:
                return self._clarification("Не нашёл такого исполнителя задачи.", [])
            if not self.user.is_admin() and matched_user.id != self.user.id:
                return self._clarification("Менеджер может ставить задачи только себе.", [])
            assignee = matched_user

        due_date = parse_iso_date(arguments.get("due_date"))
        if arguments.get("due_date") and not due_date:
            return self._clarification("Не смог разобрать срок задачи. Нужен формат YYYY-MM-DD.", [])

        priority = arguments.get("priority") or Task.Priority.MEDIUM
        if priority not in Task.Priority.values:
            priority = Task.Priority.MEDIUM

        notes = str(arguments.get("notes") or "").strip()
        if project:
            project_note = f"Проект #{project.id}: {project.client_name}"
            if project.object_address:
                project_note += f" | адрес: {project.object_address}"
            notes = f"{project_note}\n{notes}".strip()

        task = Task.objects.create(
            title=title,
            notes=notes,
            due_date=due_date,
            priority=priority,
            assignee=assignee,
            created_by=self.user,
        )

        return {
            "ok": True,
            "needs_clarification": False,
            "summary": f"Создана задача «{task.title}».",
            "task": self._serialize_task(task),
        }

    def _default_project_task_plan(self, project):
        today = timezone.localdate()
        status_name = self._status_name(project.status)
        tasks = [
            {
                "title": f"Проверить следующий шаг по проекту «{project.client_name}»",
                "notes": f"Статус проекта: {status_name}. Уточнить, что блокирует переход на следующий этап.",
                "due_date": (today + timedelta(days=1)).isoformat(),
                "priority": Task.Priority.HIGH,
            },
            {
                "title": f"Обновить карточку проекта «{project.client_name}»",
                "notes": "Проверить адрес, сумму, контакты клиента, комментарии и актуальность финансов.",
                "due_date": (today + timedelta(days=2)).isoformat(),
                "priority": Task.Priority.MEDIUM,
            },
            {
                "title": f"Связаться с клиентом по проекту «{project.client_name}»",
                "notes": "Сообщить текущий статус и согласовать ближайшее действие.",
                "due_date": (today + timedelta(days=3)).isoformat(),
                "priority": Task.Priority.MEDIUM,
            },
        ]

        if project.total_amount:
            tasks.append(
                {
                    "title": f"Сверить оплату по проекту «{project.client_name}»",
                    "notes": f"Проверить оплаты относительно суммы проекта {format_money(project.total_amount)} ₽.",
                    "due_date": (today + timedelta(days=2)).isoformat(),
                    "priority": Task.Priority.MEDIUM,
                }
            )

        return tasks

    def _tool_create_project_tasks_from_analysis(self, arguments):
        project, clarification = self._resolve_single_project(
            project_id=parse_int(arguments.get("project_id")),
            project_query=arguments.get("project_query"),
        )
        if clarification:
            return clarification

        assignee = project.manager
        if arguments.get("assignee_name"):
            matched_user = self._match_user(arguments.get("assignee_name"))
            if not matched_user:
                return self._clarification("Не нашёл такого исполнителя задач.", [])
            assignee = matched_user

        if not self.user.is_admin() and assignee.id != self.user.id:
            return self._clarification("Менеджер может ставить задачи только себе.", [])

        requested_tasks = arguments.get("tasks")
        if not isinstance(requested_tasks, list) or not requested_tasks:
            requested_tasks = self._default_project_task_plan(project)

        created_tasks = []
        project_payload = self._serialize_project(project, include_payments=True, include_comments=True)
        project_note_header = [
            f"Проект #{project.id}: {project.client_name}",
            f"Статус: {self._status_name(project.status)}",
        ]
        if project.object_address:
            project_note_header.append(f"Адрес: {project.object_address}")
        if project.total_amount:
            project_note_header.append(f"Сумма: {format_money(project.total_amount)} ₽")

        for item in requested_tasks[:8]:
            if not isinstance(item, dict):
                continue

            title = str(item.get("title") or "").strip()
            if not title:
                continue

            due_date = parse_iso_date(item.get("due_date"))
            priority = item.get("priority") or Task.Priority.MEDIUM
            if priority not in Task.Priority.values:
                priority = Task.Priority.MEDIUM

            raw_notes = str(item.get("notes") or "").strip()
            notes = "\n".join([*project_note_header, raw_notes]).strip()
            created_tasks.append(
                Task.objects.create(
                    title=title[:200],
                    notes=notes,
                    due_date=due_date,
                    priority=priority,
                    assignee=assignee,
                    created_by=self.user,
                )
            )

        if not created_tasks:
            return self._clarification("Не получилось сформировать задачи по проекту. Уточните, какие задачи создать.", [])

        return {
            "ok": True,
            "needs_clarification": False,
            "summary": f"Создано {len(created_tasks)} задач по проекту «{project.client_name}».",
            "project": project_payload,
            "tasks": [self._serialize_task(task) for task in created_tasks],
        }

    def _tool_update_task(self, arguments):
        task, clarification = self._resolve_single_task(
            task_id=parse_int(arguments.get("task_id")),
            task_query=arguments.get("task_query"),
        )
        if clarification:
            return clarification

        updates = {}
        for field in ["title", "notes"]:
            if field in arguments:
                updates[field] = str(arguments.get(field) or "").strip()

        if "due_date" in arguments:
            due_date = parse_iso_date(arguments.get("due_date"))
            if arguments.get("due_date") not in (None, "") and not due_date:
                return self._clarification("Не смог разобрать срок задачи. Нужен формат YYYY-MM-DD.", [])
            updates["due_date"] = due_date

        if "status" in arguments:
            status_value = arguments.get("status")
            if status_value not in Task.Status.values:
                return self._clarification("Неизвестный статус задачи.", [])
            updates["status"] = status_value

        if "priority" in arguments:
            priority_value = arguments.get("priority")
            if priority_value not in Task.Priority.values:
                return self._clarification("Неизвестный приоритет задачи.", [])
            updates["priority"] = priority_value

        if "assignee_name" in arguments:
            assignee = self._match_user(arguments.get("assignee_name"))
            if not assignee:
                return self._clarification("Не нашёл такого исполнителя задачи.", [])
            if not self.user.is_admin() and assignee.id != self.user.id:
                return self._clarification("Менеджер может назначать задачи только себе.", [])
            updates["assignee"] = assignee

        if not updates:
            return self._clarification("Не увидел, что именно нужно изменить в задаче.", [])

        for field, value in updates.items():
            setattr(task, field, value)
        task.save()

        return {
            "ok": True,
            "needs_clarification": False,
            "summary": f"Задача «{task.title}» обновлена.",
            "task": self._serialize_task(task),
        }

    def _tool_delete_task(self, arguments):
        task_id = parse_int(arguments.get("task_id"))
        if not task_id:
            return self._clarification("Для удаления задачи нужен её ID.", [])
        if not is_truthy(arguments.get("confirm")):
            return self._clarification("Подтвердите удаление задачи явно.", [])

        task, clarification = self._resolve_single_task(task_id=task_id)
        if clarification:
            return clarification

        task_title = task.title
        task.delete()
        return {
            "ok": True,
            "needs_clarification": False,
            "summary": f"Задача «{task_title}» удалена.",
        }

    def _tool_list_payments(self, arguments):
        payments = list(self._visible_payments())
        date_scope = arguments.get("date_scope") or "month"
        project_query = arguments.get("project_query")
        payment_type = arguments.get("payment_type")
        limit = clamp_limit(arguments.get("limit"), default=12, maximum=25)
        today = timezone.localdate()

        if project_query:
            project, clarification = self._resolve_single_project(project_query=project_query)
            if clarification:
                return clarification
            payments = [payment for payment in payments if payment.project_id == project.id]

        if payment_type:
            payments = [payment for payment in payments if payment.type == payment_type]

        if date_scope == "today":
            payments = [payment for payment in payments if payment.paid_at and payment.paid_at.date() == today]
        elif date_scope == "week":
            week_end = today + timedelta(days=7)
            payments = [
                payment
                for payment in payments
                if payment.paid_at and today <= payment.paid_at.date() <= week_end
            ]
        elif date_scope == "month":
            month_start = today.replace(day=1)
            payments = [payment for payment in payments if payment.paid_at and payment.paid_at.date() >= month_start]

        total = sum(payment.amount for payment in payments)
        totals_by_type = {}
        for payment in payments:
            totals_by_type[payment.type] = str(Decimal(totals_by_type.get(payment.type, "0")) + payment.amount)

        return {
            "ok": True,
            "needs_clarification": False,
            "summary": f"Нашёл {len(payments)} платежей на сумму {format_money(total)} ₽.",
            "count": len(payments),
            "total": str(total),
            "totals_by_type": totals_by_type,
            "payments": [self._serialize_payment(payment) for payment in payments[:limit]],
        }

    def _tool_create_payment(self, arguments):
        project, clarification = self._resolve_single_project(
            project_id=parse_int(arguments.get("project_id")),
            project_query=arguments.get("project_query"),
        )
        if clarification:
            return clarification

        amount = parse_decimal(arguments.get("amount"))
        if amount is None:
            return self._clarification("Чтобы создать платёж, укажите корректную сумму.", [])

        paid_at = parse_iso_datetime(arguments.get("paid_at")) if "paid_at" in arguments else None
        if arguments.get("paid_at") and not paid_at:
            return self._clarification("Не смог разобрать дату платежа. Нужен ISO-формат.", [])

        payment_type = arguments.get("payment_type") or Payment.Type.ADVANCE
        if payment_type not in Payment.Type.values:
            payment_type = Payment.Type.ADVANCE

        payment_method = arguments.get("payment_method") or Payment.Method.TRANSFER
        if payment_method not in Payment.Method.values:
            payment_method = Payment.Method.TRANSFER

        payment = Payment.objects.create(
            project=project,
            created_by=self.user,
            amount=amount,
            type=payment_type,
            method=payment_method,
            comment=str(arguments.get("comment") or "").strip(),
            paid_at=paid_at or timezone.now(),
        )

        return {
            "ok": True,
            "needs_clarification": False,
            "summary": f"Добавлен платёж {format_money(payment.amount)} ₽ по проекту «{project.client_name}».",
            "payment": self._serialize_payment(payment),
        }

    def _tool_delete_payment(self, arguments):
        payment_id = parse_int(arguments.get("payment_id"))
        if not payment_id:
            return self._clarification("Для удаления платежа нужен его ID.", [])
        if not is_truthy(arguments.get("confirm")):
            return self._clarification("Подтвердите удаление платежа явно.", [])

        payment, clarification = self._resolve_single_payment(payment_id=payment_id)
        if clarification:
            return clarification

        summary = f"Платёж {format_money(payment.amount)} ₽ по проекту «{payment.project.client_name}» удалён."
        payment.delete()
        return {
            "ok": True,
            "needs_clarification": False,
            "summary": summary,
        }

    def _tool_list_project_comments(self, arguments):
        project, clarification = self._resolve_single_project(
            project_id=parse_int(arguments.get("project_id")),
            project_query=arguments.get("project_query"),
        )
        if clarification:
            return clarification

        limit = clamp_limit(arguments.get("limit"), default=10, maximum=25)
        comments = list(
            ProjectComment.objects.filter(project=project).select_related("author").order_by("-created_at")[:limit]
        )

        return {
            "ok": True,
            "needs_clarification": False,
            "summary": f"Нашёл {len(comments)} комментариев по проекту «{project.client_name}».",
            "project": {"project_id": project.id, "client_name": project.client_name},
            "comments": [self._serialize_comment(comment) for comment in comments],
        }

    def _tool_add_project_comment(self, arguments):
        project, clarification = self._resolve_single_project(
            project_id=parse_int(arguments.get("project_id")),
            project_query=arguments.get("project_query"),
        )
        if clarification:
            return clarification

        text = str(arguments.get("text") or "").strip()
        if not text:
            return self._clarification("Чтобы добавить комментарий, нужен его текст.", [])

        comment = ProjectComment.objects.create(project=project, author=self.user, text=text)
        return {
            "ok": True,
            "needs_clarification": False,
            "summary": f"Добавил комментарий в проект «{project.client_name}».",
            "comment": self._serialize_comment(comment),
        }

    def _tool_list_project_statuses(self, _arguments):
        statuses = self._status_rows()
        return {
            "ok": True,
            "needs_clarification": False,
            "summary": f"Доступно {len(statuses)} статусов канбана.",
            "statuses": [self._serialize_status(status) for status in statuses],
        }

    def _tool_create_project_status(self, arguments):
        admin_error = self._require_admin()
        if admin_error:
            return admin_error

        name = str(arguments.get("name") or "").strip()
        if not name:
            return self._clarification("Чтобы создать статус, нужно его название.", [])

        color = arguments.get("color") or ProjectStatus.Color.SKY
        if color not in ProjectStatus.Color.values:
            color = ProjectStatus.Color.SKY

        short_name = str(arguments.get("short_name") or "").strip() or name[:40]
        sort_order = (ProjectStatus.objects.order_by("-sort_order").first().sort_order + 10) if ProjectStatus.objects.exists() else 10

        status = ProjectStatus.objects.create(
            name=name,
            short_name=short_name,
            color=color,
            sort_order=sort_order,
            is_default=bool(arguments.get("is_default")),
            code=re.sub(r"[^\w\-]+", "-", normalize_text(name)).strip("-") or f"status-{timezone.now().timestamp():.0f}",
        )

        return {
            "ok": True,
            "needs_clarification": False,
            "summary": f"Создал статус канбана «{status.name}».",
            "status": self._serialize_status(status),
        }

    def _tool_update_project_status(self, arguments):
        admin_error = self._require_admin()
        if admin_error:
            return admin_error

        status_obj, clarification = self._resolve_single_status(
            status_id=parse_int(arguments.get("status_id")),
            status_name=arguments.get("status_name"),
        )
        if clarification:
            return clarification

        updates = {}
        for field in ["name", "short_name"]:
            if field in arguments:
                updates[field] = str(arguments.get(field) or "").strip()

        if "color" in arguments:
            color = arguments.get("color")
            if color not in ProjectStatus.Color.values:
                return self._clarification("Неизвестный цвет статуса.", [])
            updates["color"] = color

        if "is_default" in arguments:
            updates["is_default"] = bool(arguments.get("is_default"))

        if not updates:
            return self._clarification("Не увидел, что именно нужно изменить в статусе.", [])

        old_code = status_obj.code
        for field, value in updates.items():
            setattr(status_obj, field, value)
        if "name" in updates and not status_obj.short_name:
            status_obj.short_name = status_obj.name[:40]
        status_obj.code = re.sub(r"[^\w\-]+", "-", normalize_text(status_obj.name)).strip("-") or status_obj.code
        status_obj.save()

        if old_code != status_obj.code:
            Project.objects.filter(status=old_code).update(status=status_obj.code)

        return {
            "ok": True,
            "needs_clarification": False,
            "summary": f"Статус канбана «{status_obj.name}» обновлён.",
            "status": self._serialize_status(status_obj),
        }

    def _tool_delete_project_status(self, arguments):
        admin_error = self._require_admin()
        if admin_error:
            return admin_error

        status_id = parse_int(arguments.get("status_id"))
        if not status_id:
            return self._clarification("Для удаления статуса нужен его ID.", [])
        if not is_truthy(arguments.get("confirm")):
            return self._clarification("Подтвердите удаление статуса явно.", [])

        status_obj, clarification = self._resolve_single_status(status_id=status_id)
        if clarification:
            return clarification

        if Project.objects.filter(status=status_obj.code).exists():
            return self._clarification("Этот статус используется в проектах, его нельзя удалить.", [])

        was_default = status_obj.is_default
        status_name = status_obj.name
        status_obj.delete()

        if was_default:
            fallback = ProjectStatus.objects.order_by("sort_order", "id").first()
            if fallback and not fallback.is_default:
                fallback.is_default = True
                fallback.save(update_fields=["is_default"])

        return {
            "ok": True,
            "needs_clarification": False,
            "summary": f"Статус «{status_name}» удалён.",
        }

    def _tool_list_users(self, _arguments):
        users = self._visible_users()
        return {
            "ok": True,
            "needs_clarification": False,
            "summary": f"В списке {len(users)} пользователей.",
            "users": [self._serialize_user(user) for user in users],
        }

    def _tool_create_user(self, arguments):
        admin_error = self._require_admin()
        if admin_error:
            return admin_error

        username = str(arguments.get("username") or "").strip()
        password = str(arguments.get("password") or "").strip()
        if not username or not password:
            return self._clarification("Для создания пользователя нужны логин и пароль.", [])

        if User.objects.filter(username=username).exists():
            return self._clarification("Пользователь с таким логином уже существует.", [])

        role = arguments.get("role") or User.Role.MANAGER
        if role not in User.Role.values:
            role = User.Role.MANAGER

        user = User.objects.create_user(
            username=username,
            password=password,
            role=role,
            first_name=str(arguments.get("first_name") or "").strip(),
            last_name=str(arguments.get("last_name") or "").strip(),
            email=str(arguments.get("email") or "").strip(),
        )

        return {
            "ok": True,
            "needs_clarification": False,
            "summary": f"Создал пользователя «{user.username}».",
            "user": self._serialize_user(user),
        }

    def _tool_update_user(self, arguments):
        admin_error = self._require_admin()
        if admin_error:
            return admin_error

        user_id = parse_int(arguments.get("user_id"))
        if not user_id:
            return self._clarification("Для изменения пользователя нужен его ID.", [])

        user = User.objects.filter(id=user_id).first()
        if not user:
            return self._clarification("Не нашёл пользователя с таким ID.", [])

        for field in ["username", "first_name", "last_name", "email"]:
            if field in arguments:
                setattr(user, field, str(arguments.get(field) or "").strip())

        if "role" in arguments and arguments.get("role") in User.Role.values:
            user.role = arguments.get("role")

        if "is_active" in arguments:
            user.is_active = bool(arguments.get("is_active"))

        if arguments.get("password"):
            user.set_password(str(arguments.get("password")))

        user.save()
        return {
            "ok": True,
            "needs_clarification": False,
            "summary": f"Обновил пользователя «{user.username}».",
            "user": self._serialize_user(user),
        }
