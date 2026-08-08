import hashlib
import json
import math
import re
import uuid
from datetime import timedelta

from django.core.cache import cache
from django.db import transaction
from django.utils import timezone
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from .models import CalculatorLead, CalculatorSettings, default_workspace
from .permissions import IsAdmin


def _number(value, fallback=0):
    try:
        result = float(value)
        return result if math.isfinite(result) else fallback
    except (TypeError, ValueError):
        return fallback


def _round_ten(value):
    return math.floor(value / 10 + 0.5) * 10


def _ceil_ten(value):
    return math.ceil(value / 10) * 10


def _ceil_hundred(value):
    return math.ceil(max(0, value) / 100) * 100


def _find(items, item_id, label):
    item = next((row for row in items if str(row.get("id")) == str(item_id)), None)
    if not item:
        raise ValueError(f"Не найдено значение: {label}.")
    return item


def _catalog_settings():
    workspace = default_workspace()
    settings, _ = CalculatorSettings.objects.get_or_create(workspace=workspace)
    shower = settings.shower_catalog if isinstance(settings.shower_catalog, dict) else {}
    mirror = settings.mirror_catalog if isinstance(settings.mirror_catalog, dict) else {}
    if not shower.get("constructions") or not mirror.get("materials"):
        raise ValueError("Публичный калькулятор ещё не настроен администратором.")
    return workspace, settings, shower, mirror


def _price_version(settings):
    return settings.updated_at.astimezone().isoformat(timespec="seconds")


def _public_config(shower, mirror, price_version):
    return {
        "price_version": price_version,
        "shower": {
            "constructions": [
                {
                    "id": item.get("id"),
                    "title": item.get("title"),
                    "shortTitle": item.get("shortTitle"),
                    "fields": [
                        {
                            "key": field.get("key"),
                            "label": field.get("label"),
                            "defaultValue": field.get("defaultValue"),
                        }
                        for field in item.get("fields", [])
                    ],
                }
                for item in shower.get("constructions", [])
            ],
            "glass": [{"id": item.get("id"), "label": item.get("label")} for item in shower.get("glass", [])],
            "hardware": [{"id": item.get("id"), "label": item.get("label")} for item in shower.get("hardware", [])],
            "hardwareClass": [
                {"id": item.get("id"), "label": item.get("label")} for item in shower.get("hardwareClass", [])
            ],
        },
        "mirror": {
            "materials": [{"id": item.get("id"), "label": item.get("label")} for item in mirror.get("materials", [])],
            "services": [
                {"id": item.get("id"), "label": item.get("label")}
                for item in mirror.get("services", [])
                if item.get("category") != "delivery" and item.get("visibleInQuote", True)
            ],
        },
        "delivery": {"insideLabel": "По городу", "outsideLabel": "За городом"},
        "legal": {
            "consent_url": "/privacy",
            "privacy_url": "/privacy",
        },
    }


def _calculate_shower(catalog, config):
    construction = _find(catalog.get("constructions", []), config.get("constructionId"), "тип душевой")
    glass = _find(catalog.get("glass", []), config.get("glassId"), "стекло")
    hardware = _find(catalog.get("hardware", []), config.get("hardwareId"), "фурнитура")
    hardware_class = _find(catalog.get("hardwareClass", []), config.get("hardwareClassId"), "класс фурнитуры")
    dimensions = config.get("dimensions") if isinstance(config.get("dimensions"), dict) else {}
    fields = construction.get("fields", [])
    values = {field.get("key"): _number(dimensions.get(field.get("key"))) for field in fields}
    if any(value <= 0 for value in values.values()):
        raise ValueError("Укажите корректные размеры изделия.")
    height_field = next((field for field in fields if str(field.get("key", "")).startswith("HEIGHT")), None)
    height = values.get(height_field.get("key"), 0) if height_field else 0
    widths = [values.get(field.get("key"), 0) for field in fields if str(field.get("key", "")).startswith("WIDTH")]
    glass_price = sum(round(width / 1000 * height / 1000 * _number(glass.get("price"))) for width in widths)
    hardware_price = _number(hardware_class.get("price")) * _number(hardware.get("price")) / 100
    services = catalog.get("services", {})
    product_markup = 1 + max(0, _number(services.get("productMarkupPercent"))) / 100
    hardware_markup = 1 + max(0, _number(services.get("hardwareMarkupPercent"))) / 100
    base_product = _ceil_ten(
        (glass_price + _number(construction.get("basePrice"))) * product_markup
        + hardware_price * hardware_markup
    )
    if height > _number(services.get("heightSurchargeAfter")):
        base_product = _round_ten(base_product * (1 + _number(services.get("heightSurchargePercent")) / 100))
    installation = _number(construction.get("installationPrice")) if config.get("installation") else 0
    return _ceil_hundred(base_product + installation)


