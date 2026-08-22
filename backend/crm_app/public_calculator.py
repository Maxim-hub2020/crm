import hashlib
import json
import logging
import math
import re
import uuid
from datetime import timedelta
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from django.conf import settings
from django.core.cache import cache
from django.db import transaction
from django.utils import timezone
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

from .models import CalculatorLead, CalculatorQuote, CalculatorSettings, default_workspace
from .permissions import IsAdmin


logger = logging.getLogger(__name__)


def _number(value, fallback=0):
    try:
        result = float(value)
        return result if math.isfinite(result) else fallback
    except (TypeError, ValueError):
        return fallback


def _round_ten(value):
    return math.floor(value / 10 + 0.5) * 10


def _round_integer(value):
    return math.floor(value + 0.5)


def _ceil_ten(value):
    return math.ceil(value / 10) * 10


def _ceil_hundred(value):
    return math.ceil(max(0, value) / 100) * 100


def _find(items, item_id, label):
    item = next((row for row in items if str(row.get("id")) == str(item_id)), None)
    if not item:
        raise ValueError(f"Не найдено значение: {label}.")
    return item


def _hardware_glass_thickness(component, item):
    explicit = int(_number(component.get("glassThickness")))
    if explicit in (6, 8):
        return explicit

    label = str(item.get("label") or "").lower().replace("ё", "е")
    paired = bool(re.search(r"(?:^|\D)6\s*(?:/|\\|,|\+|-|и)\s*8\s*мм(?:$|\D)", label))
    supports_6 = paired or bool(re.search(r"(?:^|\D)6\s*мм(?:$|\D)", label))
    supports_8 = paired or bool(re.search(r"(?:^|\D)8\s*мм(?:$|\D)", label))
    if supports_6 == supports_8:
        return None
    return 6 if supports_6 else 8


