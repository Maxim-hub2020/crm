import re

from django.core import signing
from rest_framework import status
from rest_framework.decorators import api_view, parser_classes, permission_classes
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from .models import CalculatorSettings, default_workspace
from .public_calculator import _rate_limited
from .public_production import ALLOWED_CONTENT_TYPES, ALLOWED_EXTENSIONS, MAX_FILE_SIZE, _clean


MAX_CHAT_FILES = 3
STATE_SALT = "amalgama-public-designer-v1"
STATE_MAX_AGE = 7 * 24 * 60 * 60


def _catalog():
    record = CalculatorSettings.objects.filter(workspace=default_workspace()).first()
    return record.shower_catalog if record and isinstance(record.shower_catalog, dict) else {}


def _constructions(catalog):
    return [row for row in catalog.get("constructions", []) if row.get("id") and row.get("title")]


def _construction(catalog, construction_id):
    return next((row for row in _constructions(catalog) if str(row.get("id")) == str(construction_id)), None)


def _normal(value):
    return re.sub(r"[^a-zа-яё0-9]+", " ", str(value or "").lower()).strip()


def _numbers(value):
    return [float(item.replace(",", ".")) for item in re.findall(r"\d+(?:[.,]\d+)?", str(value or ""))]


def _format_mm(value):
    number = float(value)
    return f"{number:g} мм"


def _choice(value, options):
    normalized = _normal(value)
    for option in options:
        if normalized in {_normal(option["value"]), _normal(option["label"])}:
            return option["value"]
    matches = [option for option in options if normalized and normalized in _normal(option["label"])]
    return matches[0]["value"] if len(matches) == 1 else None


def _validate_files(files):
    if len(files) > MAX_CHAT_FILES:
        return "За один раз можно загрузить не больше трёх файлов."
    for uploaded in files:
        extension = "." + uploaded.name.rsplit(".", 1)[-1].lower() if "." in uploaded.name else ""
        if uploaded.size > MAX_FILE_SIZE or uploaded.content_type not in ALLOWED_CONTENT_TYPES or extension not in ALLOWED_EXTENSIONS:
            return "Прикрепляйте JPG, PNG, WebP или PDF до 8 МБ."
    return ""


def _construction_options(catalog):
    return [
        {"value": str(row["id"]), "label": row.get("shortTitle") or row["title"]}
        for row in _constructions(catalog)
    ]


def _finish_options(catalog):
    return [{"value": str(row["id"]), "label": row["label"]} for row in catalog.get("hardware", []) if row.get("id") and row.get("label")]