def _calculate_mirror(catalog, config):
    width = _number(config.get("width"))
    height = _number(config.get("height"))
    if width < 100 or height < 100 or width > 4000 or height > 4000:
        raise ValueError("Укажите размеры зеркала от 100 до 4000 мм.")
    material = _find(catalog.get("materials", []), config.get("materialId"), "материал")
    area = width * height / 1_000_000
    perimeter = 2 * (width + height) / 1000
    raw_material = area * _number(material.get("price"))
    raw_work = 0
    for selection in config.get("options", []):
        service = _find(catalog.get("services", []), selection.get("serviceId"), "работа")
        unit = service.get("unit")
        quantity = area if unit == "area" else perimeter if unit == "perimeter" else max(0, _number(selection.get("quantity"), 1))
        raw_work += _number(service.get("price")) * quantity
    settings = catalog.get("settings", {})
    product = raw_material * (1 + max(0, _number(settings.get("materialMarkupPercent"))) / 100)
    works = raw_work * (1 + max(0, _number(settings.get("serviceMarkupPercent"))) / 100)
    return _ceil_hundred(_round_ten(product) + _round_ten(works))


def _delivery_price(catalog, delivery):
    if not delivery.get("enabled"):
        return 0
    services = catalog.get("services", {})
    base = max(0, _number(services.get("deliveryBase")))
    if delivery.get("zone") == "outside":
        base += max(0, _number(delivery.get("km"))) * max(0, _number(services.get("deliveryKmRate")))
    return _ceil_hundred(base)


def _client_ip(request):
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    return (forwarded.split(",")[0] if forwarded else request.META.get("REMOTE_ADDR", "unknown")).strip()


def _rate_limited(request, scope, limit=12, seconds=60):
    key = f"public-calc:{scope}:{_client_ip(request)}"
    try:
        count = cache.incr(key)
    except ValueError:
        cache.set(key, 1, seconds)
        count = 1
    return count > limit