def _construction_hardware_price(catalog, construction, glass):
    selected_thickness = int(_number(glass.get("thickness")))
    hardware_items = {
        str(item.get("id")): item
        for item in catalog.get("hardwareItems", [])
        if item.get("id")
    }
    components = []
    for component in construction.get("hardwareComponents", []):
        item = hardware_items.get(str(component.get("hardwareItemId")))
        if not item:
            continue
        compatible_thickness = _hardware_glass_thickness(component, item)
        if selected_thickness in (6, 8) and compatible_thickness and compatible_thickness != selected_thickness:
            continue
        quantity = max(0, _number(component.get("quantity")))
        components.append(_number(item.get("price")) * quantity)
    return sum(components), bool(components)


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
        "delivery": {"insideLabel": "По г. Ростов-на-Дону", "outsideLabel": "За городом"},
        "legal": {
            "consent_url": "https://amalgama.cehcrm.ru/#privacy",
            "privacy_url": "https://amalgama.cehcrm.ru/#privacy",
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
    glass_price = sum(_round_integer(width / 1000 * height / 1000 * _number(glass.get("price"))) for width in widths)
    hardware_base_price, has_hardware_composition = _construction_hardware_price(catalog, construction, glass)
    fallback_construction_base = 0 if has_hardware_composition else max(0, _number(construction.get("basePrice")))
    hardware_class_factor = 1 + max(0, _number(hardware_class.get("price"))) / 100
    hardware_color_factor = 1 + max(0, _number(hardware.get("price"))) / 100
    hardware_price = hardware_base_price * hardware_class_factor * hardware_color_factor
    services = catalog.get("services", {})
    product_markup = 1 + max(0, _number(services.get("productMarkupPercent"))) / 100
    hardware_markup = 1 + max(0, _number(services.get("hardwareMarkupPercent"))) / 100
    base_product = _ceil_ten(
        (glass_price + fallback_construction_base) * product_markup
        + hardware_price * hardware_markup
    )
    if height > _number(services.get("heightSurchargeAfter")):
        base_product = _round_ten(base_product * (1 + _number(services.get("heightSurchargePercent")) / 100))
    base_installation = _number(construction.get("installationPrice")) if config.get("installation") else 0
    designer_factor = 1
    if config.get("designerEnabled"):
        designer_factor += max(0, _number(services.get("designerPercent"))) / 100
    product = _round_ten(base_product * designer_factor)
    installation = _round_ten(base_installation * designer_factor)
    subtotal = _ceil_hundred(product + installation)
    if not config.get("discountEnabled"):
        return subtotal
    discount_percent = min(100, max(0, _number(config.get("discountPercent"))))
    return _ceil_hundred(subtotal * (1 - discount_percent / 100))


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


def _quote_result(product, delivery=0, glass_area=0):
    product = max(0, _number(product))
    delivery = max(0, _number(delivery))
    total = product + delivery
    return {
        "product": product,
        "installation": 0,
        "delivery": delivery,
        "manager": 0,
        "designer": 0,
        "subtotal": total,
        "discount": 0,
        "total": total,
        "glassArea": max(0, _number(glass_area)),
        "hardwarePrice": 0,
        "hasSurcharge": False,
        "errors": {},
        "lines": [
            {"label": "Стоимость изделия", "value": product},
            {"label": "Доставка", "value": delivery},
        ],
    }


def _quote_delivery(delivery):
    return {
        "enabled": bool(delivery.get("enabled")),
        "zone": "outside" if delivery.get("zone") == "outside" else "inside",
        "km": max(0, _number(delivery.get("km"))),
    }


def _mirror_option_quantity(config, service, selection):
    width = _number(config.get("width"))
    height = _number(config.get("height"))
    if service.get("unit") == "area":
        return width * height / 1_000_000
    if service.get("unit") == "perimeter":
        return 2 * (width + height) / 1000
    return max(0, _number(selection.get("quantity"), 1))


def _build_public_quote_item(calculation_id, calculation, shower, mirror):
    config = calculation["configuration"]
    item_amount = calculation["item_amount"]
    item_id = f"{calculation_id}-item"

    if calculation["product"] == "shower":
        construction = _find(shower.get("constructions", []), config.get("constructionId"), "тип душевой")
        glass = _find(shower.get("glass", []), config.get("glassId"), "стекло")
        hardware = _find(shower.get("hardware", []), config.get("hardwareId"), "фурнитура")
        hardware_class = _find(shower.get("hardwareClass", []), config.get("hardwareClassId"), "класс фурнитуры")
        dimensions = config.get("dimensions") if isinstance(config.get("dimensions"), dict) else {}
        details = [
            {
                "id": f"{item_id}:dimension:{field.get('key')}",
                "label": str(field.get("label") or "Размер"),
                "value": f"{_number(dimensions.get(field.get('key'))):g} мм",
            }
            for field in construction.get("fields", [])
        ]
        details.extend([
            {"id": f"{item_id}:glass", "label": "Стекло", "value": str(glass.get("label") or "")},
            {"id": f"{item_id}:hardware", "label": "Фурнитура", "value": str(hardware.get("label") or "")},
            {
                "id": f"{item_id}:hardware-class",
                "label": "Класс фурнитуры",
                "value": str(hardware_class.get("label") or ""),
            },
        ])
        return {
            "id": item_id,
            "kind": "shower",
            "quantity": 1,
            "form": {
                "constructionId": config.get("constructionId"),
                "dimensions": dimensions,
                "glassId": config.get("glassId"),
                "hardwareId": config.get("hardwareId"),
                "hardwareClassId": config.get("hardwareClassId"),
                "installation": bool(config.get("installation")),
                "delivery": False,
                "deliveryZone": "inside",
                "deliveryKm": 0,
                "discountEnabled": False,
                "discountPercent": 0,
                "designerEnabled": False,
                "clientName": "",
                "clientPhone": "",
                "note": "",
            },
            "result": _quote_result(item_amount),
            "constructionTitle": str(construction.get("title") or construction.get("shortTitle") or "Душевая"),
            "glassLabel": str(glass.get("label") or ""),
            "hardwareLabel": str(hardware.get("label") or ""),
            "hardwareClassLabel": str(hardware_class.get("label") or ""),
            "details": details,
        }

    material = _find(mirror.get("materials", []), config.get("materialId"), "материал")
    selections = config.get("options") if isinstance(config.get("options"), list) else []
    service_lines = []
    details = [
        {
            "id": f"{item_id}:size",
            "label": "Размер",
            "value": f"{_number(config.get('width')):g} × {_number(config.get('height')):g} мм",
        },
        {"id": f"{item_id}:material", "label": "Материал", "value": str(material.get("label") or "")},
    ]
    unit_labels = {"piece": "шт.", "area": "м²", "perimeter": "м.п."}
    for index, selection in enumerate(selections):
        if not isinstance(selection, dict):
            continue
        service = _find(mirror.get("services", []), selection.get("serviceId"), "работа")
        unit = service.get("unit") if service.get("unit") in unit_labels else "piece"
        visible = bool(service.get("visibleInQuote", True)) and service.get("category") != "delivery"
        service_lines.append({
            "label": str(service.get("label") or "Работа"),
            "quantity": _mirror_option_quantity(config, service, selection),
            "unit": unit,
            "unitLabel": unit_labels[unit],
            "visibleInQuote": visible,
        })
        if visible:
            details.append({
                "id": f"{item_id}:service:{index}",
                "label": str(service.get("label") or "Работа"),
                "value": "Включено",
            })

    width = _number(config.get("width"))
    height = _number(config.get("height"))
    return {
        "id": item_id,
        "kind": "mirror",
        "quantity": 1,
        "form": {
            "width": width,
            "height": height,
            "materialId": config.get("materialId"),
            "options": selections,
            "managerEnabled": False,
            "discountEnabled": False,
            "discountPercent": 0,
            "designerEnabled": False,
            "clientName": "",
            "clientPhone": "",
            "note": "",
        },
        "result": _quote_result(item_amount, glass_area=width * height / 1_000_000),
        "mirrorTitle": f"Зеркало {width:g} × {height:g} мм",
        "materialLabel": str(material.get("label") or ""),
        "serviceLines": service_lines,
        "details": details,
    }


def _next_quote_number(workspace):
    used_numbers = [
        int(number)
        for number in CalculatorQuote.objects.filter(workspace=workspace).values_list("number", flat=True)
        if re.fullmatch(r"\d{4}", str(number or ""))
    ]
    next_number = max(used_numbers, default=1000) + 1
    if next_number > 9999:
        raise ValueError("Закончились доступные четырёхзначные номера КП.")
    return str(next_number)


def _build_public_quote_payload(calculation_id, calculation, shower, mirror, lead, number, created_at):
    item = _build_public_quote_item(calculation_id, calculation, shower, mirror)
    delivery = _quote_delivery(calculation["delivery"])
    payload = {
        **item,
        "id": f"public-{calculation_id}",
        "number": number,
        "createdAt": created_at.isoformat(),
        "status": "new",
        "result": _quote_result(calculation["item_amount"], calculation["delivery_amount"]),
        "items": [item],
        "orderDelivery": delivery,
        "customer": {
            "clientName": lead.client_name,
            "clientPhone": lead.client_phone,
            "note": "Расчёт с корпоративного сайта",
        },
    }
    return payload


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


def _notify_calculator_lead(lead, quote=None):
    notifier_url = str(getattr(settings, "CALCULATOR_NOTIFIER_URL", "")).strip()
    if not notifier_url:
        return

    amount = f"{lead.amount:,.0f} ₽".replace(",", " ")
    payload = json.dumps(
        {
            "name": lead.client_name,
            "phone": lead.client_phone,
            "product": lead.product,
            "amount": amount,
            "message": (
                f"КП №{quote.number} сохранено в архиве калькулятора."
                if quote
                else f"Расчёт №{lead.calculation_id[:8].upper()} сохранён в CRM."
            ),
        },
        ensure_ascii=False,
    ).encode("utf-8")
    request = Request(
        notifier_url,
        data=payload,
        method="POST",
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    try:
        with urlopen(request, timeout=6) as response:
            if response.status < 200 or response.status >= 300:
                raise RuntimeError(f"notifier returned {response.status}")
    except (HTTPError, URLError, TimeoutError, RuntimeError):
        logger.exception("calculator_lead_notification_failed lead_id=%s", lead.id)


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
        delivery_amount = _delivery_price(shower, delivery)
        amount = _ceil_hundred(item_amount + delivery_amount)
        calculation_id = uuid.uuid4().hex
        price_version = _price_version(settings)
        cache.set(
            f"public-calc:result:{calculation_id}",
            {
                "product": product,
                "configuration": config,
                "delivery": delivery,
                "item_amount": item_amount,
                "delivery_amount": delivery_amount,
                "amount": amount,
                "price_version": price_version,
            },
            1800,
        )
        return Response({
            "calculation_id": calculation_id,
            "amount": amount,
            "price_version": price_version,
            "message": (
                "Это расчётная стоимость, максимально близкая к окончательной. "
                "Если параметры указаны верно, после проверки и замера сумма обычно меняется не более чем на ±10%."
            ),
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
    quote = None
    with transaction.atomic():
        lead, created = CalculatorLead.objects.get_or_create(
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
        if created:
            settings_record = CalculatorSettings.objects.select_for_update().get(workspace=workspace)
            shower = settings_record.shower_catalog if isinstance(settings_record.shower_catalog, dict) else {}
            mirror = settings_record.mirror_catalog if isinstance(settings_record.mirror_catalog, dict) else {}
            quote_number = _next_quote_number(workspace)
            quote_created_at = timezone.now()
            quote_payload = _build_public_quote_payload(
                calculation_id,
                calculation,
                shower,
                mirror,
                lead,
                quote_number,
                quote_created_at,
            )
            quote = CalculatorQuote.objects.create(
                workspace=workspace,
                quote_id=quote_payload["id"],
                number=quote_number,
                payload=quote_payload,
                quote_created_at=quote_created_at,
            )
    if created:
        _notify_calculator_lead(lead, quote)
    response_payload = {"ok": True, "lead_id": lead.id}
    if quote:
        response_payload.update({"quote_id": quote.quote_id, "quote_number": quote.number})
    return Response(response_payload, status=status.HTTP_201_CREATED)


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
