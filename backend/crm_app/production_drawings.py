import base64
import json
import re

from .gemini_client import GeminiClient, GeminiRequestError


MAX_PRODUCTION_PLAN_IMAGE_BYTES = 10 * 1024 * 1024
ALLOWED_PRODUCTION_PLAN_MIME_TYPES = {"image/jpeg", "image/png", "image/webp"}


PRODUCTION_PLAN_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "confidence": {"type": "number"},
        "panels": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "shape": {"type": "string", "enum": ["rectangle", "trapezoid"]},
                    "widthMm": {"type": "number"},
                    "heightMm": {"type": "number"},
                    "topWidthMm": {"type": "number"},
                    "quantity": {"type": "integer"},
                    "notes": {"type": "string"},
                },
                "required": ["label", "shape", "widthMm", "heightMm", "topWidthMm", "quantity", "notes"],
            },
        },
        "operations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "panelLabel": {"type": "string"},
                    "kind": {"type": "string", "enum": ["hole", "notch", "cutout", "template"]},
                    "label": {"type": "string"},
                    "xMm": {"type": "number"},
                    "yMm": {"type": "number"},
                    "widthMm": {"type": "number"},
                    "heightMm": {"type": "number"},
                    "diameterMm": {"type": "number"},
                    "confirmedFromSource": {"type": "boolean"},
                },
                "required": [
                    "panelLabel",
                    "kind",
                    "label",
                    "xMm",
                    "yMm",
                    "widthMm",
                    "heightMm",
                    "diameterMm",
                    "confirmedFromSource",
                ],
            },
        },
        "recognizedDimensions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "valueMm": {"type": "number"},
                    "source": {"type": "string"},
                },
                "required": ["label", "valueMm", "source"],
            },
        },
        "warnings": {"type": "array", "items": {"type": "string"}},
        "needsReview": {"type": "boolean"},
    },
    "required": [
        "summary",
        "confidence",
        "panels",
        "operations",
        "recognizedDimensions",
        "warnings",
        "needsReview",
    ],
}


SYSTEM_INSTRUCTION = """
Ты технический помощник производства стеклянных душевых ограждений.
Анализируй загруженный вид сверху вместе с данными калькулятора и выбранной фурнитурой.
Возвращай только структурированный JSON по заданной схеме и пиши тексты на русском языке.

Правила безопасности:
1. Не придумывай размеры, которых нет на изображении или в переданном контексте.
2. Не считай приблизительный эскиз готовым производственным чертежом.
3. Для сверлений, вырезов и пазов используй размеры только если они явно читаются на изображении.
4. Если фурнитуре нужна обработка, но её размеры не указаны, добавь operation kind=template с нулевыми размерами и предупреждение о необходимости шаблона производителя.
5. Высоту, которой обычно нет на виде сверху, бери из контекста калькулятора и указывай это в notes.
6. Все панели и операции требуют проверки технологом, поэтому needsReview всегда true.
7. В confidence отражай уверенность именно в распознанной геометрии, от 0 до 1.
""".strip()


def _number(value, default=0, minimum=0, maximum=100000):
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return min(maximum, max(minimum, result))


def _integer(value, default=1, minimum=1, maximum=100):
    return int(round(_number(value, default, minimum, maximum)))


def _clean_json_text(value):
    text = str(value or "").strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", text, flags=re.DOTALL | re.IGNORECASE)
    return fenced.group(1).strip() if fenced else text


def normalize_production_plan(payload):
    if not isinstance(payload, dict):
        raise GeminiRequestError("Модель вернула неверный формат производственного анализа.")

    panels = []
    for index, raw_panel in enumerate(payload.get("panels") or []):
        if not isinstance(raw_panel, dict):
            continue
        width = _number(raw_panel.get("widthMm"))
        height = _number(raw_panel.get("heightMm"))
        panels.append(
            {
                "label": str(raw_panel.get("label") or f"Стекло {index + 1}").strip()[:120],
                "shape": "trapezoid" if raw_panel.get("shape") == "trapezoid" else "rectangle",
                "widthMm": width,
                "heightMm": height,
                "topWidthMm": _number(raw_panel.get("topWidthMm"), width),
                "quantity": _integer(raw_panel.get("quantity")),
                "notes": str(raw_panel.get("notes") or "").strip()[:500],
            }
        )

    operations = []
    for raw_operation in payload.get("operations") or []:
        if not isinstance(raw_operation, dict):
            continue
        kind = raw_operation.get("kind")
        if kind not in {"hole", "notch", "cutout", "template"}:
            kind = "template"
        operations.append(
            {
                "panelLabel": str(raw_operation.get("panelLabel") or "").strip()[:120],
                "kind": kind,
                "label": str(raw_operation.get("label") or "Обработка").strip()[:240],
                "xMm": _number(raw_operation.get("xMm")),
                "yMm": _number(raw_operation.get("yMm")),
                "widthMm": _number(raw_operation.get("widthMm")),
                "heightMm": _number(raw_operation.get("heightMm")),
                "diameterMm": _number(raw_operation.get("diameterMm")),
                "confirmedFromSource": bool(raw_operation.get("confirmedFromSource")),
            }
        )

    recognized_dimensions = []
    for raw_dimension in payload.get("recognizedDimensions") or []:
        if not isinstance(raw_dimension, dict):
            continue
        recognized_dimensions.append(
            {
                "label": str(raw_dimension.get("label") or "Размер").strip()[:120],
                "valueMm": _number(raw_dimension.get("valueMm")),
                "source": str(raw_dimension.get("source") or "изображение").strip()[:240],
            }
        )

    warnings = [str(item).strip()[:500] for item in payload.get("warnings") or [] if str(item).strip()]
    return {
        "summary": str(payload.get("summary") or "Схема проанализирована.").strip()[:1000],
        "confidence": _number(payload.get("confidence"), 0, 0, 1),
        "panels": panels,
        "operations": operations,
        "recognizedDimensions": recognized_dimensions,
        "warnings": warnings,
        "needsReview": True,
    }


def analyze_production_plan(image_bytes, mime_type, context):
    client = GeminiClient()
    context_json = json.dumps(context, ensure_ascii=False, separators=(",", ":"))
    response = client.generate_content(
        system_instruction=SYSTEM_INSTRUCTION,
        contents=[
            {
                "role": "user",
                "parts": [
                    {
                        "text": (
                            "Определи конфигурацию поддона и предложи состав стеклянных панелей. "
                            "Сопоставь вид сверху с выбранной конструкцией и фурнитурой. "
                            f"Контекст калькулятора: {context_json}"
                        )
                    },
                    {
                        "inlineData": {
                            "mimeType": mime_type,
                            "data": base64.b64encode(image_bytes).decode("ascii"),
                        }
                    },
                ],
            }
        ],
        temperature=0.1,
        max_output_tokens=8192,
        generation_config={
            "responseMimeType": "application/json",
            "responseSchema": PRODUCTION_PLAN_RESPONSE_SCHEMA,
        },
    )
    content = client.extract_candidate_content(response)
    raw_text = _clean_json_text(client.extract_text(content))
    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise GeminiRequestError("Модель не смогла вернуть корректный JSON производственного анализа.") from exc
    return normalize_production_plan(payload)