@api_view(["GET"])
@permission_classes([AllowAny])
def public_calculator_config_view(request):
    try:
        _workspace, settings, shower, mirror = _catalog_settings()
        return Response(_public_config(shower, mirror, _price_version(settings)))
    except ValueError as error:
        return Response({"detail": str(error)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)


@api_view(["POST"])
@permission_classes([AllowAny])
def public_calculator_calculate_view(request):
    if _rate_limited(request, "calculate"):
        return Response({"detail": "Слишком много запросов. Попробуйте через минуту."}, status=status.HTTP_429_TOO_MANY_REQUESTS)
    payload = request.data if isinstance(request.data, dict) else {}
    product = payload.get("product")
    config = payload.get("configuration") if isinstance(payload.get("configuration"), dict) else {}
    delivery = payload.get("delivery") if isinstance(payload.get("delivery"), dict) else {}
    try:
        if product not in {"shower", "mirror"}:
            raise ValueError("Выберите тип изделия.")
        _workspace, settings, shower, mirror = _catalog_settings()
        item_amount = _calculate_shower(shower, config) if product == "shower" else _calculate_mirror(mirror, config)
        amount = _ceil_hundred(item_amount + _delivery_price(shower, delivery))
        calculation_id = uuid.uuid4().hex
        price_version = _price_version(settings)
        cache.set(
            f"public-calc:result:{calculation_id}",
            {"product": product, "configuration": config, "delivery": delivery, "amount": amount, "price_version": price_version},
            1800,
        )
        return Response({
            "calculation_id": calculation_id,
            "amount": amount,
            "price_version": price_version,
            "message": "Точная стоимость подтверждается менеджером после уточнения деталей.",
        })
    except ValueError as error:
        return Response({"detail": str(error)}, status=status.HTTP_400_BAD_REQUEST)


@api_view(["POST"])
@permission_classes([AllowAny])
def public_calculator_lead_view(request):
    if _rate_limited(request, "lead", limit=5, seconds=600):
        return Response({"detail": "Слишком много отправок. Попробуйте позже."}, status=status.HTTP_429_TOO_MANY_REQUESTS)
    payload = request.data if isinstance(request.data, dict) else {}
    if str(payload.get("company", "")).strip():
        return Response({"ok": True}, status=status.HTTP_201_CREATED)
    calculation_id = str(payload.get("calculation_id", "")).strip()
    calculation = cache.get(f"public-calc:result:{calculation_id}")
    if not calculation:
        return Response({"detail": "Расчёт устарел. Рассчитайте стоимость ещё раз."}, status=status.HTTP_400_BAD_REQUEST)
    name = str(payload.get("name", "")).strip()[:200]
    phone = re.sub(r"[^0-9+]", "", str(payload.get("phone", "")))[:50]
    email = str(payload.get("email", "")).strip()[:254]
    if len(name) < 2 or len(re.sub(r"\D", "", phone)) < 10:
        return Response({"detail": "Укажите имя и корректный номер телефона."}, status=status.HTTP_400_BAD_REQUEST)
    fingerprint = hashlib.sha256(json.dumps(calculation, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
    workspace = default_workspace()
    duplicate = CalculatorLead.objects.filter(
        workspace=workspace,
        client_phone=phone,
        created_at__gte=timezone.now() - timedelta(minutes=10),
        configuration__fingerprint=fingerprint,
    ).first()
    if duplicate:
        return Response({"ok": True, "lead_id": duplicate.id, "duplicate": True})
    source = payload.get("source") if isinstance(payload.get("source"), dict) else {}
    configuration = {**calculation["configuration"], "delivery": calculation["delivery"], "fingerprint": fingerprint}
    with transaction.atomic():
        lead, _ = CalculatorLead.objects.get_or_create(
            calculation_id=calculation_id,
            defaults={
                "workspace": workspace,
                "client_name": name,
                "client_phone": phone,
                "client_email": email,
                "product": calculation["product"],
                "configuration": configuration,
                "amount": calculation["amount"],
                "price_version": calculation["price_version"],
                "source_url": str(source.get("url", ""))[:1000],
                "referrer": str(source.get("referrer", ""))[:1000],
                "utm": source.get("utm") if isinstance(source.get("utm"), dict) else {},
            },
        )
    return Response({"ok": True, "lead_id": lead.id}, status=status.HTTP_201_CREATED)


@api_view(["GET"])
@permission_classes([IsAdmin])
def calculator_leads_view(request):
    leads = CalculatorLead.objects.filter(workspace=request.user.workspace).order_by("-created_at")[:500]
    return Response([
        {
            "id": lead.id,
            "calculation_id": lead.calculation_id,
            "client_name": lead.client_name,
            "client_phone": lead.client_phone,
            "client_email": lead.client_email,
            "product": lead.product,
            "configuration": lead.configuration,
            "amount": str(lead.amount),
            "price_version": lead.price_version,
            "source_url": lead.source_url,
            "utm": lead.utm,
            "status": lead.status,
            "created_at": lead.created_at,
        }
        for lead in leads
    ])


@api_view(["PATCH"])
@permission_classes([IsAdmin])
def calculator_lead_detail_view(request, lead_id):
    lead = CalculatorLead.objects.filter(workspace=request.user.workspace, id=lead_id).first()
    if not lead:
        return Response({"detail": "Заявка не найдена."}, status=status.HTTP_404_NOT_FOUND)
    next_status = request.data.get("status")
    if next_status not in CalculatorLead.Status.values:
        return Response({"detail": "Некорректный статус."}, status=status.HTTP_400_BAD_REQUEST)
    lead.status = next_status
    lead.save(update_fields=["status", "updated_at"])
    return Response({"id": lead.id, "status": lead.status})