def _questions(catalog, construction, answers):
    questions = []
    for field in construction.get("fields", []):
        key = str(field.get("key") or "")
        label = str(field.get("label") or key)
        minimum, maximum = field.get("min", 0), field.get("max", 5000)
        if key.startswith("HEIGHT"):
            questions.append({"key": key, "kind": "number", "stage": "geometry", "min": minimum, "max": maximum, "prompt": f"Укажите чистовую высоту «{label}» в миллиметрах."})
        elif key.startswith("WIDTH"):
            questions.append({"key": key, "kind": "pair", "stage": "geometry", "min": minimum, "max": maximum, "prompt": f"Укажите размер «{label}» снизу и сверху в миллиметрах — два числа через пробел."})

    questions.extend([
        {"key": "wall_deviation", "kind": "pair_zero", "stage": "geometry", "min": 0, "max": 100, "prompt": "Укажите отклонение левой и правой стены от вертикали в миллиметрах. Если стены вертикальны — напишите: 0 0."},
        {"key": "floor_deviation", "kind": "number_zero", "stage": "geometry", "min": 0, "max": 100, "prompt": "Какой перепад уровня пола или поддона в зоне душевой, мм? Если уровень проверен и перепада нет — 0."},
        {"key": "tray_width", "kind": "number", "stage": "geometry", "min": 20, "max": 300, "prompt": "Укажите фактическую ширину порожка или полки поддона в миллиметрах."},
        {"key": "tray_axis", "kind": "choice", "stage": "geometry", "prompt": "Где проходит ось стекла на порожке?", "options": [
            {"value": "center", "label": "По центру порожка"},
            {"value": "custom", "label": "Есть точная привязка от края"},
        ]},
    ])
    if answers.get("tray_axis") == "custom":
        questions.append({"key": "tray_axis_offset", "kind": "number", "stage": "geometry", "min": 1, "max": 299, "prompt": "Укажите расстояние от выбранной кромки порожка до оси стекла в миллиметрах."})

    sketch = str(construction.get("sketch") or "")
    has_door = "door" in sketch or "niche" in sketch or "corner" in sketch or "slider" in sketch or "trapezoid" in sketch
    if has_door:
        if "slider" in sketch:
            opening_options = [{"value": "slide-left", "label": "Дверь сдвигается влево"}, {"value": "slide-right", "label": "Дверь сдвигается вправо"}]
        else:
            opening_options = [
                {"value": "out-left", "label": "Наружу, петли слева"},
                {"value": "out-right", "label": "Наружу, петли справа"},
                {"value": "in-left", "label": "Внутрь, петли слева"},
                {"value": "in-right", "label": "Внутрь, петли справа"},
            ]
        questions.append({"key": "opening", "kind": "choice", "stage": "configuration", "prompt": "Выберите направление движения двери.", "options": opening_options})

    questions.extend([
        {"key": "glass_thickness", "kind": "choice", "stage": "configuration", "prompt": "Выберите толщину стекла.", "options": [{"value": "8", "label": "8 мм"}, {"value": "6", "label": "6 мм"}]},
        {"key": "glass_type", "kind": "choice", "stage": "configuration", "prompt": "Какое стекло нужно?", "options": [
            {"value": "clear", "label": "Прозрачное"}, {"value": "extra-clear", "label": "Осветлённое"},
            {"value": "frosted", "label": "Матовое"}, {"value": "bronze", "label": "Бронза"}, {"value": "graphite", "label": "Графит"},
        ]},
        {"key": "hardware_finish", "kind": "choice", "stage": "configuration", "prompt": "Выберите только цвет фурнитуры — состав система подберёт автоматически.", "options": _finish_options(catalog)},
        {"key": "obstacles", "kind": "choice", "stage": "configuration", "prompt": "Есть ли рядом сантехника, мебель, полотенцесушитель или другие препятствия для двери и монтажа?", "options": [{"value": "no", "label": "Препятствий нет"}, {"value": "yes", "label": "Есть препятствия"}]},
    ])
    if answers.get("obstacles") == "yes":
        questions.append({"key": "obstacles_text", "kind": "text", "stage": "configuration", "prompt": "Коротко опишите препятствие и укажите расстояние до него в миллиметрах."})
    questions.append({"key": "client_confirmation", "kind": "choice", "stage": "review", "prompt": "Подтверждаете, что размеры сняты по чистовой отделке и записаны без предположений?", "options": [{"value": "yes", "label": "Да, подтверждаю"}, {"value": "no", "label": "Нет, нужно перемерить"}]})
    return questions


def _parse_answer(question, message, option_value):
    raw = option_value or message
    kind = question["kind"]
    if kind == "choice":
        value = _choice(raw, question.get("options", []))
        if value is None:
            raise ValueError("Выберите один из предложенных вариантов.")
        return value
    if kind in {"number", "number_zero"}:
        values = _numbers(raw)
        if not values:
            raise ValueError("Введите размер одним числом в миллиметрах.")
        value = values[0]
        if not question["min"] <= value <= question["max"]:
            raise ValueError(f"Допустимый диапазон: {question['min']}–{question['max']} мм.")
        return value
    if kind in {"pair", "pair_zero"}:
        values = _numbers(raw)
        if len(values) != 2:
            raise ValueError("Введите ровно два числа: размер снизу, затем размер сверху.")
        if any(not question["min"] <= value <= question["max"] for value in values):
            raise ValueError(f"Каждый размер должен быть в диапазоне {question['min']}–{question['max']} мм.")
        return {"bottom": values[0], "top": values[1]}
    value = _clean(raw, 800)
    if len(value) < 3:
        raise ValueError("Опишите препятствие чуть подробнее.")
    return value


