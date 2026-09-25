import json
import os
from urllib import error as urllib_error
from urllib import request as urllib_request


GOOGLE_CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform"


def _normalize_text(value):
    return " ".join(str(value or "").strip().lower().split())


class GeminiConfigurationError(RuntimeError):
    pass


class GeminiRequestError(RuntimeError):
    pass


def humanize_gemini_error(raw_error, backend="google_ai"):
    text = str(raw_error or "").strip()
    normalized = _normalize_text(text)

    if "user location is not supported for the api use" in normalized:
        if backend == "google_ai":
            return (
                "Прямой Gemini API через Google AI Studio недоступен из текущей локации сервера. "
                "Для CRM используйте Vertex AI: GEMINI_BACKEND=vertex_ai, "
                "VERTEX_AI_PROJECT_ID=<project-id>, VERTEX_AI_LOCATION=global "
                "и GOOGLE_APPLICATION_CREDENTIALS."
            )
        return "Vertex AI вернул географическое ограничение для текущей конфигурации."

    if "aiplatform.endpoints.predict" in normalized or "permission denied" in normalized:
        return (
            "Vertex AI отклонил запрос по правам доступа. "
            "Проверьте roles/aiplatform.user и доступ сервисного аккаунта к проекту VERTEX_AI_PROJECT_ID."
        )

    if text.startswith("Gemini API error:"):
        return text

    return f"Gemini API error: {text}"


class GeminiClient:
    def __init__(self):
        self.backend = (os.getenv("GEMINI_BACKEND", "google_ai").strip().lower() or "google_ai")
        if self.backend not in {"google_ai", "vertex_ai"}:
            raise GeminiConfigurationError("GEMINI_BACKEND должен быть google_ai или vertex_ai.")

        raw_api_key = os.getenv("GEMINI_API_KEY", "").strip()
        self.api_key = "" if raw_api_key in {"your-gemini-api-key", "change-me"} else raw_api_key
        self.vertex_project = (
            os.getenv("VERTEX_AI_PROJECT_ID", "").strip()
            or os.getenv("GOOGLE_CLOUD_PROJECT", "").strip()
            or os.getenv("GCLOUD_PROJECT", "").strip()
        )
        self.vertex_location = os.getenv("VERTEX_AI_LOCATION", "global").strip() or "global"
        default_model = "gemini-2.5-flash" if self.backend == "vertex_ai" else "gemini-3.5-flash"
        self.model = os.getenv("GEMINI_MODEL", default_model).strip() or default_model
        self.fast_model = os.getenv("GEMINI_FAST_MODEL", self.model).strip() or self.model
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
            payload["systemInstruction"] = {"parts": [{"text": system_instruction}]}

        if generation_config:
            payload["generationConfig"].update(generation_config)

        if tools:
            payload["tools"] = [{"functionDeclarations": tools}]

        return self._post(payload, model=model or self.model)

    def _post(self, payload, model):
        if self.backend == "vertex_ai":
            return self._post_vertex_ai(payload, model)
        return self._post_google_ai(payload, model)

    def _post_google_ai(self, payload, model):
        request = urllib_request.Request(
            url=f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": self.api_key,
            },
            method="POST",
        )
        try:
            with urllib_request.urlopen(request, timeout=90) as response:
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
        request = urllib_request.Request(
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
            with urllib_request.urlopen(request, timeout=90) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib_error.HTTPError as exc:
            try:
                body = exc.read().decode("utf-8")
            except Exception:
                body = str(exc)
            raise GeminiRequestError(humanize_gemini_error(body, backend="vertex_ai")) from exc
        except urllib_error.URLError as exc:
            raise GeminiRequestError(f"Не удалось связаться с Vertex AI Gemini: {exc}") from exc

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
