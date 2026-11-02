import hashlib
import json
import logging
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from django.conf import settings
from django.core.cache import cache
from django.db import IntegrityError, transaction
from rest_framework import status
from rest_framework.decorators import api_view, parser_classes, permission_classes
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from .calculator_leads import _application_status
from .models import (
    CalculatorSettings,
    Client,
    MeasurementPhoto,
    MeasurementSheet,
    ProductionPlan,
    Project,
    User,
    default_workspace,
)
from .phones import normalize_russian_phone
from .public_calculator import _rate_limited
from .workflow import apply_task_templates_for_project, create_audit_log, snapshot_model


logger = logging.getLogger(__name__)

MAX_FILES = 6
MAX_FILE_SIZE = 8 * 1024 * 1024
MAX_TOTAL_SIZE = 24 * 1024 * 1024
ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp", "application/pdf"}
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".pdf"}
TOPOLOGIES = {
    "partition": "Перегородка",
    "niche-door": "Дверь в нишу",
    "niche-fixed": "Дверь в нишу с неподвижным стеклом",
    "corner": "Угловая распашная",
    "slider": "Раздвижная",
    "other": "По эскизу клиента",
}


def _clean(value, limit):
    return " ".join(str(value or "").strip().split())[:limit]


def _number(value, minimum=0, maximum=5000):
    try:
        number = round(float(value), 1)
    except (TypeError, ValueError):
        return None
    return number if minimum <= number <= maximum else None


def _manager(workspace):
    users = User.objects.filter(workspace=workspace, is_active=True).order_by("id")
    return next((user for user in users if user.is_admin()), users.first())


def _client(workspace, name, phone, email):
    client = Client.objects.filter(workspace=workspace, phone=phone).first()
    if client:
        updates = []
        if name and client.name != name:
            client.name = name
            updates.append("name")
        if email and client.email != email:
            client.email = email
            updates.append("email")
        if updates:
            client.save(update_fields=[*updates, "updated_at"])
        return client
    try:
        return Client.objects.create(workspace=workspace, name=name, phone=phone, email=email or None)
    except IntegrityError:
        return Client.objects.get(workspace=workspace, phone=phone)


def _validate_files(files):
    if len(files) > MAX_FILES:
        return f"Можно прикрепить не больше {MAX_FILES} файлов."
    total = 0
    for uploaded in files:
        total += uploaded.size
        extension = Path(uploaded.name or "").suffix.lower()
        if uploaded.size > MAX_FILE_SIZE:
            return f"Файл «{uploaded.name}» больше 8 МБ."
        if uploaded.content_type not in ALLOWED_CONTENT_TYPES or extension not in ALLOWED_EXTENSIONS:
            return "Прикрепляйте JPG, PNG, WebP или PDF."
    if total > MAX_TOTAL_SIZE:
        return "Общий размер файлов не должен превышать 24 МБ."
    return ""


def _selected_hardware(workspace, raw_cart):
    try:
        cart = json.loads(raw_cart or "[]")
    except json.JSONDecodeError:
        raise ValueError("Не удалось прочитать выбранные комплектующие.")
    if not isinstance(cart, list) or len(cart) > 40:
        raise ValueError("Некорректный состав комплекта.")
    settings_record = CalculatorSettings.objects.filter(workspace=workspace).first()
    catalog = settings_record.shower_catalog if settings_record and isinstance(settings_record.shower_catalog, dict) else {}
    items = {str(item.get("id")): item for item in catalog.get("hardwareItems", []) if item.get("id")}
    result = []
    for row in cart:
        if not isinstance(row, dict):
            continue
        item_id = _clean(row.get("id"), 100)
        item = items.get(item_id)
        if not item:
            raise ValueError("Одна из позиций больше недоступна. Обновите каталог.")
        try:
            quantity = max(1, min(20, int(row.get("quantity") or 1)))
        except (TypeError, ValueError):
            quantity = 1
        result.append({"catalog_id": item_id, "label": _clean(item.get("label"), 300), "quantity": quantity})
    return result