def _hardware(catalog, construction, answers):
    item_map = {str(item.get("id")): item for item in catalog.get("hardwareItems", []) if item.get("id")}
    thickness = int(answers.get("glass_thickness") or 0)
    if not thickness or not answers.get("hardware_finish"):
        return []
    finish_label = next((row["label"] for row in _finish_options(catalog) if row["value"] == answers.get("hardware_finish")), "выбранная отделка")
    result = []
    for component in construction.get("hardwareComponents", []):
        component_thickness = component.get("glassThickness")
        if component_thickness and thickness and int(component_thickness) != thickness:
            continue
        item = item_map.get(str(component.get("hardwareItemId")))
        if not item:
            continue
        result.append({
            "catalog_id": str(item["id"]),
            "label": str(item.get("label") or item.get("sku") or item["id"]),
            "quantity": max(1, int(component.get("quantity") or 1)),
            "reason": f"Автоматический состав конструкции · отделка: {finish_label}",
            "source_url": item.get("sourceUrl"),
        })
    return result


def _facts(construction, answers, catalog):
    facts = [{"key": "Конструкция", "value": construction["title"], "source": "каталог CRM"}]
    field_map = {str(field.get("key")): str(field.get("label") or field.get("key")) for field in construction.get("fields", [])}
    for key, label in field_map.items():
        value = answers.get(key)
        if isinstance(value, dict):
            shown = f"снизу {_format_mm(value['bottom'])}, сверху {_format_mm(value['top'])}"
        elif value is not None:
            shown = _format_mm(value)
        else:
            continue
        facts.append({"key": label, "value": shown, "source": "ответ клиента"})
    finish = next((row["label"] for row in _finish_options(catalog) if row["value"] == answers.get("hardware_finish")), None)
    if finish:
        facts.append({"key": "Цвет фурнитуры", "value": finish, "source": "выбор клиента"})
    return facts


def _response(catalog, state, prefix=""):
    construction = _construction(catalog, state.get("construction_id"))
    if not construction:
        options = _construction_options(catalog)
        message = prefix or "Выберите конструкцию. Фурнитуру и её количество система определит сама."
        return {
            "message": message, "stage": "intro", "progress": 0, "facts": [],
            "missing": ["Тип конструкции"], "critical_checks": {"geometry": False, "levels": False, "opening": False, "glass": False, "hardware_docs": False, "client_confirmation": False},
            "hardware": [], "ready_for_final": False, "documents_unlocked": False,
            "options": options, "input_mode": "choice", "question_key": "construction",
            "project_title": "Новая конструкция", "catalog_connected": bool(catalog),
            "state_token": signing.dumps(state, salt=STATE_SALT, compress=True),
        }

    answers = state.setdefault("answers", {})
    questions = _questions(catalog, construction, answers)
    current = next((question for question in questions if question["key"] not in answers), None)
    completed = current is None
    answered = len([question for question in questions if question["key"] in answers])
    progress = min(90, round(answered / max(1, len(questions)) * 90))
    has_door = any(question["key"] == "opening" for question in questions)
    geometry_keys = [question["key"] for question in questions if question["stage"] == "geometry"]
    geometry = all(key in answers for key in geometry_keys)
    levels = all(key in answers for key in ["floor_deviation", "tray_width", "tray_axis"]) and (answers.get("tray_axis") != "custom" or "tray_axis_offset" in answers)
    opening = (not has_door or "opening" in answers) and (answers.get("obstacles") != "yes" or bool(answers.get("obstacles_text")))
    glass = all(key in answers for key in ["glass_thickness", "glass_type", "hardware_finish"])
    confirmation = answers.get("client_confirmation") == "yes"
    checks = {"geometry": geometry, "levels": levels, "opening": opening, "glass": glass, "hardware_docs": False, "client_confirmation": confirmation}
    missing = []
    if current:
        missing.append(current["prompt"])
    if answers.get("client_confirmation") == "no":
        missing.append("Повторный замер по чистовой отделке")
    if completed:
        missing.append("Технические чертежи точных артикулов и подтверждение операций в стекле")

    if current:
        message = (prefix + "\n\n" if prefix else "") + current["prompt"]
        options, input_mode, question_key, stage = current.get("options", []), current["kind"], current["key"], current["stage"]
    else:
        message = "Проверочный проект собран. Состав фурнитуры подобран автоматически по конструкции и толщине стекла. Финальные PDF/DXF пока заблокированы: для производственного выпуска нужны технические чертежи точных артикулов и проверка операций технологом."
        options, input_mode, question_key, stage = [], "complete", "", "review"
    return {
        "message": message, "stage": stage, "progress": progress, "facts": _facts(construction, answers, catalog),
        "missing": missing, "critical_checks": checks, "hardware": _hardware(catalog, construction, answers),
        "ready_for_final": False, "documents_unlocked": False, "options": options, "input_mode": input_mode,
        "question_key": question_key, "project_title": construction.get("shortTitle") or construction["title"],
        "catalog_connected": bool(catalog), "uploaded_files": state.get("files", []),
        "state_token": signing.dumps(state, salt=STATE_SALT, compress=True),
    }


@api_view(["GET", "POST"])
@permission_classes([AllowAny])
@parser_classes([MultiPartParser, FormParser])
def public_designer_chat_view(request):
    catalog = _catalog()
    if request.method == "GET":
        return Response({"enabled": bool(_constructions(catalog)), "model": "Правила CEH CRM", "mode": "deterministic"})
    if _rate_limited(request, "designer-chat", limit=60, seconds=600):
        return Response({"detail": "Слишком много сообщений. Продолжите через несколько минут."}, status=status.HTTP_429_TOO_MANY_REQUESTS)

    files = request.FILES.getlist("files")
    file_error = _validate_files(files)
    if file_error:
        return Response({"detail": file_error}, status=status.HTTP_400_BAD_REQUEST)
    try:
        state = signing.loads(request.data.get("state_token", ""), salt=STATE_SALT, max_age=STATE_MAX_AGE) if request.data.get("state_token") else {"version": 1, "construction_id": "", "answers": {}, "files": []}
    except (signing.BadSignature, signing.SignatureExpired):
        state = {"version": 1, "construction_id": "", "answers": {}, "files": []}

    for uploaded in files:
        name = _clean(uploaded.name, 180)
        if name and name not in state.setdefault("files", []):
            state["files"].append(name)
    message = _clean(request.data.get("message"), 4000)
    option_value = _clean(request.data.get("option_value"), 200)
    selected_model = _clean(request.data.get("selected_model"), 120)
    construction = _construction(catalog, state.get("construction_id"))

    if not construction:
        chosen = _construction(catalog, selected_model) or _construction(catalog, option_value)
        if not chosen and message:
            chosen_id = _choice(message, _construction_options(catalog))
            chosen = _construction(catalog, chosen_id)
        if chosen:
            state["construction_id"] = str(chosen["id"])
            prefix = f"Выбрана конструкция «{chosen['title']}». Комплектующие система подберёт автоматически; от вас потребуется только выбрать их цвет."
            if files:
                prefix += " Загруженные файлы сохранены как материалы замера, но критические размеры нужно подтвердить в диалоге."
            return Response(_response(catalog, state, prefix))
        return Response(_response(catalog, state))

    questions = _questions(catalog, construction, state.setdefault("answers", {}))
    current = next((question for question in questions if question["key"] not in state["answers"]), None)
    if current:
        if not message and not option_value:
            prefix = "Файл принят как материал замера. Размеры из него автоматически не переносятся." if files else ""
            return Response(_response(catalog, state, prefix))
        try:
            state["answers"][current["key"]] = _parse_answer(current, message, option_value)
        except ValueError as error:
            return Response(_response(catalog, state, str(error)))
    return Response(_response(catalog, state))