def _notify(project):
    notifier_url = str(getattr(settings, "CALCULATOR_NOTIFIER_URL", "")).strip()
    if not notifier_url:
        return
    payload = json.dumps(
        {
            "name": project.client_name,
            "phone": project.client_phone,
            "product": "shower",
            "message": f"DIY-проект №{project.order_number} создан в CRM. Загружен эскиз/замер для технологической проверки.",
        },
        ensure_ascii=False,
    ).encode("utf-8")
    request = Request(notifier_url, data=payload, method="POST", headers={"Content-Type": "application/json; charset=utf-8"})
    try:
        with urlopen(request, timeout=6) as response:
            if not 200 <= response.status < 300:
                raise RuntimeError(f"notifier returned {response.status}")
    except (HTTPError, URLError, TimeoutError, RuntimeError):
        logger.exception("public_production_notification_failed project_id=%s", project.id)


@api_view(["POST"])
@permission_classes([AllowAny])
@parser_classes([MultiPartParser, FormParser])
def public_production_intake_view(request):
    if _rate_limited(request, "production-intake", limit=4, seconds=600):
        return Response({"detail": "Слишком много отправок. Попробуйте немного позже."}, status=status.HTTP_429_TOO_MANY_REQUESTS)
    if _clean(request.data.get("company"), 100):
        return Response({"ok": True}, status=status.HTTP_201_CREATED)

    name = _clean(request.data.get("name"), 200)
    email = _clean(request.data.get("email"), 254)
    try:
        phone = normalize_russian_phone(request.data.get("phone"), strict=True)
    except ValueError as error:
        return Response({"detail": str(error)}, status=status.HTTP_400_BAD_REQUEST)
    if len(name) < 2:
        return Response({"detail": "Укажите ваше имя."}, status=status.HTTP_400_BAD_REQUEST)

    files = request.FILES.getlist("files") or request.FILES.getlist("file")
    file_error = _validate_files(files)
    if file_error:
        return Response({"detail": file_error}, status=status.HTTP_400_BAD_REQUEST)

    topology = _clean(request.data.get("topology"), 40) or "other"
    if topology not in TOPOLOGIES:
        return Response({"detail": "Выберите тип душевой."}, status=status.HTTP_400_BAD_REQUEST)
    dimensions = {
        key: number
        for key, number in {
            "width_mm": _number(request.data.get("width"), 100),
            "depth_mm": _number(request.data.get("depth"), 0),
            "height_mm": _number(request.data.get("height"), 300),
            "ledge_width_mm": _number(request.data.get("ledge_width"), 20, 300),
        }.items()
        if number is not None
    }
    try:
        selected_hardware = _selected_hardware(default_workspace(), request.data.get("cart"))
    except ValueError as error:
        return Response({"detail": str(error)}, status=status.HTTP_400_BAD_REQUEST)
    if not files and not dimensions and not selected_hardware:
        return Response({"detail": "Прикрепите эскиз, укажите размеры или выберите комплектующие."}, status=status.HTTP_400_BAD_REQUEST)

    fingerprint = hashlib.sha256(f"{phone}:{topology}:{json.dumps(dimensions, sort_keys=True)}:{','.join(file.name for file in files)}".encode()).hexdigest()
    cached = cache.get(f"public-production:{fingerprint}")
    if cached:
        return Response({**cached, "duplicate": True}, status=status.HTTP_200_OK)

    workspace = default_workspace()
    manager = _manager(workspace)
    project_status = _application_status(workspace.id)
    if not manager or not project_status:
        return Response({"detail": "CRM временно не готова принять проект."}, status=status.HTTP_503_SERVICE_UNAVAILABLE)

    saved_photos = []
    with transaction.atomic():
        client = _client(workspace, name, phone, email)
        project = Project.objects.create(
            workspace=workspace,
            manager=manager,
            client=client,
            client_name=name,
            client_phone=phone,
            client_email=email or None,
            status=project_status.code,
            title=f"DIY · {TOPOLOGIES[topology]}",
            categories="shower",
            description=(
                "Заявка на самостоятельную сборку с сайта. Исходные данные клиента требуют технологической проверки.\n"
                + _clean(request.data.get("comment"), 3000)
            ).strip(),
        )
        sheet = MeasurementSheet.objects.create(
            workspace=workspace,
            project=project,
            created_by=manager,
            is_complete=False,
            data={
                "source": "public_diy_intake",
                "topology": topology,
                "dimensions": dimensions,
                "tray_axis": _clean(request.data.get("tray_axis"), 40),
                "opening_direction": _clean(request.data.get("opening_direction"), 80),
                "glass_thickness_mm": _number(request.data.get("glass_thickness"), 6, 12),
                "finish": _clean(request.data.get("finish"), 80),
                "walls_finished": request.data.get("walls_finished") == "true",
                "floor_checked": request.data.get("floor_checked") == "true",
                "comment": _clean(request.data.get("comment"), 3000),
            },
        )
        for uploaded in files:
            photo = MeasurementPhoto.objects.create(sheet=sheet, file=uploaded, original_name=Path(uploaded.name).name[:255])
            saved_photos.append(photo)

        blockers = [
            "Подтвердить фактические размеры каждой стороны на нижней и верхней отметках.",
            "Проверить отклонения стен от вертикали и поддона или пола от уровня.",
            "Подтвердить чистовую высоту, ширину порожка и положение оси стекла.",
            "Проверить направление открывания и отсутствие препятствий в зоне движения двери.",
            "После проверки геометрии утвердить точные артикулы и монтажные зазоры всей фурнитуры.",
        ]
        plan = ProductionPlan.objects.create(
            workspace=workspace,
            project=project,
            revision=1,
            product_type=ProductionPlan.ProductType.SHOWER,
            status=ProductionPlan.Status.NEEDS_INPUT,
            summary=f"Входящий DIY-проект: {TOPOLOGIES[topology]}. Ожидает разбора производственным навыком и проверки технологом.",
            specification={
                "product": {"type": "shower", "topology": topology, "title": TOPOLOGIES[topology]},
                "source": {"kind": "public_diy_intake", "mcp_ready": True},
                "geometry": {"nominal_dimensions_mm": dimensions, "tray_axis": sheet.data["tray_axis"]},
                "panels": [],
                "operations": [],
                "hardware": {"selected_by_customer": selected_hardware, "verified_items": []},
                "clearances": {},
                "installation": {"opening_direction": sheet.data["opening_direction"], "self_assembly": True},
                "assumptions": [],
                "evidence": [{"file": photo.original_name, "source": "загрузка клиента"} for photo in saved_photos],
            },
            blocking_questions=blockers,
            warnings=[
                "Загруженный эскиз не является производственным чертежом.",
                "Стекло нельзя заказывать до закрытия блокирующих вопросов и проверки технологом.",
            ],
            source_files=[{"name": photo.original_name, "path": photo.file.name} for photo in saved_photos],
            output_files=[],
            created_by=manager,
        )
        apply_task_templates_for_project(project, actor=manager)
        create_audit_log(
            manager,
            "project",
            project.id,
            "create",
            after=snapshot_model(project, ["id", "order_number", "title", "client_name", "client_phone", "status"]),
            workspace=workspace,
        )

    response_payload = {
        "ok": True,
        "project_id": project.id,
        "project_number": str(project.order_number),
        "production_plan_id": plan.id,
        "production_status": plan.status,
        "uploaded_files": len(saved_photos),
    }
    cache.set(f"public-production:{fingerprint}", response_payload, 600)
    _notify(project)
    return Response(response_payload, status=status.HTTP_201_CREATED)
