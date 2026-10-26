import json
import hmac
import logging
import os
import re
import uuid
from decimal import Decimal, InvalidOperation
from io import BytesIO
from urllib.parse import urlencode

from django.core.files.storage import default_storage
from django.db import transaction
from django.db.models import CharField, F, Q, Value
from django.db.models.functions import Cast, Replace
from django.http import FileResponse
from django.shortcuts import redirect
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime
from django.utils.text import get_valid_filename
from rest_framework import viewsets
from rest_framework.decorators import action, api_view, parser_classes, permission_classes
from rest_framework.exceptions import ValidationError
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework import status as drf_status

from .bonuses import ensure_project_bonus_accrual, preview_project_bonus_promo_code, reverse_project_bonus_effects
from .dadata import dadata_api_key, dadata_default_region, suggest_dadata_address
from .finance_analytics import (
    build_cash_forecast,
    build_finance_overview,
    build_project_finance_analytics,
)
from .models import (
    Account,
    AuditLog,
    CalculatorQuote,
    CalculatorSettings,
    ChatIntegrationSettings,
    Client,
    ClientBonusTransaction,
    DocumentTemplate,
    FinanceCategory,
    Payment,
    MeasurementPhoto,
    MeasurementScanSession,
    MeasurementSheet,
    Project,
    ProjectComment,
    ProjectCustomField,
    ProjectStatus,
    ProductionPlan,
    Task,
    TaskTemplate,
    User,
    YandexDiskSettings,
)
from .permissions import IsAdmin, IsAuthenticatedAny
from .phones import phone_search_digits
from .serializers import (
    AdminUserSerializer,
    AccountSerializer,
    AuditLogSerializer,
    CalculatorQuoteSyncSerializer,
    CalculatorSettingsSerializer,
    ChatIntegrationSettingsSerializer,
    ClientBonusTransactionSerializer,
    ClientSerializer,
    DocumentTemplateSerializer,
    FinanceCategorySerializer,
    MeSerializer,
    PaymentSerializer,
    MeasurementSheetSerializer,
    MeasurementScanSessionSerializer,
    ProjectCommentSerializer,
    ProjectCustomFieldSerializer,
    ProjectStatusSerializer,
    ProjectSerializer,
    ProductionPlanSerializer,
    TaskSerializer,
    TaskTemplateSerializer,
    YandexDiskSettingsSerializer,
)
from .tenancy import current_workspace
from .workflow import apply_task_templates_for_project, build_project_status_check, create_audit_log, snapshot_model, user_display_name
from .yandex_disk import (
    YandexDiskError,
    archive_project_disk_folder,
    build_yandex_disk_authorization_url,
    connect_yandex_disk_with_code,
    connect_yandex_disk_with_manual_code,
    ensure_project_disk_folder,
    is_application_project_status,
    is_archive_project_status,
    list_disk_folders,
    set_project_folder_public,
    sync_measurement_drawings_to_yandex,
    sync_project_measurement_files_to_yandex,
    yandex_disk_oauth_configured,
    yandex_disk_redirect_uri,
)

logger = logging.getLogger(__name__)

MENU_SECTION_KEYS = {
    "dashboard",
    "calculator",
    "chats",
    "finances",
    "tasks",
    "clients",
    "requests",
}


def phone_digits_expression(field_name):
    expression = F(field_name)
    for char in ("+", "-", " ", "(", ")"):
        expression = Replace(expression, Value(char), Value(""))
    return expression


def json_contains_text(value, query):
    return str(query or "").casefold() in json.dumps(value or {}, ensure_ascii=False, default=str).casefold()


def project_custom_file_name(project, field, original_name, index):
    extension = os.path.splitext(str(original_name or ""))[1].lower()
    if not re.fullmatch(r"\.[a-zа-яё0-9]{1,10}", extension, flags=re.IGNORECASE):
        extension = ""
    field_name = re.sub(r'[\\/:*?"<>|]+', "-", str(getattr(field, "name", "") or "Файл"))
    field_name = re.sub(r"\s+", " ", field_name).strip(" .-") or "Файл"
    project_name = re.sub(
        r'[\\/:*?"<>|]+',
        "-",
        str(getattr(project, "title", "") or getattr(project, "client_name", "") or f"Проект {project.pk}"),
    )
    project_name = re.sub(r"\s+", " ", project_name).strip(" .-") or f"Проект {project.pk}"
    base_name = f"{field_name} — {project_name} — лист {index:02d}"
    return f"{base_name[: max(1, 240 - len(extension))].rstrip()}{extension}"


def _request_params(request):
    return request.data if request.method == "POST" else request.query_params


def _visible_finance_projects(user):
    workspace = current_workspace(user)
    application_names = {"заявка", "заявки", "application", "applications", "lead", "leads"}
    application_codes = set(application_names)
    for status in ProjectStatus.objects.filter(workspace=workspace).only("code", "name"):
        if str(status.code or "").strip().casefold() in application_names or str(status.name or "").strip().casefold() in application_names:
            application_codes.add(status.code)

    queryset = Project.objects.filter(workspace=workspace).exclude(status__in=application_codes)
    if user.is_admin():
        return queryset
    return queryset.filter(manager=user)


def _visible_payments(user):
    workspace = current_workspace(user)
    queryset = Payment.objects.filter(
        Q(project__workspace=workspace)
        | Q(project__isnull=True, created_by__workspace=workspace)
    )
    if user.is_admin():
        return queryset
    return queryset.filter(
        Q(project__manager=user)
        | Q(project__isnull=True, created_by=user)
    )


def _finance_scope(request):
    params = _request_params(request)
    project_queryset = _visible_finance_projects(request.user)
    project_id = str(params.get("project") or params.get("project_id") or "").strip()
    payment_queryset = _visible_payments(request.user).filter(
        Q(project__isnull=True) | Q(project_id__in=project_queryset.values("id"))
    )
    if project_id and project_id != "all":
        project_queryset = project_queryset.filter(id=project_id)
        payment_queryset = payment_queryset.filter(project_id=project_id)

    operation_kind = str(params.get("kind") or params.get("category_kind") or "").strip()
    if operation_kind in FinanceCategory.Type.values:
        payment_queryset = payment_queryset.filter(category__type=operation_kind)

    category_id = str(params.get("category") or "").strip()
    if category_id and category_id != "all":
        payment_queryset = payment_queryset.filter(category_id=category_id)

    account_id = str(params.get("account") or "").strip()
    if account_id and account_id != "all":
        payment_queryset = payment_queryset.filter(
            Q(account_id=account_id) | Q(destination_account_id=account_id)
        )

    date_from = parse_date(str(params.get("date_from") or "").strip())
    if date_from:
        payment_queryset = payment_queryset.filter(paid_at__date__gte=date_from)

    date_to = parse_date(str(params.get("date_to") or "").strip())
    if date_to:
        payment_queryset = payment_queryset.filter(paid_at__date__lte=date_to)

    amount_from = str(params.get("amount_from") or "").strip().replace(" ", "").replace(",", ".")
    if amount_from:
        payment_queryset = payment_queryset.filter(amount__gte=amount_from)

    amount_to = str(params.get("amount_to") or "").strip().replace(" ", "").replace(",", ".")
    if amount_to:
        payment_queryset = payment_queryset.filter(amount__lte=amount_to)

    search = str(params.get("search") or "").strip()
    if search:
        payment_queryset = payment_queryset.filter(
            Q(project__title__icontains=search)
            | Q(project__client_name__icontains=search)
            | Q(project__client_phone__icontains=search)
            | Q(project__object_address__icontains=search)
            | Q(comment__icontains=search)
            | Q(category__name__icontains=search)
            | Q(account__name__icontains=search)
            | Q(destination_account__name__icontains=search)
        )

    has_payment_filters = any(
        [
            search,
            operation_kind in FinanceCategory.Type.values,
            category_id and category_id != "all",
            account_id and account_id != "all",
            date_from,
            date_to,
            amount_from,
            amount_to,
        ]
    )
    if has_payment_filters and not (project_id and project_id != "all"):
        project_queryset = project_queryset.filter(id__in=payment_queryset.values("project_id"))

    filters = {
        "project": project_id or "all",
        "kind": operation_kind or "all",
        "category": category_id or "all",
        "account": account_id or "all",
        "date_from": date_from.isoformat() if date_from else "",
        "date_to": date_to.isoformat() if date_to else "",
        "amount_from": amount_from,
        "amount_to": amount_to,
        "search": search,
    }
    return project_queryset, payment_queryset, filters


def _project_result(project, score_label="Проект"):
    return {
        "type": "project",
        "id": project.id,
        "project_id": project.id,
        "title": f"№{project.order_number:04d} · {project.title or project.client_name}" if project.order_number else project.title or project.client_name,
        "subtitle": " · ".join([value for value in [project.client_name, project.client_phone, project.object_address] if value]),
        "route": "/projects",
        "tab": "comments",
        "label": score_label,
    }


def _client_result(client):
    return {
        "type": "client",
        "id": client.id,
        "client_id": client.id,
        "title": client.name,
        "subtitle": " · ".join([value for value in [client.phone, client.address] if value]),
        "route": "/clients",
        "label": "Клиент",
    }


def _task_result(task):
    return {
        "type": "task",
        "id": task.id,
        "project_id": task.project_id,
        "title": task.title,
        "subtitle": " · ".join([value for value in [getattr(task.project, "title", ""), task.due_date.isoformat() if task.due_date else ""] if value]),
        "route": "/projects" if task.project_id else "/tasks",
        "tab": "tasks",
        "label": "Задача",
    }


def _payment_result(payment):
    title = (
        "Корректировка баланса"
        if payment.operation_kind == Payment.OperationKind.BALANCE_ADJUSTMENT
        else "Перевод между счетами"
        if payment.operation_kind == Payment.OperationKind.ACCOUNT_TRANSFER
        else getattr(payment.category, "name", "") or "Операция"
    )
    account_route = (
        f"{getattr(payment.account, 'name', '')} → {getattr(payment.destination_account, 'name', '')}"
        if payment.operation_kind == Payment.OperationKind.ACCOUNT_TRANSFER
        else ""
    )
    return {
        "type": "payment",
        "id": payment.id,
        "project_id": payment.project_id,
        "title": f"{title} · {payment.amount} ₽",
        "subtitle": " · ".join([value for value in [account_route, getattr(payment.project, "title", ""), payment.comment] if value]),
        "route": "/projects" if payment.project_id else "/finances",
        "tab": "finances",
        "label": "Финансы",
    }


def _comment_result(comment):
    text = (comment.text or "").strip()
    return {
        "type": "comment",
        "id": comment.id,
        "project_id": comment.project_id,
        "title": text[:80] or "Комментарий",
        "subtitle": getattr(comment.project, "title", "") or getattr(comment.project, "client_name", ""),
        "route": "/projects",
        "tab": "comments",
        "label": "Комментарий",
    }


def _calculator_quote_result(quote):
    from .calculator_leads import quote_summary

    payload = quote.payload if isinstance(quote.payload, dict) else {}
    customer = payload.get("customer") if isinstance(payload.get("customer"), dict) else {}
    if not customer and isinstance(payload.get("form"), dict):
        customer = payload["form"]
    amount, summary = quote_summary(payload)
    item_titles = [str(item.get("title") or "").strip() for item in summary["items"] if item.get("title")]
    quote_number = quote.number or quote.quote_id[:8]
    title = f"КП №{quote_number}"
    if item_titles:
        title += f" · {item_titles[0]}" if len(set(item_titles)) == 1 else f" · {len(item_titles)} позиций"
    subtitle = " · ".join(
        value
        for value in [
            str(customer.get("clientName") or "").strip(),
            str(customer.get("clientPhone") or "").strip(),
            f"{amount} ₽" if amount is not None else "",
            getattr(quote.project, "title", "") if quote.project_id else "",
        ]
        if value
    )
    return {
        "type": "calculator_quote",
        "id": quote.quote_id,
        "title": title,
        "subtitle": subtitle,
        "route": f"/calculator?{urlencode({'quote': quote.quote_id})}",
        "label": "КП",
    }


def _project_activity_payload(project):
    events = []

    for comment in project.comments.select_related("author").order_by("-created_at")[:30]:
        events.append(
            {
                "type": "comment",
                "title": "Комментарий",
                "description": comment.text,
                "actor_name": user_display_name(comment.author),
                "created_at": comment.created_at.isoformat(),
            }
        )

    for task in project.tasks.select_related("created_by", "assignee").order_by("-created_at")[:30]:
        events.append(
            {
                "type": "task",
                "title": "Задача создана" if task.status != Task.Status.DONE else "Задача выполнена",
                "description": task.title,
                "actor_name": user_display_name(task.created_by),
                "created_at": task.updated_at.isoformat() if task.status == Task.Status.DONE else task.created_at.isoformat(),
            }
        )

    for payment in project.payments.select_related("created_by", "category").order_by("-created_at")[:30]:
        category_name = getattr(payment.category, "name", "") or "Операция"
        events.append(
            {
                "type": "payment",
                "title": category_name,
                "description": f"{payment.amount} ₽ · {payment.comment or 'без комментария'}",
                "actor_name": user_display_name(payment.created_by),
                "created_at": payment.created_at.isoformat(),
            }
        )

    for bonus in project.bonus_transactions.select_related("created_by", "client").order_by("-created_at")[:20]:
        events.append(
            {
                "type": "bonus",
                "title": "Бонусная операция",
                "description": f"{bonus.amount} ₽ · {bonus.comment or bonus.get_type_display()}",
                "actor_name": user_display_name(bonus.created_by),
                "created_at": bonus.created_at.isoformat(),
            }
        )

    for log in AuditLog.objects.select_related("actor").filter(
        workspace=project.workspace,
        entity_type="project",
        entity_id=str(project.id),
    ).order_by("-created_at")[:30]:
        events.append(
            {
                "type": "audit",
                "title": f"Изменение: {log.action}",
                "description": "",
                "actor_name": user_display_name(log.actor),
                "created_at": log.created_at.isoformat(),
            }
        )

    return sorted(events, key=lambda item: item["created_at"], reverse=True)[:80]


@api_view(["GET"])
@permission_classes([IsAuthenticatedAny])
def me_view(request):
    return Response(MeSerializer(request.user).data)


@api_view(["GET", "PATCH"])
@permission_classes([IsAuthenticatedAny])
def menu_settings_view(request):
    workspace = current_workspace(request.user)

    if request.method == "GET":
        return Response({
            "hidden_sections": list(workspace.hidden_menu_sections or []),
            "projects_view_mode": workspace.projects_view_mode or "kanban",
        })

    if not request.user.is_admin():
        return Response(
            {"detail": "Видимость разделов может менять только администратор."},
            status=drf_status.HTTP_403_FORBIDDEN,
        )

    update_fields = ["updated_at"]
    if "hidden_sections" in request.data:
        hidden_sections = request.data.get("hidden_sections")
        if not isinstance(hidden_sections, list):
            return Response(
                {"hidden_sections": ["Ожидается список разделов."]},
                status=drf_status.HTTP_400_BAD_REQUEST,
            )
        workspace.hidden_menu_sections = sorted(
            {str(section).strip() for section in hidden_sections if str(section).strip() in MENU_SECTION_KEYS}
        )
        update_fields.append("hidden_menu_sections")

    if "projects_view_mode" in request.data:
        projects_view_mode = str(request.data.get("projects_view_mode") or "").strip()
        if projects_view_mode not in {"kanban", "list"}:
            return Response(
                {"projects_view_mode": ["Допустимые значения: kanban или list."]},
                status=drf_status.HTTP_400_BAD_REQUEST,
            )
        workspace.projects_view_mode = projects_view_mode
        update_fields.append("projects_view_mode")

    workspace.save(update_fields=update_fields)
    return Response({
        "hidden_sections": workspace.hidden_menu_sections,
        "projects_view_mode": workspace.projects_view_mode,
    })


@api_view(["GET"])
@permission_classes([])
def health_view(_request):
    return Response({"status": "ok"})


@api_view(["POST"])
@permission_classes([IsAuthenticatedAny])
def bonus_promo_preview_view(request):
    try:
        preview = preview_project_bonus_promo_code(
            workspace=current_workspace(request.user),
            promo_code=request.data.get("bonus_promo_code") or request.data.get("promo_code"),
            total_amount=request.data.get("total_amount"),
            exclude_client_id=request.data.get("client") or request.data.get("client_id") or None,
            exclude_phone=request.data.get("client_phone") or "",
        )
    except ValidationError as exc:
        detail = getattr(exc, "detail", None)
        if isinstance(detail, dict):
            return Response(detail, status=drf_status.HTTP_400_BAD_REQUEST)
        if isinstance(detail, list) and detail:
            return Response({"detail": str(detail[0])}, status=drf_status.HTTP_400_BAD_REQUEST)
        return Response({"detail": str(exc)}, status=drf_status.HTTP_400_BAD_REQUEST)

    return Response(preview)


@api_view(["GET", "PATCH"])
@permission_classes([IsAuthenticatedAny])
def chat_settings_view(request):
    workspace = current_workspace(request.user)
    settings, _created = ChatIntegrationSettings.objects.get_or_create(workspace=workspace)

    if request.method == "GET":
        return Response(ChatIntegrationSettingsSerializer(settings).data)

    if not request.user.is_admin():
        return Response({"detail": "Настройки чатов может менять только администратор."}, status=drf_status.HTTP_403_FORBIDDEN)

    serializer = ChatIntegrationSettingsSerializer(settings, data=request.data, partial=True)
    serializer.is_valid(raise_exception=True)
    serializer.save(updated_by=request.user)
    return Response(serializer.data)


@api_view(["GET", "PATCH"])
@permission_classes([IsAuthenticatedAny])
def yandex_disk_settings_view(request):
    workspace = current_workspace(request.user)
    settings, _created = YandexDiskSettings.objects.get_or_create(workspace=workspace)

    if request.method == "GET":
        data = YandexDiskSettingsSerializer(settings).data
        data["oauth_configured"] = yandex_disk_oauth_configured()
        data["oauth_redirect_uri"] = yandex_disk_redirect_uri(request)
        return Response(data)

    if not request.user.is_admin():
        return Response({"detail": "Настройки Яндекс.Диска может менять только администратор."}, status=drf_status.HTTP_403_FORBIDDEN)

    serializer = YandexDiskSettingsSerializer(settings, data=request.data, partial=True)
    serializer.is_valid(raise_exception=True)
    serializer.save(updated_by=request.user)
    return Response(serializer.data)


@api_view(["GET", "PATCH"])
@permission_classes([IsAuthenticatedAny])
def calculator_settings_view(request):
    workspace = current_workspace(request.user)
    settings, _created = CalculatorSettings.objects.get_or_create(workspace=workspace)

    if request.method == "GET":
        return Response(CalculatorSettingsSerializer(settings).data)

    if not request.user.is_admin():
        return Response(
            {"detail": "Настройки калькулятора может менять только администратор."},
            status=drf_status.HTTP_403_FORBIDDEN,
        )

    serializer = CalculatorSettingsSerializer(settings, data=request.data, partial=True)
    serializer.is_valid(raise_exception=True)
    serializer.save(updated_by=request.user)
    return Response(serializer.data)


def _calculator_quote_payloads(workspace):
    payloads = []
    records = CalculatorQuote.objects.filter(workspace=workspace, lead_deleted=False).order_by("-quote_created_at", "-id")
    for record in records:
        payload = dict(record.payload)
        payload.setdefault("updatedAt", record.updated_at.isoformat())
        payloads.append(payload)
    return payloads


def _calculator_quote_updated_at(payload):
    value = parse_datetime(str(payload.get("updatedAt") or ""))
    if value and timezone.is_naive(value):
        return timezone.make_aware(value)
    return value


@api_view(["GET", "POST"])
@permission_classes([IsAuthenticatedAny])
def calculator_quotes_view(request):
    from .calculator_leads import sync_quote_lead
    workspace = current_workspace(request.user)

    if request.method == "GET":
        return Response({"quotes": _calculator_quote_payloads(workspace)})

    if not request.user.is_admin():
        return Response(
            {"detail": "Архив КП может изменять только администратор."},
            status=drf_status.HTTP_403_FORBIDDEN,
        )

    serializer = CalculatorQuoteSyncSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    with transaction.atomic():
        for payload in serializer.validated_data["quotes"]:
            quote_id = str(payload["id"]).strip()
            quote_created_at = parse_datetime(str(payload.get("createdAt") or ""))
            if quote_created_at and timezone.is_naive(quote_created_at):
                quote_created_at = timezone.make_aware(quote_created_at)
            record, created = CalculatorQuote.objects.select_for_update().get_or_create(
                workspace=workspace,
                quote_id=quote_id,
                defaults={
                    "created_by": request.user,
                    "quote_created_at": quote_created_at or timezone.now(),
                },
            )
            incoming_updated_at = _calculator_quote_updated_at(payload)
            restoring_legacy_archive = False
            if record.lead_deleted:
                # Older versions incorrectly deleted an internal quote together with its CRM project.
                # A calculator that still has the quote locally may safely restore the archive entry.
                if record.quote_id.startswith("public-") or not record.project_sync_disabled:
                    continue
                record.lead_deleted = False
                restoring_legacy_archive = True
            current_updated_at = _calculator_quote_updated_at(record.payload) or record.updated_at
            if not restoring_legacy_archive and not created and (not incoming_updated_at or incoming_updated_at < current_updated_at):
                sync_quote_lead(record)
                continue
            record.number = str(payload.get("number") or "")[:32]
            record.payload = payload
            record.updated_by = request.user
            if quote_created_at:
                record.quote_created_at = quote_created_at
            if created and not record.created_by_id:
                record.created_by = request.user
            record.save()
            sync_quote_lead(record)

    return Response({"quotes": _calculator_quote_payloads(workspace)})


@api_view(["DELETE"])
@permission_classes([IsAuthenticatedAny])
def calculator_quote_detail_view(request, quote_id):
    if not request.user.is_admin():
        return Response(
            {"detail": "Архив КП может изменять только администратор."},
            status=drf_status.HTTP_403_FORBIDDEN,
        )
    workspace = current_workspace(request.user)
    # Preserve CRM deletion markers to reject stale offline uploads.
    CalculatorQuote.objects.filter(workspace=workspace, quote_id=quote_id, lead_deleted=False).delete()
    return Response(status=drf_status.HTTP_204_NO_CONTENT)


@api_view(["POST"])
@permission_classes([IsAuthenticatedAny])
def yandex_disk_oauth_start_view(request):
    if not request.user.is_admin():
        return Response({"detail": "Подключать Яндекс.Диск может только администратор."}, status=drf_status.HTTP_403_FORBIDDEN)

    workspace = current_workspace(request.user)
    try:
        authorization_url = build_yandex_disk_authorization_url(request, workspace)
    except YandexDiskError as exc:
        return Response({"detail": str(exc)}, status=drf_status.HTTP_400_BAD_REQUEST)

    return Response({"authorization_url": authorization_url, "redirect_uri": yandex_disk_redirect_uri(request)})


@api_view(["POST"])
@permission_classes([IsAuthenticatedAny])
def yandex_disk_oauth_complete_view(request):
    if not request.user.is_admin():
        return Response({"detail": "Подключать Яндекс.Диск может только администратор."}, status=drf_status.HTTP_403_FORBIDDEN)

    workspace = current_workspace(request.user)
    code = (request.data.get("code") or "").strip()
    try:
        settings = connect_yandex_disk_with_manual_code(request, workspace, code)
    except YandexDiskError as exc:
        return Response({"detail": str(exc)}, status=drf_status.HTTP_400_BAD_REQUEST)

    data = YandexDiskSettingsSerializer(settings).data
    data["oauth_configured"] = yandex_disk_oauth_configured()
    data["oauth_redirect_uri"] = yandex_disk_redirect_uri(request)
    return Response(data)


@api_view(["GET"])
@permission_classes([AllowAny])
def yandex_disk_oauth_callback_view(request):
    error = request.query_params.get("error") or ""
    error_description = request.query_params.get("error_description") or ""
    frontend_url = _frontend_settings_url(request)

    if error:
        message = error_description or error
        return redirect(f"{frontend_url}?{urlencode({'yandex_disk': 'error', 'message': message})}")

    try:
        connect_yandex_disk_with_code(
            request,
            code=request.query_params.get("code") or "",
            state=request.query_params.get("state") or "",
        )
    except YandexDiskError as exc:
        return redirect(f"{frontend_url}?{urlencode({'yandex_disk': 'error', 'message': str(exc)})}")

    return redirect(f"{frontend_url}?{urlencode({'yandex_disk': 'connected'})}")


@api_view(["GET"])
@permission_classes([IsAuthenticatedAny])
def yandex_disk_folders_view(request):
    workspace = current_workspace(request.user)
    settings, _created = YandexDiskSettings.objects.get_or_create(workspace=workspace)
    if not settings.oauth_token:
        return Response({"detail": "OAuth-токен Яндекс.Диска не настроен."}, status=drf_status.HTTP_400_BAD_REQUEST)

    disk_path = request.query_params.get("path") or "disk:/"
    try:
        return Response(list_disk_folders(settings.oauth_token, disk_path))
    except YandexDiskError as exc:
        return Response({"detail": str(exc)}, status=drf_status.HTTP_502_BAD_GATEWAY)


def _frontend_settings_url(request):
    base_url = (os.getenv("CRM_FRONTEND_URL") or os.getenv("FRONTEND_URL") or "").strip().rstrip("/")
    if not base_url:
        base_url = request.build_absolute_uri("/").rstrip("/")
    return f"{base_url}/settings"


@api_view(["GET"])
@permission_classes([IsAuthenticatedAny])
def address_suggestions_view(request):
    query = (request.query_params.get("q") or "").strip()
    if len(query) < 3:
        return Response({"suggestions": [], "configured": bool(dadata_api_key())})

    if not dadata_api_key():
        return Response(
            {
                "suggestions": [],
                "configured": False,
                "detail": "DADATA_API_KEY не настроен в backend .env.",
            }
        )

    suggestions = suggest_dadata_address(query, count=6)
    return Response(
        {
            "configured": bool(dadata_api_key()),
            "default_region": dadata_default_region(),
            "suggestions": [
                {
                    "value": item.get("value") or "",
                    "unrestricted_value": item.get("unrestricted_value") or item.get("value") or "",
                    "lat": (item.get("data") or {}).get("geo_lat") or "",
                    "lon": (item.get("data") or {}).get("geo_lon") or "",
                    "apartment": (item.get("data") or {}).get("flat") or "",
                    "floor": (item.get("data") or {}).get("floor") or "",
                    "city": (item.get("data") or {}).get("city") or "",
                    "settlement": (item.get("data") or {}).get("settlement") or "",
                    "city_district": (item.get("data") or {}).get("city_district") or "",
                    "area": (item.get("data") or {}).get("area") or "",
                    "street": (item.get("data") or {}).get("street") or "",
                }
                for item in suggestions
                if isinstance(item, dict)
            ],
        }
    )


@api_view(["GET"])
@permission_classes([IsAuthenticatedAny])
def finance_analytics_view(request):
    project_queryset, payment_queryset, filters = _finance_scope(request)
    reference_queryset = _visible_finance_projects(request.user)
    return Response(
        build_finance_overview(
            project_queryset,
            payment_queryset,
            filters=filters,
            reference_projects_queryset=reference_queryset,
        )
    )


@api_view(["GET"])
@permission_classes([IsAuthenticatedAny])
def cash_forecast_view(request):
    project_queryset, payment_queryset, filters = _finance_scope(request)
    reference_queryset = _visible_finance_projects(request.user)
    return Response(
        build_cash_forecast(
            project_queryset,
            payment_queryset,
            reference_projects_queryset=reference_queryset,
            selected_account_id=(filters.get("account") if filters.get("account") != "all" else None),
            workspace=current_workspace(request.user),
        )
    )


@api_view(["GET"])
@permission_classes([IsAuthenticatedAny])
def global_search_view(request):
    query = str(request.query_params.get("q") or "").strip()
    if len(query) < 2:
        return Response({"query": query, "results": []})

    workspace = current_workspace(request.user)
    phone_query = phone_search_digits(query)
    query_digits = re.sub(r"\D", "", query)
    project_number = int(query_digits) if query_digits and len(query_digits) <= 6 else None
    project_queryset = (
        Project.objects.filter(workspace=workspace)
        .select_related("client")
        .annotate(
            order_number_text=Cast("order_number", output_field=CharField()),
        )
    )
    if not request.user.is_admin():
        project_queryset = project_queryset.filter(manager=request.user)

    project_filter = (
        Q(title__icontains=query)
        | Q(client_name__icontains=query)
        | Q(client_phone__icontains=query)
        | Q(object_address__icontains=query)
        | Q(apartment__icontains=query)
        | Q(entrance__icontains=query)
        | Q(floor__icontains=query)
        | Q(description__icontains=query)
        | Q(categories__icontains=query)
        | Q(status__icontains=query)
        | Q(calculator_quote__number__icontains=query)
    )
    if project_number is not None:
        project_filter |= Q(order_number=project_number) | Q(order_number_text__icontains=query_digits.lstrip("0") or "0")
    if phone_query:
        project_queryset = project_queryset.annotate(client_phone_digits=phone_digits_expression("client_phone"))
        project_filter |= Q(client_phone__icontains=phone_query) | Q(client_phone_digits__icontains=phone_query)

    related_project_ids = {
        project_id
        for project_id, custom_fields in project_queryset.values_list("id", "custom_fields")
        if json_contains_text(custom_fields, query)
    }
    related_project_ids.update(
        project_id
        for project_id, data in MeasurementSheet.objects.filter(project__in=project_queryset).values_list("project_id", "data")
        if json_contains_text(data, query)
    )
    related_project_ids.update(
        project_id
        for project_id, summary, product_type, specification in ProductionPlan.objects.filter(project__in=project_queryset).values_list(
            "project_id", "summary", "product_type", "specification"
        )
        if query.casefold() in f"{summary} {product_type}".casefold() or json_contains_text(specification, query)
    )
    related_project_ids.update(
        project_id
        for project_id, payload in CalculatorQuote.objects.filter(project__in=project_queryset).values_list("project_id", "payload")
        if project_id and json_contains_text(payload, query)
    )
    if related_project_ids:
        project_filter |= Q(id__in=related_project_ids)
    projects = list(project_queryset.filter(project_filter).order_by("-updated_at")[:8])

    client_queryset = Client.objects.filter(workspace=workspace).annotate(
        bonus_balance_text=Cast("bonus_balance", output_field=CharField()),
    )
    client_filter = (
        Q(name__icontains=query)
        | Q(contract_full_name__icontains=query)
        | Q(phone__icontains=query)
        | Q(email__icontains=query)
        | Q(address__icontains=query)
        | Q(apartment__icontains=query)
        | Q(floor__icontains=query)
        | Q(bonus_balance_text__icontains=query)
    )
    if phone_query:
        client_queryset = client_queryset.annotate(phone_digits=phone_digits_expression("phone"))
        client_filter |= Q(phone__icontains=phone_query) | Q(phone_digits__icontains=phone_query)
    clients = list(client_queryset.filter(client_filter).order_by("name")[:6])

    task_queryset = Task.objects.select_related("project").filter(assignee__workspace=workspace)
    task_queryset = task_queryset.filter(Q(project__isnull=True) | Q(project__workspace=workspace))
    if not request.user.is_admin():
        task_queryset = task_queryset.filter(assignee=request.user)
    tasks = list(task_queryset.filter(
        Q(title__icontains=query)
        | Q(notes__icontains=query)
        | Q(status__icontains=query)
        | Q(priority__icontains=query)
        | Q(project__title__icontains=query)
        | Q(project__client_name__icontains=query)
    ).order_by("status", "due_date")[:6])

    payment_queryset = _visible_payments(request.user).select_related("project", "category", "account", "destination_account")
    payments = list(
        payment_queryset.annotate(
            amount_text=Cast("amount", output_field=CharField()),
            paid_at_text=Cast("paid_at", output_field=CharField()),
        ).filter(
            Q(comment__icontains=query)
            | Q(project__title__icontains=query)
            | Q(project__client_name__icontains=query)
            | Q(category__name__icontains=query)
            | Q(account__name__icontains=query)
            | Q(destination_account__name__icontains=query)
            | Q(type__icontains=query)
            | Q(method__icontains=query)
            | Q(amount_text__icontains=query)
            | Q(paid_at_text__icontains=query)
        ).order_by("-paid_at")[:6]
    )

    comments = list(
        ProjectComment.objects.select_related("project")
        .filter(project__in=project_queryset, text__icontains=query)
        .order_by("-created_at")[:6]
    )

    quote_queryset = CalculatorQuote.objects.select_related("project").filter(
        workspace=workspace,
        lead_deleted=False,
    )
    if not request.user.is_admin():
        quote_queryset = quote_queryset.filter(project__manager=request.user)
    normalized_query = query.casefold().replace("ё", "е")
    calculator_quotes = []
    for quote in quote_queryset.order_by("-quote_created_at", "-id"):
        payload_text = json.dumps(quote.payload or {}, ensure_ascii=False, default=str)
        searchable_text = f"{quote.number} {payload_text}".casefold().replace("ё", "е")
        searchable_digits = re.sub(r"\D", "", searchable_text)
        if normalized_query in searchable_text or (phone_query and phone_query in searchable_digits):
            calculator_quotes.append(quote)
        if len(calculator_quotes) >= 8:
            break

    results = []
    results.extend(_project_result(project) for project in projects)
    results.extend(_client_result(client) for client in clients)
    results.extend(_calculator_quote_result(quote) for quote in calculator_quotes)
    results.extend(_task_result(task) for task in tasks)
    results.extend(_payment_result(payment) for payment in payments)
    results.extend(_comment_result(comment) for comment in comments)

    return Response({"query": query, "results": results[:30]})


class ProjectViewSet(viewsets.ModelViewSet):
    serializer_class = ProjectSerializer
    permission_classes = [IsAuthenticatedAny]

    def handle_exception(self, exc):
        try:
            return super().handle_exception(exc)
        except Exception:
            logger.exception("Unhandled project API error")
            return Response(
                {"detail": "Не удалось сохранить проект из-за внутренней ошибки сервера. Подробности записаны в лог backend."},
                status=drf_status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

    def get_queryset(self):
        workspace = current_workspace(self.request.user)
        qs = Project.objects.select_related("client", "calculator_quote").filter(workspace=workspace).order_by("-created_at")
        if self.request.user.is_admin():
            return qs
        return qs.filter(manager=self.request.user)

    def perform_create(self, serializer):
        workspace = current_workspace(self.request.user)
        user = self.request.user
        project = serializer.save(manager=user, workspace=workspace)
        apply_task_templates_for_project(project, actor=user)
        if is_archive_project_status(project):
            archive_project_disk_folder(project, actor=user)
        elif not is_application_project_status(project):
            ensure_project_disk_folder(project, actor=user)
        create_audit_log(
            user,
            "project",
            project.id,
            "create",
            after=snapshot_model(project, ["id", "title", "client_name", "client_phone", "object_address", "total_amount", "status"]),
            workspace=workspace,
        )

    def perform_update(self, serializer):
        instance = serializer.instance
        before = snapshot_model(instance, ["id", "title", "client_name", "client_phone", "object_address", "total_amount", "status"])
        previous_status = instance.status
        was_application = is_application_project_status(instance)
        project = serializer.save()
        if previous_status != project.status:
            apply_task_templates_for_project(project, actor=self.request.user)
            if was_application and not is_application_project_status(project) and not is_archive_project_status(project):
                ensure_project_disk_folder(project, actor=self.request.user)
        # Retry the archive sync on every save of a completed project. This makes
        # the move recover automatically after a temporary Yandex Disk failure.
        if is_archive_project_status(project):
            archive_project_disk_folder(project, actor=self.request.user)
        create_audit_log(
            self.request.user,
            "project",
            project.id,
            "update",
            before=before,
            after=snapshot_model(project, ["id", "title", "client_name", "client_phone", "object_address", "total_amount", "status"]),
            workspace=project.workspace,
        )

    def perform_destroy(self, instance):
        if instance.yandex_disk_public_url:
            try:
                set_project_folder_public(instance, publish=False)
            except YandexDiskError as exc:
                raise ValidationError({"detail": f"Сначала закройте доступ к папке Яндекс.Диска: {exc}"}) from exc
        before = snapshot_model(instance, ["id", "title", "client_name", "client_phone", "object_address", "total_amount", "status"])
        calculator_quote = CalculatorQuote.objects.filter(project=instance).first()
        if calculator_quote:
            calculator_quote.project_sync_disabled = True
            calculator_quote.save(update_fields=["project_sync_disabled", "updated_at"])
        reverse_project_bonus_effects(instance, actor=self.request.user)
        create_audit_log(
            self.request.user,
            "project",
            instance.id,
            "delete",
            before=before,
            workspace=instance.workspace,
        )
        instance.delete()

    @action(detail=True, methods=["get"], url_path="finance-analytics")
    def finance_analytics(self, request, pk=None):
        project = self.get_object()
        return Response(build_project_finance_analytics(project))

    @action(detail=True, methods=["get"], url_path="status-checks")
    def status_checks(self, request, pk=None):
        project = self.get_object()
        return Response(build_project_status_check(project))

    @action(detail=True, methods=["get"], url_path="activity")
    def activity(self, request, pk=None):
        project = self.get_object()
        return Response({"project": project.id, "events": _project_activity_payload(project)})

    @action(detail=True, methods=["post", "delete"], url_path="calculator-quote")
    def calculator_quote(self, request, pk=None):
        project = self.get_object()
        workspace = current_workspace(request.user)

        with transaction.atomic():
            # get_queryset() joins the optional calculator_quote relation. PostgreSQL
            # cannot apply FOR UPDATE to the nullable side of that outer join, so lock
            # only the project row and lock quotes with their own queries below.
            project_queryset = Project.objects.filter(workspace=workspace)
            if not request.user.is_admin():
                project_queryset = project_queryset.filter(manager=request.user)
            project = project_queryset.select_for_update().get(pk=project.pk)
            current_quote = CalculatorQuote.objects.select_for_update().filter(project=project).first()

            if request.method == "DELETE":
                if current_quote:
                    current_quote.project = None
                    current_quote.project_sync_disabled = True
                    current_quote.updated_by = request.user
                    current_quote.save(update_fields=["project", "project_sync_disabled", "updated_by", "updated_at"])
                    create_audit_log(
                        request.user,
                        "project",
                        project.id,
                        "update",
                        before={"calculator_quote": current_quote.quote_id},
                        after={"calculator_quote": None},
                        workspace=project.workspace,
                    )
                project.refresh_from_db()
                return Response({"project": self.get_serializer(project).data})

            quote_id = str(request.data.get("quote_id") or "").strip()
            if not quote_id:
                return Response(
                    {"detail": "Выберите КП для привязки к проекту."},
                    status=drf_status.HTTP_400_BAD_REQUEST,
                )

            quote = CalculatorQuote.objects.select_for_update().filter(
                workspace=workspace,
                quote_id=quote_id,
                lead_deleted=False,
            ).first()
            if quote is None:
                return Response({"detail": "КП не найдено в архиве калькулятора."}, status=drf_status.HTTP_404_NOT_FOUND)

            moved_from_project_id = quote.project_id if quote.project_id != project.id else None
            if current_quote and current_quote.pk != quote.pk:
                current_quote.project = None
                current_quote.project_sync_disabled = True
                current_quote.updated_by = request.user
                current_quote.save(update_fields=["project", "project_sync_disabled", "updated_by", "updated_at"])

            quote.project = project
            quote.project_sync_disabled = False
            quote.updated_by = request.user
            quote.save(update_fields=["project", "project_sync_disabled", "updated_by", "updated_at"])

            from .calculator_leads import quote_summary

            quote_total, _configuration = quote_summary(quote.payload if isinstance(quote.payload, dict) else {})
            if quote_total is not None and project.total_amount != quote_total:
                project.total_amount = quote_total
                project.save(update_fields=["total_amount", "updated_at"])
                try:
                    ensure_project_bonus_accrual(project, actor=request.user)
                except Exception:
                    logger.exception("Project bonus accrual failed after quote link project_id=%s", project.pk)

            create_audit_log(
                request.user,
                "project",
                project.id,
                "update",
                before={"calculator_quote": current_quote.quote_id if current_quote else None},
                after={"calculator_quote": quote.quote_id, "total_amount": str(project.total_amount or "")},
                workspace=project.workspace,
            )

        project.refresh_from_db()
        return Response(
            {
                "project": self.get_serializer(project).data,
                "moved_from_project_id": moved_from_project_id,
            }
        )

    @action(detail=True, methods=["post"], url_path="yandex-disk-folder")
    def yandex_disk_folder(self, request, pk=None):
        project = self.get_object()
        result = ensure_project_disk_folder(project, actor=request.user, force=True)
        project.refresh_from_db()
        return Response({"result": result, "project": self.get_serializer(project).data})

    @action(detail=True, methods=["post"], url_path="yandex-disk-public-link")
    def yandex_disk_public_link(self, request, pk=None):
        project = self.get_object()
        if request.data.get("publish") is not False:
            return Response({"detail": "Создание публичных ссылок отключено."}, status=drf_status.HTTP_400_BAD_REQUEST)
        try:
            public_url = set_project_folder_public(project, publish=False)
        except YandexDiskError as exc:
            return Response({"detail": str(exc)}, status=drf_status.HTTP_400_BAD_REQUEST)
        return Response({"public_url": public_url, "project": self.get_serializer(project).data})

    @action(detail=True, methods=["post"], url_path="custom-field-files", parser_classes=[MultiPartParser, FormParser])
    def upload_custom_field_file(self, request, pk=None):
        project = self.get_object()
        field_id = str(request.data.get("field_id") or "").strip()
        uploaded_files = request.FILES.getlist("files") or request.FILES.getlist("file")

        if not field_id:
            return Response({"detail": "Укажите пользовательское поле."}, status=drf_status.HTTP_400_BAD_REQUEST)
        if not uploaded_files:
            return Response({"detail": "Прикрепите файл."}, status=drf_status.HTTP_400_BAD_REQUEST)

        try:
            field_pk = int(field_id)
        except (TypeError, ValueError):
            return Response({"detail": "Некорректное пользовательское поле."}, status=drf_status.HTTP_400_BAD_REQUEST)

        field = ProjectCustomField.objects.filter(
            id=field_pk,
            workspace=current_workspace(request.user),
            field_type=ProjectCustomField.FieldType.FILE,
        ).first()
        if not field:
            return Response({"detail": "Поле файла не найдено."}, status=drf_status.HTTP_404_NOT_FOUND)

        raw_custom_fields = project.custom_fields
        if isinstance(raw_custom_fields, dict):
            custom_fields = dict(raw_custom_fields)
        else:
            logger.warning(
                "Resetting legacy non-object custom_fields during file upload project_id=%s type=%s",
                project.id,
                type(raw_custom_fields).__name__,
            )
            custom_fields = {}
        existing_value = custom_fields.get(str(field.id))
        if isinstance(existing_value, list):
            existing_files = [item for item in existing_value if isinstance(item, dict)]
        elif isinstance(existing_value, dict):
            existing_files = [existing_value]
        else:
            existing_files = []

        file_values = []
        saved_paths = []
        for upload_index, uploaded_file in enumerate(uploaded_files, start=len(existing_files) + 1):
            original_name = uploaded_file.name or "file"
            display_name = project_custom_file_name(project, field, original_name, upload_index)
            safe_name = get_valid_filename(display_name) or f"file-{upload_index:02d}"
            storage_path = f"project_custom_fields/{project.id}/{field.id}/{uuid.uuid4().hex}-{safe_name}"
            try:
                saved_path = default_storage.save(storage_path, uploaded_file)
                saved_paths.append(saved_path)
                file_url = default_storage.url(saved_path)
            except Exception:
                logger.exception(
                    "Project custom-field file storage failed project_id=%s field_id=%s filename=%s",
                    project.id,
                    field.id,
                    original_name,
                )
                for path in saved_paths:
                    try:
                        default_storage.delete(path)
                    except Exception:
                        logger.exception("Failed to remove partial project upload path=%s", path)
                return Response(
                    {"detail": "Не удалось сохранить файл в хранилище CRM."},
                    status=drf_status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            if file_url.startswith("/"):
                file_url = request.build_absolute_uri(file_url)

            file_values.append(
                {
                    "name": display_name,
                    "original_name": original_name,
                    "url": file_url,
                    "path": saved_path,
                    "content_type": uploaded_file.content_type or "",
                    "size": uploaded_file.size,
                }
            )

        custom_fields[str(field.id)] = existing_files + file_values
        project.custom_fields = custom_fields
        try:
            project.save(update_fields=["custom_fields", "updated_at"])
        except Exception:
            logger.exception(
                "Project custom-field metadata save failed project_id=%s field_id=%s",
                project.id,
                field.id,
            )
            for path in saved_paths:
                try:
                    default_storage.delete(path)
                except Exception:
                    logger.exception("Failed to remove rolled-back project upload path=%s", path)
            return Response(
                {"detail": "Файл получен, но не удалось записать его в карточку проекта."},
                status=drf_status.HTTP_500_INTERNAL_SERVER_ERROR,
            )

        try:
            yandex_disk_result = sync_project_measurement_files_to_yandex(
                project,
                field,
                custom_fields[str(field.id)],
                actor=request.user,
            )
        except Exception as exc:
            logger.exception(
                "Measurement upload saved in CRM but Yandex sync failed project_id=%s field_id=%s",
                project.id,
                field.id,
            )
            yandex_disk_result = {
                "ok": False,
                "error": "Файл сохранён в CRM, но синхронизация с Яндекс.Диском завершилась ошибкой.",
                "error_type": type(exc).__name__,
            }

        try:
            project_payload = self.get_serializer(project).data
        except Exception:
            logger.exception("Project serialization failed after custom-field upload project_id=%s", project.id)
            project_payload = {
                "id": project.id,
                "order_number": project.order_number,
                "title": project.title,
            }

        return Response(
            {
                "field_id": str(field.id),
                "value": custom_fields[str(field.id)],
                "uploaded": file_values,
                "yandex_disk": yandex_disk_result,
                "project": project_payload,
            }
        )

    @action(detail=True, methods=["get"], url_path=r"documents/(?P<document_type>contract|act)")
    def document(self, request, pk=None, document_type=None):
        project = self.get_object()

        works_with_contract = bool(project.client.works_with_contract) if project.client else bool(project.works_with_contract)

        if not works_with_contract:
            return Response(
                {"detail": "Для этого клиента не включена работа по договору и актам."},
                status=drf_status.HTTP_400_BAD_REQUEST,
            )

        if not project.client:
            return Response(
                {"detail": "Сначала прикрепите к проекту карточку клиента."},
                status=drf_status.HTTP_400_BAD_REQUEST,
            )
        if not project.client.contract_full_name.strip():
            return Response(
                {"detail": "Укажите ФИО клиента для договора.", "missing_fields": ["contract_full_name"]},
                status=drf_status.HTTP_400_BAD_REQUEST,
            )

        template = DocumentTemplate.objects.filter(workspace=current_workspace(request.user), type=document_type).first()
        if not template or not template.file:
            return Response({"detail": "Шаблон документа не загружен."}, status=drf_status.HTTP_404_NOT_FOUND)

        try:
            content = render_pdf_template(template, project)
        except ModuleNotFoundError as exc:
            if exc.name != "pypdf":
                return Response(
                    {"detail": f"Не удалось сформировать PDF: отсутствует модуль {exc.name}."},
                    status=drf_status.HTTP_500_INTERNAL_SERVER_ERROR,
                )
            return Response(
                {"detail": "На backend не установлена библиотека pypdf. Выполните pip install -r requirements.txt."},
                status=drf_status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        except Exception as exc:
            return Response({"detail": f"Не удалось сформировать PDF: {exc}"}, status=drf_status.HTTP_400_BAD_REQUEST)

        document_label = "dogovor" if document_type == DocumentTemplate.Type.CONTRACT else "akt"
        safe_project_name = "".join(ch for ch in (project.title or project.client_name) if ch.isalnum() or ch in (" ", "-", "_")).strip()
        filename = f"{document_label}-{safe_project_name or project.id}.pdf"
        return FileResponse(BytesIO(content), as_attachment=True, filename=filename, content_type="application/pdf")


def render_pdf_template(template, project):
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import NameObject

    values = build_project_document_values(project)

    with template.file.open("rb") as file_obj:
        reader = PdfReader(file_obj)
        writer = PdfWriter()
        writer.clone_document_from_reader(reader)

        font_names = _register_document_fonts(pdfmetrics, TTFont)
        source_fields = set((reader.get_fields() or {}).keys())
        standard_contract = {
            "PROJECT_NUMBER", "CLIENT_FULL_NAME_5", "QUOTE_ITEMS", "DEAL_VALUE",
        }.issubset(source_fields) and len(writer.pages) == 4
        for page_index, page in enumerate(writer.pages):
            if standard_contract and page_index in {0, 2, 3}:
                overlay = _build_standard_contract_overlay(
                    page, page_index, values, canvas, pdfmetrics, font_names,
                )
            else:
                overlay = _build_pdf_field_overlay(
                    page, values, canvas, pdfmetrics, font_names["regular"],
                )
            if overlay:
                page.merge_page(PdfReader(overlay).pages[0])
            annotations = page.get("/Annots") or []
            remaining = [item for item in annotations if item.get_object().get("/Subtype") != "/Widget"]
            if remaining:
                page[NameObject("/Annots")] = type(annotations)(remaining)
            else:
                page.pop(NameObject("/Annots"), None)

        # Contracts and acts are final documents, not editable templates. Removing
        # AcroForm also prevents viewers from showing stale placeholder appearances.
        writer._root_object.pop(NameObject("/AcroForm"), None)

        output = BytesIO()
        writer.write(output)
        return output.getvalue()


def _register_document_fonts(pdfmetrics, ttfont):
    from pathlib import Path

    regular_name = "CRMDocumentSerif"
    bold_name = "CRMDocumentSerifBold"
    if regular_name in pdfmetrics.getRegisteredFontNames() and bold_name in pdfmetrics.getRegisteredFontNames():
        return {"regular": regular_name, "bold": bold_name}
    candidates = (
        (
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"),
        ),
        (Path("C:/Windows/Fonts/times.ttf"), Path("C:/Windows/Fonts/timesbd.ttf")),
        (Path("C:/Windows/Fonts/arial.ttf"), Path("C:/Windows/Fonts/arialbd.ttf")),
    )
    font_paths = next(((regular, bold) for regular, bold in candidates if regular.exists() and bold.exists()), None)
    if font_paths is None:
        raise RuntimeError("Не найден шрифт с поддержкой кириллицы для формирования PDF.")
    pdfmetrics.registerFont(ttfont(regular_name, str(font_paths[0])))
    pdfmetrics.registerFont(ttfont(bold_name, str(font_paths[1])))
    return {"regular": regular_name, "bold": bold_name}


def _pdf_field_name(widget):
    current = widget
    while current is not None:
        field_name = current.get("/T")
        if field_name:
            return str(field_name)
        parent = current.get("/Parent")
        current = parent.get_object() if parent else None
    return ""


def _fit_pdf_text(text, width, height, pdfmetrics, font_name, preferred_size, multiline=False):
    minimum_size = 5.5
    size = max(float(preferred_size or 9), minimum_size)
    paragraphs = str(text or "").splitlines() or [""]
    while size > minimum_size:
        if multiline:
            lines = _wrap_pdf_text(paragraphs, width, pdfmetrics, font_name, size)
            if len(lines) * size * 1.18 <= height:
                return lines, size
        elif pdfmetrics.stringWidth(paragraphs[0], font_name, size) <= width:
            return paragraphs, size
        size -= 0.25
    if multiline:
        return _wrap_pdf_text(paragraphs, width, pdfmetrics, font_name, minimum_size), minimum_size
    return paragraphs, minimum_size


def _wrap_pdf_text(paragraphs, width, pdfmetrics, font_name, size):
    lines = []
    for paragraph in paragraphs:
        words = paragraph.split()
        if not words:
            lines.append("")
            continue
        current = words[0]
        for word in words[1:]:
            candidate = f"{current} {word}"
            if pdfmetrics.stringWidth(candidate, font_name, size) <= width:
                current = candidate
            else:
                lines.append(current)
                current = word
        lines.append(current)
    return lines


def _draw_pdf_paragraph(pdf, text, x, top, width, pdfmetrics, font_name, size=11, leading=None):
    leading = leading or size * 1.22
    lines = _wrap_pdf_text(str(text or "").splitlines(), width, pdfmetrics, font_name, size)
    baseline = top - size
    for line in lines:
        pdf.drawString(x, baseline, line)
        baseline -= leading
    return baseline


def _fit_contract_clauses(clauses, width, pdfmetrics, font_name, top, minimum_baseline):
    """Keep the body font fixed and compact only its vertical rhythm."""
    size = 10.5
    for leading in (12.6, 12.2, 11.8, 11.4, 11, 10.7, 10.5):
        paragraph_spacing = leading - 0.5
        clause_top = top
        last_baseline = clause_top
        for clause in clauses:
            line_count = len(_wrap_pdf_text([clause], width, pdfmetrics, font_name, size))
            first_baseline = clause_top - size
            last_baseline = first_baseline - leading * (line_count - 1)
            clause_top = last_baseline - leading + paragraph_spacing
        if last_baseline >= minimum_baseline:
            return size, leading, paragraph_spacing
    return size, size, size - 0.5


def _draw_contract_parties(pdf, values, font_names, pdfmetrics, top, include_signatures=True):
    regular = font_names["regular"]
    bold = font_names["bold"]
    left_x = 62
    right_x = 326
    pdf.setFillColorRGB(0, 0, 0)
    pdf.setFont(bold, 11)
    pdf.drawString(left_x, top, "Заказчик:")
    pdf.drawString(right_x, top, "Подрядчик:")

    client_lines = [
        f"ФИО: {values.get('CLIENT_FULL_NAME') or values.get('CLIENT_SHORT_NAME') or ''}",
        f"Адрес: {values.get('CLIENT_ADDRESS') or ''}",
        f"Телефон: {values.get('CLIENT_PHONE') or ''}",
    ]
    contractor_lines = [
        "ИП ЛАПУНОВ МАКСИМ ВЛАДИМИРОВИЧ",
        "ИНН 616805532322",
        "ОГРНИП 325619600255723",
        "БИК 044525974",
        "Р/С 40802810800008892772",
        "К/с 30101810145250000974",
        "Телефон 89298191684",
    ]
    pdf.setFont(regular, 10.5)
    left_y = top - 23
    for line in client_lines:
        left_y = _draw_pdf_paragraph(pdf, line, left_x, left_y + 10.5, 235, pdfmetrics, regular, 10.5, 12.8)
    right_y = top - 13
    for line in contractor_lines:
        pdf.drawString(right_x, right_y, line)
        right_y -= 14

    if include_signatures:
        signature_y = min(left_y, right_y) - 58
        pdf.line(left_x, signature_y, 297, signature_y)
        pdf.line(right_x, signature_y, 533, signature_y)
        pdf.setFont(regular, 8)
        pdf.drawCentredString(180, signature_y - 10, "(подпись)")
        pdf.drawCentredString(430, signature_y - 10, "(подпись)")
        pdf.setFont(regular, 10.5)
        client_name = values.get("CLIENT_FULL_NAME") or values.get("CLIENT_SHORT_NAME") or ""
        pdf.drawString(left_x, signature_y + 4, client_name)
        pdf.drawRightString(533, signature_y + 4, "М.В. Лапунов")


def _draw_contract_first_page(pdf, values, font_names, pdfmetrics, page_width, page_height):
    regular = font_names["regular"]
    bold = font_names["bold"]

    # Replace the four dynamic areas as complete text blocks so long values
    # reflow at the same readable size as the surrounding contract.
    pdf.setFillColorRGB(1, 1, 1)
    pdf.rect(80, 580, page_width - 115, 103, stroke=0, fill=1)
    pdf.rect(80, 278, page_width - 115, 292, stroke=0, fill=1)
    pdf.rect(325, 742, 135, 22, stroke=0, fill=1)
    pdf.rect(400, 700, 88, 22, stroke=0, fill=1)

    pdf.setFillColorRGB(0, 0, 0)
    pdf.setFont(regular, 11)
    pdf.drawString(329, 748, str(values.get("PROJECT_NUMBER") or ""))
    pdf.drawString(404, 706, str(values.get("DOCUMENT_DATE") or values.get("DOC_DATE") or ""))

    full_name = values.get("CLIENT_FULL_NAME") or values.get("CLIENT_SHORT_NAME") or ""
    introduction = (
        f'{full_name}, именуемый в дальнейшем "Заказчик", с одной стороны, и '
        "ИП ЛАПУНОВ МАКСИМ ВЛАДИМИРОВИЧ, ИНН 616805532322, ОГРНИП 325619600255723, "
        "юридический адрес: 344090, РОССИЯ, РОСТОВСКАЯ ОБЛ, Г РОСТОВ-НА-ДОНУ, "
        "УЛ МИЛЬЧАКОВА, Д 3, КВ 78, именуемый в дальнейшем \"Подрядчик\", с другой "
        "стороны, заключили настоящий договор о нижеследующем:"
    )
    pdf.setFont(regular, 11)
    _draw_pdf_paragraph(pdf, introduction, 84, 677, page_width - 125, pdfmetrics, regular, 11, 13.2)

    object_address = values.get("PROJECT_ADDRESS") or values.get("OBJECT_ADDRESS") or ""
    clauses = [
        (
            "1.1. По договору подряда Подрядчик обязуется выполнить комплекс стекольно-зеркальных "
            "работ, указанных п. 1.2 настоящего Договора, а Заказчик обязуется принять данные "
            "работы и уплатить стоимость работ."
        ),
        "1.2. Подрядчик обязуется исполнить следующие виды работ: изготовить стекольно-зеркальное "
        "изделие по размерам и эскизам, утвержденным Заказчиком. Осуществить доставку и монтаж "
        f"на объекте, утвержденном заказчиком, по адресу: {object_address}.",
        "1.3. Работы выполняются из материалов Подрядчика.",
        (
            "1.4. Объем и стоимость работ, составляющих предмет настоящего договора, определяются "
            "в приложении №1 (спецификация) к настоящему договору."
        ),
        (
            "1.5. Приложение №1 (спецификация) к настоящему договору может меняться в связи с "
            "изменением размеров Заказчиком или после замера на объекте Исполнителем."
        ),
        (
            "1.6. Подрядчик обязуется предоставить перерасчет стоимости работ после изменения "
            "объема, если таковые изменения имеются."
        ),
        (
            "1.7. Срок выполнения работ определен сторонами и составляет 10 рабочих дней с момента "
            "подписания настоящего договора, решения технической части замера на объекте и внесения "
            "авансовой части оплаты. Подрядчик может выполнить работы досрочно. В позициях, содержащих "
            "закаленное стекло, срок изготовления увеличивается до 15 рабочих дней."
        ),
        (
            "1.8. Договор вступает в силу с момента его подписания Сторонами и действует до полного "
            "исполнения Сторонами обязательств по Договору."
        ),
    ]
    clause_width = page_width - 125
    clause_top = 554
    clause_size, clause_leading, paragraph_spacing = _fit_contract_clauses(
        clauses,
        clause_width,
        pdfmetrics,
        regular,
        clause_top,
        318,
    )
    pdf.setFont(regular, clause_size)
    for clause in clauses:
        clause_top = _draw_pdf_paragraph(
            pdf,
            clause,
            84,
            clause_top,
            clause_width,
            pdfmetrics,
            regular,
            clause_size,
            clause_leading,
        ) + paragraph_spacing

    # The source template places this heading too close to 2.1. Redraw it in
    # the reserved gap so varying addresses cannot make section 1 overlap it.
    pdf.setFont(bold, 11)
    pdf.drawString(84, 296, "2. Права и обязанности сторон")


def _draw_contract_requisites_page(pdf, values, font_names, pdfmetrics, page_width):
    pdf.setFillColorRGB(1, 1, 1)
    pdf.rect(48, 410, page_width - 83, 230, stroke=0, fill=1)
    _draw_contract_parties(pdf, values, font_names, pdfmetrics, 625)


def _draw_contract_specification_page(pdf, values, font_names, pdfmetrics, page_width, page_height):
    regular = font_names["regular"]
    bold = font_names["bold"]
    pdf.setFillColorRGB(1, 1, 1)
    pdf.rect(0, 0, page_width, page_height, stroke=0, fill=1)
    pdf.setFillColorRGB(0, 0, 0)

    pdf.setFont(regular, 10.5)
    pdf.drawString(440, 790, "Приложение № 1-п")
    pdf.drawString(440, 776, "к Договору подряда")
    pdf.drawString(440, 762, f"от {values.get('DOC_DATE') or values.get('DOCUMENT_DATE') or ''}")
    pdf.setFont(bold, 13)
    quote_number = values.get("QUOTE_NUMBER") or ""
    pdf.drawCentredString(page_width / 2, 730, f"СПЕЦИФИКАЦИЯ № {quote_number}")
    pdf.setFont(regular, 11)
    pdf.drawString(72, 700, "1. Наименование, количество и стоимость продукции в партии.")

    table_x = 42
    table_top = 675
    table_width = page_width - 84
    number_width = 34
    quantity_width = 58
    amount_width = 96
    description_width = table_width - number_width - quantity_width - amount_width
    rows = values.get("_QUOTE_ROWS")
    if not isinstance(rows, list) or not rows:
        rows = [{
            "description": str(values.get("QUOTE_ITEMS") or ""),
            "quantity": "1",
            "amount": str(values.get("DEAL_VALUE") or ""),
        }]
    prepared_rows = []
    for row in rows:
        description_lines = _wrap_pdf_text(
            str(row.get("description") or "").splitlines(),
            description_width - 12,
            pdfmetrics,
            regular,
            9.5,
        )
        prepared_rows.append({
            **row,
            "description_lines": description_lines,
            "height": max(28, len(description_lines) * 11.5 + 10),
        })
    header_height = 28
    total_height = 30
    rows_height = sum(row["height"] for row in prepared_rows)
    table_bottom = table_top - header_height - rows_height - total_height

    pdf.setLineWidth(0.7)
    pdf.rect(table_x, table_bottom, table_width, header_height + rows_height + total_height, stroke=1, fill=0)
    pdf.line(table_x, table_top - header_height, table_x + table_width, table_top - header_height)
    description_x = table_x + number_width
    quantity_x = description_x + description_width
    amount_x = quantity_x + quantity_width
    body_bottom = table_bottom + total_height
    for boundary in (description_x, quantity_x, amount_x):
        pdf.line(boundary, body_bottom, boundary, table_top)
    row_y = table_top - header_height
    for row in prepared_rows:
        row_y -= row["height"]
        pdf.line(table_x, row_y, table_x + table_width, row_y)

    pdf.setFont(bold, 9.5)
    pdf.drawCentredString(table_x + number_width / 2, table_top - 18, "№")
    pdf.drawString(description_x + 6, table_top - 18, "Наименование")
    pdf.drawCentredString(quantity_x + quantity_width / 2, table_top - 18, "Кол-во")
    pdf.drawCentredString(amount_x + amount_width / 2, table_top - 18, "Сумма")

    row_top = table_top - header_height
    pdf.setFont(regular, 9.5)
    for index, row in enumerate(prepared_rows, start=1):
        row_middle = row_top - row["height"] / 2
        pdf.drawCentredString(table_x + number_width / 2, row_middle - 3, str(index))
        baseline = row_top - 13
        for line in row["description_lines"]:
            pdf.drawString(description_x + 6, baseline, line)
            baseline -= 11.5
        pdf.drawCentredString(quantity_x + quantity_width / 2, row_middle - 3, str(row.get("quantity") or ""))
        pdf.drawRightString(table_x + table_width - 7, row_middle - 3, str(row.get("amount") or ""))
        row_top -= row["height"]

    pdf.setFont(bold, 11)
    pdf.drawRightString(amount_x - 8, table_bottom + 10, "ИТОГО:")
    pdf.drawRightString(table_x + table_width - 8, table_bottom + 10, str(values.get("DEAL_VALUE") or ""))

    parties_top = min(table_bottom - 65, 470)
    _draw_contract_parties(pdf, values, font_names, pdfmetrics, parties_top)


def _build_standard_contract_overlay(page, page_index, values, canvas_module, pdfmetrics, font_names):
    overlay = BytesIO()
    width = float(page.mediabox.width)
    height = float(page.mediabox.height)
    pdf = canvas_module.Canvas(overlay, pagesize=(width, height))
    if page_index == 0:
        _draw_contract_first_page(pdf, values, font_names, pdfmetrics, width, height)
    elif page_index == 2:
        _draw_contract_requisites_page(pdf, values, font_names, pdfmetrics, width)
    elif page_index == 3:
        _draw_contract_specification_page(pdf, values, font_names, pdfmetrics, width, height)
    pdf.save()
    overlay.seek(0)
    return overlay


def _build_pdf_field_overlay(page, values, canvas_module, pdfmetrics, font_name):
    annotations = page.get("/Annots") or []
    widgets = [item.get_object() for item in annotations if item.get_object().get("/Subtype") == "/Widget"]
    if not widgets:
        return None

    overlay = BytesIO()
    width = float(page.mediabox.width)
    height = float(page.mediabox.height)
    pdf = canvas_module.Canvas(overlay, pagesize=(width, height))
    for widget in widgets:
        field_name = _pdf_field_name(widget)
        if not field_name or field_name not in values:
            continue
        rect = widget.get("/Rect")
        if not rect or len(rect) != 4:
            continue
        x1, y1, x2, y2 = (float(value) for value in rect)
        box_width = max(x2 - x1, 1)
        box_height = max(y2 - y1, 1)
        padding = 1.5
        text_width = max(box_width - padding * 2, 1)
        text_height = max(box_height - padding * 2, 1)
        value = str(values.get(field_name) or "")
        multiline = "\n" in value or box_height >= 30
        preferred_size = 8 if multiline else 9
        lines, font_size = _fit_pdf_text(
            value, text_width, text_height, pdfmetrics, font_name, preferred_size, multiline=multiline,
        )

        pdf.setFillColorRGB(1, 1, 1)
        # Keep the mask inside the widget so table borders from the template
        # remain intact while its visible placeholder text is covered.
        inset = 0.6
        pdf.rect(
            x1 + inset,
            y1 + inset,
            max(box_width - inset * 2, 0.1),
            max(box_height - inset * 2, 0.1),
            stroke=0,
            fill=1,
        )
        if not value:
            continue
        pdf.setFillColorRGB(0, 0, 0)
        pdf.setFont(font_name, font_size)
        if multiline:
            line_height = font_size * 1.18
            baseline = y2 - padding - font_size
            for line in lines:
                if baseline < y1 + padding - 0.5:
                    break
                pdf.drawString(x1 + padding, baseline, line)
                baseline -= line_height
        else:
            baseline = y1 + max((box_height - font_size) / 2, padding)
            pdf.drawString(x1 + padding, baseline, lines[0])
    pdf.save()
    overlay.seek(0)
    return overlay


def _document_money(value):
    if value in (None, ""):
        return ""
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return str(value)
    rendered = f"{amount:,.2f}".replace(",", " ")
    rendered = rendered[:-3] if rendered.endswith(".00") else rendered.replace(".", ",")
    return f"{rendered} руб."


def _document_address(address, entrance="", floor="", apartment=""):
    parts = [str(address or "").strip()]
    details = [
        f"подъезд {str(entrance).strip()}" if str(entrance or "").strip() else "",
        f"этаж {str(floor).strip()}" if str(floor or "").strip() else "",
        f"кв. {str(apartment).strip()}" if str(apartment or "").strip() else "",
    ]
    parts.extend(detail for detail in details if detail)
    return ", ".join(part for part in parts if part)


def build_project_document_values(project):
    client = project.client
    quote = CalculatorQuote.objects.filter(project=project).first()
    payload = quote.payload if quote and isinstance(quote.payload, dict) else {}
    raw_items = payload.get("items") if isinstance(payload.get("items"), list) else []
    item_lines = []
    quote_rows = []
    items_total = Decimal("0")
    for index, item in enumerate((item for item in raw_items if isinstance(item, dict)), start=1):
        title = str(
            item.get("positionName")
            or item.get("mirrorTitle")
            or item.get("constructionTitle")
            or "Изделие"
        ).strip()
        quantity = item.get("quantity") or 1
        result = item.get("result") if isinstance(item.get("result"), dict) else {}
        amount = result.get("total")
        try:
            line_total = Decimal(str(amount)) * Decimal(str(quantity)) if amount not in (None, "") else None
        except (InvalidOperation, TypeError, ValueError):
            line_total = None
        amount_label = f" – {_document_money(line_total)}" if line_total not in (None, "") else ""
        raw_details = item.get("details") if isinstance(item.get("details"), list) else []
        detail_parts = []
        for detail in raw_details:
            if not isinstance(detail, dict):
                continue
            label = str(detail.get("label") or "").strip()
            value = str(detail.get("value") or "").strip()
            if label and value:
                detail_parts.append(f"{label}: {value}")
        detail_label = f" ({'; '.join(detail_parts)})" if detail_parts else ""
        item_lines.append(f"{index}. {title}{detail_label} – {quantity} шт.{amount_label}")
        if line_total is not None:
            items_total += line_total
        quote_rows.append({
            "description": f"{title}{detail_label}",
            "quantity": str(quantity),
            "amount": _document_money(line_total) if line_total is not None else "",
            "amount_value": line_total,
        })

    if not item_lines:
        item_lines.append(f"1. {project.title or 'Изделие'} – 1 шт. – {_document_money(project.total_amount)}")

    full_name = (client.contract_full_name if client else "").strip()
    client_name = (client.name if client else project.client_name) or ""
    quote_number = str(getattr(quote, "number", "") or "")
    quote_items = "\n".join(item_lines)
    client_address = _document_address(
        client.address if client else "",
        floor=client.floor if client else "",
        apartment=client.apartment if client else "",
    )
    project_address = _document_address(project.object_address, project.entrance, project.floor, project.apartment)
    quote_total = None
    if quote:
        from .calculator_leads import quote_summary

        quote_total, _configuration = quote_summary(payload)
    document_total = quote_total if quote_total is not None else project.total_amount
    if quote_rows and quote_total is not None:
        difference = quote_total - items_total
        if difference > 0:
            quote_rows.append({
                "description": "Доставка",
                "quantity": "1",
                "amount": _document_money(difference),
                "amount_value": difference,
            })
        elif difference < 0:
            quote_rows.append({
                "description": "Скидка",
                "quantity": "1",
                "amount": _document_money(difference),
                "amount_value": difference,
            })
    if not quote_rows:
        quote_rows.append({
            "description": project.title or "Изделие",
            "quantity": "1",
            "amount": _document_money(document_total),
            "amount_value": document_total,
        })
    values = {
        "CLIENT_NAME": full_name or client_name,
        "CLIENT_FULL_NAME": full_name,
        "CLIENT_SHORT_NAME": client_name,
        "CLIENT_PHONE": (client.phone if client else project.client_phone) or "",
        "CLIENT_EMAIL": (client.email if client else project.client_email) or "",
        "CLIENT_ADDRESS": client_address,
        "CLIENT_ADDRESS_BASE": (client.address if client else "") or "",
        "PROJECT_ADDRESS": project_address,
        "OBJECT_ADDRESS": project_address,
        "PROJECT_ADDRESS_BASE": project.object_address or "",
        "PROJECT_ENTRANCE": project.entrance or "",
        "PROJECT_FLOOR": project.floor or "",
        "PROJECT_APARTMENT": project.apartment or "",
        "DEAL_VALUE": _document_money(document_total),
        "PROJECT_NUMBER": f"{project.order_number:04d}" if project.order_number else "",
        "PROJECT_TITLE": project.title or project.client_name or "",
        "QUOTE_NUMBER": quote_number,
        "QUOTE_ITEMS": quote_items,
        "_QUOTE_ROWS": quote_rows,
        "CONTRACT_SUBJECT": quote_items,
        "DOCUMENT_DATE": timezone.localdate().strftime("%d.%m.%Y"),
        "DOC_DATE": timezone.localdate().strftime("%d.%m.%Y"),
        "REMARKS": "Замечания отсутствуют",
    }
    for field_name in ("CLIENT_FULL_NAME", "CLIENT_ADDRESS", "CLIENT_PHONE", "PROJECT_ADDRESS"):
        for duplicate_index in range(2, 6):
            values[f"{field_name}_{duplicate_index}"] = values[field_name]
    return values


class ClientViewSet(viewsets.ModelViewSet):
    serializer_class = ClientSerializer
    permission_classes = [IsAuthenticatedAny]
    http_method_names = ["get", "post", "patch", "put", "delete", "head", "options"]

    def get_queryset(self):
        workspace = current_workspace(self.request.user)
        qs = Client.objects.filter(workspace=workspace).order_by("name", "id")
        query = (self.request.query_params.get("q") or "").strip()
        if query:
            phone_query = phone_search_digits(query)
            phone_filter = Q(phone__icontains=query)
            if phone_query:
                qs = qs.annotate(phone_digits=phone_digits_expression("phone"))
                phone_filter |= Q(phone_digits__icontains=phone_query)
            qs = qs.filter(
                Q(name__icontains=query)
                | phone_filter
                | Q(email__icontains=query)
                | Q(address__icontains=query)
            )
        return qs.distinct()

    def perform_create(self, serializer):
        client = serializer.save(workspace=current_workspace(self.request.user))
        create_audit_log(
            self.request.user,
            "client",
            client.id,
            "create",
            after=snapshot_model(client, ["id", "name", "phone", "email", "address", "address_lat", "address_lon", "apartment", "floor", "works_with_contract", "bonus_balance"]),
            workspace=client.workspace,
        )

    def perform_update(self, serializer):
        before = snapshot_model(serializer.instance, ["id", "name", "phone", "email", "address", "address_lat", "address_lon", "apartment", "floor", "works_with_contract", "bonus_balance"])
        client = serializer.save()
        Project.objects.filter(workspace=client.workspace, client=client).update(
            client_name=client.name,
            client_phone=client.phone or "",
            client_email=client.email,
            works_with_contract=client.works_with_contract,
        )
        create_audit_log(
            self.request.user,
            "client",
            client.id,
            "update",
            before=before,
            after=snapshot_model(client, ["id", "name", "phone", "email", "address", "address_lat", "address_lon", "apartment", "floor", "works_with_contract", "bonus_balance"]),
            workspace=client.workspace,
        )

    def perform_destroy(self, instance):
        before = snapshot_model(instance, ["id", "name", "phone", "email", "address", "address_lat", "address_lon", "apartment", "floor", "works_with_contract", "bonus_balance"])
        create_audit_log(self.request.user, "client", instance.id, "delete", before=before, workspace=instance.workspace)
        instance.delete()


class PaymentViewSet(viewsets.ModelViewSet):
    serializer_class = PaymentSerializer
    permission_classes = [IsAuthenticatedAny]

    def get_queryset(self):
        return _visible_payments(self.request.user).select_related(
            "project", "created_by", "category", "account", "destination_account"
        ).order_by("-paid_at")

    def perform_create(self, serializer):
        with transaction.atomic():
            payment = serializer.save(created_by=self.request.user)
            if payment.project_id:
                ensure_project_bonus_accrual(payment.project, actor=self.request.user)
            create_audit_log(
                self.request.user,
                "payment",
                payment.id,
                "create",
                after=snapshot_model(payment, ["id", "project_id", "operation_kind", "adjustment_direction", "category_id", "account_id", "destination_account_id", "paid_at", "amount", "type", "comment"]),
                workspace=payment.project.workspace if payment.project_id else current_workspace(self.request.user),
            )

    def perform_update(self, serializer):
        previous_project_id = serializer.instance.project_id
        before = snapshot_model(serializer.instance, ["id", "project_id", "operation_kind", "adjustment_direction", "category_id", "account_id", "destination_account_id", "paid_at", "amount", "type", "comment"])
        with transaction.atomic():
            payment = serializer.save()
            project_ids = {previous_project_id, payment.project_id}
            for project_id in project_ids:
                if project_id:
                    ensure_project_bonus_accrual(Project.objects.get(pk=project_id), actor=self.request.user)
            create_audit_log(
                self.request.user,
                "payment",
                payment.id,
                "update",
                before=before,
                after=snapshot_model(payment, ["id", "project_id", "operation_kind", "adjustment_direction", "category_id", "account_id", "destination_account_id", "paid_at", "amount", "type", "comment"]),
                workspace=payment.project.workspace if payment.project_id else current_workspace(self.request.user),
            )

    def perform_destroy(self, instance):
        payment_id = instance.id
        project_id = instance.project_id
        workspace = instance.project.workspace if instance.project_id else current_workspace(self.request.user)
        before = snapshot_model(instance, ["id", "project_id", "operation_kind", "adjustment_direction", "category_id", "account_id", "destination_account_id", "paid_at", "amount", "type", "comment"])
        with transaction.atomic():
            instance.delete()
            if project_id:
                ensure_project_bonus_accrual(Project.objects.get(pk=project_id), actor=self.request.user)
            create_audit_log(self.request.user, "payment", payment_id, "delete", before=before, workspace=workspace)


class ClientBonusTransactionViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = ClientBonusTransactionSerializer
    permission_classes = [IsAuthenticatedAny]

    def get_queryset(self):
        workspace = current_workspace(self.request.user)
        qs = ClientBonusTransaction.objects.select_related("client", "related_client", "project").filter(workspace=workspace)
        if not self.request.user.is_admin():
            qs = qs.filter(Q(project__isnull=True) | Q(project__manager=self.request.user))

        client_id = self.request.query_params.get("client")
        if client_id:
            qs = qs.filter(client_id=client_id)
        project_id = self.request.query_params.get("project")
        if project_id:
            qs = qs.filter(project_id=project_id)

        return qs.order_by("-created_at", "-id")


class ProjectCommentViewSet(viewsets.ModelViewSet):
    serializer_class = ProjectCommentSerializer
    permission_classes = [IsAuthenticatedAny]

    def get_queryset(self):
        workspace = current_workspace(self.request.user)
        qs = ProjectComment.objects.select_related("project", "author").filter(project__workspace=workspace).order_by("-created_at")
        if not self.request.user.is_admin():
            qs = qs.filter(project__manager=self.request.user)

        project_id = self.request.query_params.get("project")
        if project_id:
            qs = qs.filter(project_id=project_id)

        return qs

    def perform_create(self, serializer):
        comment = serializer.save(author=self.request.user)
        create_audit_log(
            self.request.user,
            "comment",
            comment.id,
            "create",
            after=snapshot_model(comment, ["id", "project_id", "text"]),
            workspace=comment.project.workspace,
        )

    def perform_update(self, serializer):
        before = snapshot_model(serializer.instance, ["id", "project_id", "text"])
        comment = serializer.save()
        create_audit_log(
            self.request.user,
            "comment",
            comment.id,
            "update",
            before=before,
            after=snapshot_model(comment, ["id", "project_id", "text"]),
            workspace=comment.project.workspace,
        )

    def perform_destroy(self, instance):
        workspace = instance.project.workspace
        before = snapshot_model(instance, ["id", "project_id", "text"])
        create_audit_log(self.request.user, "comment", instance.id, "delete", before=before, workspace=workspace)
        instance.delete()


class ProductionPlanViewSet(viewsets.ModelViewSet):
    serializer_class = ProductionPlanSerializer
    permission_classes = [IsAuthenticatedAny]

    def get_queryset(self):
        workspace = current_workspace(self.request.user)
        queryset = ProductionPlan.objects.select_related("project", "created_by", "approved_by").filter(workspace=workspace)
        if not self.request.user.is_admin():
            queryset = queryset.filter(project__manager=self.request.user)
        project_id = self.request.query_params.get("project")
        if project_id:
            queryset = queryset.filter(project_id=project_id)
        return queryset.order_by("-revision", "-id")

    def perform_destroy(self, instance):
        if instance.status == ProductionPlan.Status.APPROVED:
            raise ValidationError({"detail": "Утвержденную ревизию удалить нельзя."})
        instance.delete()

    @action(detail=True, methods=["post"])
    def approve(self, request, pk=None):
        plan = self.get_object()
        if not request.user.is_admin():
            return Response({"detail": "Утверждать чертежи может только администратор."}, status=drf_status.HTTP_403_FORBIDDEN)
        if request.data.get("confirm") is not True:
            return Response({"detail": "Для утверждения передайте confirm=true."}, status=drf_status.HTTP_400_BAD_REQUEST)
        if plan.blocking_questions:
            return Response({"detail": "Сначала закройте все обязательные вопросы."}, status=drf_status.HTTP_400_BAD_REQUEST)
        if plan.status != ProductionPlan.Status.READY_FOR_REVIEW:
            return Response({"detail": "Сначала переведите задание в статус готовности к проверке."}, status=drf_status.HTTP_400_BAD_REQUEST)
        plan.status = ProductionPlan.Status.APPROVED
        plan.approved_by = request.user
        plan.approved_at = timezone.now()
        plan.save(update_fields=["status", "approved_by", "approved_at", "updated_at"])
        create_audit_log(
            request.user,
            "production_plan",
            plan.id,
            "approve",
            after={"project_id": plan.project_id, "revision": plan.revision, "status": plan.status},
            workspace=plan.workspace,
        )
        return Response(self.get_serializer(plan).data)


class MeasurementSheetViewSet(viewsets.ModelViewSet):
    serializer_class = MeasurementSheetSerializer
    permission_classes = [IsAuthenticatedAny]

    def get_queryset(self):
        queryset = MeasurementSheet.objects.prefetch_related("photos").filter(workspace=current_workspace(self.request.user))
        if not self.request.user.is_admin():
            queryset = queryset.filter(project__manager=self.request.user)
        project_id = self.request.query_params.get("project")
        return queryset.filter(project_id=project_id) if project_id else queryset

    def perform_create(self, serializer):
        sheet = serializer.save()
        sync_measurement_drawings_to_yandex(sheet)

    def perform_update(self, serializer):
        sheet = serializer.save()
        sync_measurement_drawings_to_yandex(sheet)

    @action(detail=True, methods=["post"], parser_classes=[MultiPartParser, FormParser], url_path="photos")
    def upload_photos(self, request, pk=None):
        sheet = self.get_object()
        files = request.FILES.getlist("files") or request.FILES.getlist("file")
        if not files:
            return Response({"detail": "Прикрепите хотя бы одну фотографию."}, status=drf_status.HTTP_400_BAD_REQUEST)
        for uploaded in files:
            MeasurementPhoto.objects.create(sheet=sheet, file=uploaded, original_name=uploaded.name or "photo")
        sheet.refresh_from_db()
        return Response(self.get_serializer(sheet).data)


def _normalized_scan_number(value, field_name):
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValidationError({"result": f"Поле {field_name} должно быть числом."})
    if number < 0 or number > 1:
        raise ValidationError({"result": f"Поле {field_name} должно быть в диапазоне от 0 до 1."})
    return round(number, 6)


def _scan_confidence(value):
    try:
        return round(max(0.0, min(float(value or 0), 1.0)), 4)
    except (TypeError, ValueError):
        return 0.0


def _scan_wall_size_mm(value, field_name):
    try:
        number = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        raise ValidationError({"result": f"Поле {field_name} должно быть числом."})
    if not number.is_finite() or number < 100 or number > 20000:
        raise ValidationError({"result": f"Поле {field_name} должно быть от 100 до 20000 мм."})
    return int(number.to_integral_value())


def _validated_measurement_scan_result(value):
    if not isinstance(value, dict):
        raise ValidationError({"result": "Результат сканирования должен быть объектом."})
    if len(json.dumps(value, ensure_ascii=False)) > 2_000_000:
        raise ValidationError({"result": "Результат сканирования слишком большой."})

    wall = value.get("wall") if isinstance(value.get("wall"), dict) else {}
    raw_contour = wall.get("contour") if isinstance(wall.get("contour"), list) else []
    if len(raw_contour) > 200:
        raise ValidationError({"result": "Контур стены содержит слишком много точек."})
    contour = []
    for index, point in enumerate(raw_contour):
        if not isinstance(point, dict):
            raise ValidationError({"result": f"Точка контура {index + 1} имеет неверный формат."})
        contour.append({
            "x": _normalized_scan_number(point.get("x"), f"contour[{index}].x"),
            "y": _normalized_scan_number(point.get("y"), f"contour[{index}].y"),
        })

    allowed_types = {"socket_single", "socket_double", "socket_triple", "cut_circle", "cut_rect", "power"}
    raw_elements = value.get("elements") if isinstance(value.get("elements"), list) else []
    if len(raw_elements) > 200:
        raise ValidationError({"result": "Найдено слишком много объектов на стене."})
    elements = []
    for index, element in enumerate(raw_elements):
        if not isinstance(element, dict) or element.get("type") not in allowed_types:
            raise ValidationError({"result": f"Объект {index + 1} имеет неподдерживаемый тип."})
        normalized = {
            "type": element["type"],
            "x": _normalized_scan_number(element.get("x"), f"elements[{index}].x"),
            "y": _normalized_scan_number(element.get("y"), f"elements[{index}].y"),
            "confidence": _scan_confidence(element.get("confidence")),
        }
        for key in ("width", "height", "diameter"):
            if element.get(key) is not None:
                normalized[key] = _normalized_scan_number(element.get(key), f"elements[{index}].{key}")
        if element.get("label"):
            normalized["label"] = str(element["label"])[:120]
        elements.append(normalized)

    normalized_wall = {"contour": contour, "confidence": _scan_confidence(wall.get("confidence"))}
    for key in ("width_mm", "height_mm"):
        if wall.get(key) is not None:
            normalized_wall[key] = _scan_wall_size_mm(wall[key], key)

    return {
        "schema_version": 1,
        "wall": normalized_wall,
        "elements": elements,
        "warnings": [str(item)[:300] for item in (value.get("warnings") or []) if str(item).strip()][:50],
    }


class MeasurementScanSessionViewSet(viewsets.ModelViewSet):
    serializer_class = MeasurementScanSessionSerializer
    permission_classes = [IsAuthenticatedAny]
    http_method_names = ["get", "post", "head", "options"]

    def get_queryset(self):
        queryset = MeasurementScanSession.objects.filter(workspace=current_workspace(self.request.user)).select_related("project")
        if not self.request.user.is_admin():
            queryset = queryset.filter(project__manager=self.request.user)
        project_id = self.request.query_params.get("project")
        return queryset.filter(project_id=project_id) if project_id else queryset

    def retrieve(self, request, *args, **kwargs):
        scan_session = self.get_object()
        if scan_session.status == MeasurementScanSession.Status.PENDING and scan_session.is_expired():
            scan_session.status = MeasurementScanSession.Status.EXPIRED
            scan_session.save(update_fields=["status", "updated_at"])
        return Response(self.get_serializer(scan_session).data)

    @action(detail=True, methods=["post"], permission_classes=[AllowAny], authentication_classes=[], url_path="complete")
    def complete(self, request, pk=None):
        try:
            scan_session = MeasurementScanSession.objects.select_related("project").get(pk=pk)
        except (MeasurementScanSession.DoesNotExist, ValueError):
            return Response({"detail": "Сессия сканирования не найдена."}, status=drf_status.HTTP_404_NOT_FOUND)

        token = request.headers.get("X-Scan-Token") or request.data.get("token")
        if not token or not hmac.compare_digest(scan_session.token_hash, MeasurementScanSession.hash_token(token)):
            return Response({"detail": "Неверный токен сканирования."}, status=drf_status.HTTP_403_FORBIDDEN)
        if scan_session.is_expired():
            if scan_session.status == MeasurementScanSession.Status.PENDING:
                scan_session.status = MeasurementScanSession.Status.EXPIRED
                scan_session.save(update_fields=["status", "updated_at"])
            return Response({"detail": "Сессия сканирования истекла. Запустите её заново из CRM."}, status=drf_status.HTTP_410_GONE)
        if scan_session.status in {MeasurementScanSession.Status.COMPLETED, MeasurementScanSession.Status.APPLIED}:
            return Response({"id": scan_session.id, "status": scan_session.status})

        scan_session.result = _validated_measurement_scan_result(request.data.get("result"))
        scan_session.status = MeasurementScanSession.Status.COMPLETED
        scan_session.completed_at = timezone.now()
        scan_session.save(update_fields=["result", "status", "completed_at", "updated_at"])
        return Response({"id": scan_session.id, "status": scan_session.status})

    @action(detail=True, methods=["post"], url_path="applied")
    def applied(self, request, pk=None):
        scan_session = self.get_object()
        if scan_session.status == MeasurementScanSession.Status.COMPLETED:
            scan_session.status = MeasurementScanSession.Status.APPLIED
            scan_session.save(update_fields=["status", "updated_at"])
        return Response(self.get_serializer(scan_session).data)


class ProjectStatusViewSet(viewsets.ModelViewSet):
    serializer_class = ProjectStatusSerializer
    http_method_names = ["get", "post", "patch", "put", "delete", "head", "options"]

    def get_queryset(self):
        return ProjectStatus.objects.filter(workspace=current_workspace(self.request.user)).order_by("sort_order", "id")

    def get_permissions(self):
        if self.action in {"list", "retrieve"}:
            return [IsAuthenticatedAny()]
        return [IsAdmin()]

    def perform_destroy(self, instance):
        if Project.objects.filter(workspace=instance.workspace, status=instance.code).exists():
            raise ValidationError({"status": "Нельзя удалить статус, который используется в проектах."})

        was_default = instance.is_default
        instance.delete()

        if was_default:
            fallback = ProjectStatus.objects.filter(workspace=instance.workspace).order_by("sort_order", "id").first()
            if fallback and not fallback.is_default:
                fallback.is_default = True
                fallback.save(update_fields=["is_default"])

    def perform_create(self, serializer):
        serializer.save(workspace=current_workspace(self.request.user))


class FinanceCategoryViewSet(viewsets.ModelViewSet):
    serializer_class = FinanceCategorySerializer
    http_method_names = ["get", "post", "patch", "put", "delete", "head", "options"]

    def get_queryset(self):
        return FinanceCategory.objects.filter(workspace=current_workspace(self.request.user)).order_by("type", "sort_order", "id")

    def get_permissions(self):
        if self.action in {"list", "retrieve"}:
            return [IsAuthenticatedAny()]
        return [IsAdmin()]

    def perform_create(self, serializer):
        serializer.save(workspace=current_workspace(self.request.user))


class AccountViewSet(viewsets.ModelViewSet):
    serializer_class = AccountSerializer
    http_method_names = ["get", "post", "patch", "put", "delete", "head", "options"]

    def get_queryset(self):
        return Account.objects.filter(workspace=current_workspace(self.request.user)).order_by("name", "id")

    def get_permissions(self):
        if self.action in {"list", "retrieve"}:
            return [IsAuthenticatedAny()]
        return [IsAdmin()]

    def perform_create(self, serializer):
        serializer.save(workspace=current_workspace(self.request.user))


class ProjectCustomFieldViewSet(viewsets.ModelViewSet):
    serializer_class = ProjectCustomFieldSerializer
    http_method_names = ["get", "post", "patch", "put", "delete", "head", "options"]

    def get_queryset(self):
        return ProjectCustomField.objects.filter(workspace=current_workspace(self.request.user)).order_by("sort_order", "id")

    def get_permissions(self):
        if self.action in {"list", "retrieve"}:
            return [IsAuthenticatedAny()]
        return [IsAdmin()]

    def perform_create(self, serializer):
        serializer.save(workspace=current_workspace(self.request.user))


class DocumentTemplateViewSet(viewsets.ModelViewSet):
    serializer_class = DocumentTemplateSerializer
    permission_classes = [IsAdmin]
    parser_classes = [MultiPartParser, FormParser]
    http_method_names = ["get", "post", "patch", "put", "delete", "head", "options"]

    def get_queryset(self):
        return DocumentTemplate.objects.filter(workspace=current_workspace(self.request.user)).order_by("type")

    def perform_create(self, serializer):
        uploaded_file = serializer.validated_data.get("file")
        original_name = serializer.validated_data.get("original_name") or getattr(uploaded_file, "name", "")
        serializer.save(workspace=current_workspace(self.request.user), uploaded_by=self.request.user, original_name=original_name)

    def perform_update(self, serializer):
        uploaded_file = serializer.validated_data.get("file")
        original_name = serializer.validated_data.get("original_name") or getattr(uploaded_file, "name", "")
        serializer.save(uploaded_by=self.request.user, original_name=original_name)


class TaskViewSet(viewsets.ModelViewSet):
    serializer_class = TaskSerializer
    permission_classes = [IsAuthenticatedAny]

    def get_queryset(self):
        workspace = current_workspace(self.request.user)
        qs = Task.objects.select_related("assignee", "created_by", "project", "parent_task").prefetch_related("subtasks").filter(assignee__workspace=workspace).order_by("status", "due_date", "-created_at")
        qs = qs.filter(Q(project__isnull=True) | Q(project__workspace=workspace))
        if not self.request.user.is_admin():
            qs = qs.filter(assignee=self.request.user)

        project_id = self.request.query_params.get("project")
        if project_id:
            qs = qs.filter(project_id=project_id)
        parent_id = self.request.query_params.get("parent_task")
        if parent_id:
            qs = qs.filter(parent_task_id=parent_id)

        # Legacy tasks continue to use their due date until explicitly scheduled.
        day = self.request.query_params.get("date")
        if day:
            from django.utils.dateparse import parse_date
            from rest_framework.exceptions import ValidationError
            try:
                valid_day = parse_date(day)
            except ValueError:
                valid_day = None
            if not valid_day:
                raise ValidationError({"date": "Укажите дату в формате YYYY-MM-DD."})
            qs = qs.filter(Q(scheduled_date=valid_day) | Q(scheduled_date__isnull=True, due_date=valid_day))
        for field in ("city", "district", "status"):
            value = self.request.query_params.get(field)
            if value:
                qs = qs.filter(**{field: value})

        return qs

    def perform_create(self, serializer):
        assignee = serializer.validated_data.get("assignee") or self.request.user
        task = serializer.save(created_by=self.request.user, assignee=assignee)
        create_audit_log(
            self.request.user,
            "task",
            task.id,
            "create",
            after=snapshot_model(task, ["id", "project_id", "parent_task_id", "title", "status", "priority", "due_date", "scheduled_date", "city", "district", "address"]),
            workspace=getattr(task.project, "workspace", current_workspace(self.request.user)),
        )

    def perform_update(self, serializer):
        before = snapshot_model(serializer.instance, ["id", "project_id", "parent_task_id", "title", "status", "priority", "due_date", "scheduled_date", "city", "district", "address"])
        task = serializer.save()
        create_audit_log(
            self.request.user,
            "task",
            task.id,
            "update",
            before=before,
            after=snapshot_model(task, ["id", "project_id", "parent_task_id", "title", "status", "priority", "due_date", "scheduled_date", "city", "district", "address"]),
            workspace=getattr(task.project, "workspace", current_workspace(self.request.user)),
        )

    def perform_destroy(self, instance):
        workspace = getattr(instance.project, "workspace", current_workspace(self.request.user))
        before = snapshot_model(instance, ["id", "project_id", "parent_task_id", "title", "status", "priority", "due_date", "scheduled_date", "city", "district", "address"])
        create_audit_log(self.request.user, "task", instance.id, "delete", before=before, workspace=workspace)
        instance.delete()


class TaskTemplateViewSet(viewsets.ModelViewSet):
    serializer_class = TaskTemplateSerializer
    http_method_names = ["get", "post", "patch", "put", "delete", "head", "options"]

    def get_queryset(self):
        return (
            TaskTemplate.objects.select_related("status")
            .filter(workspace=current_workspace(self.request.user))
            .order_by("status__sort_order", "sort_order", "id")
        )

    def get_permissions(self):
        if self.action in {"list", "retrieve"}:
            return [IsAuthenticatedAny()]
        return [IsAdmin()]

    def perform_create(self, serializer):
        template = serializer.save(workspace=current_workspace(self.request.user))
        create_audit_log(
            self.request.user,
            "task_template",
            template.id,
            "create",
            after=snapshot_model(template, ["id", "status_id", "title", "due_in_days", "priority", "auto_create", "sort_order"]),
            workspace=template.workspace,
        )

    def perform_update(self, serializer):
        before = snapshot_model(serializer.instance, ["id", "status_id", "title", "due_in_days", "priority", "auto_create", "sort_order"])
        template = serializer.save()
        create_audit_log(
            self.request.user,
            "task_template",
            template.id,
            "update",
            before=before,
            after=snapshot_model(template, ["id", "status_id", "title", "due_in_days", "priority", "auto_create", "sort_order"]),
            workspace=template.workspace,
        )

    def perform_destroy(self, instance):
        before = snapshot_model(instance, ["id", "status_id", "title", "due_in_days", "priority", "auto_create", "sort_order"])
        create_audit_log(self.request.user, "task_template", instance.id, "delete", before=before, workspace=instance.workspace)
        instance.delete()


class AuditLogViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = AuditLogSerializer
    permission_classes = [IsAdmin]

    def get_queryset(self):
        return AuditLog.objects.select_related("actor").filter(workspace=current_workspace(self.request.user)).order_by("-created_at", "-id")


class UserViewSet(viewsets.ModelViewSet):
    serializer_class = AdminUserSerializer
    permission_classes = [IsAdmin]
    http_method_names = ["get", "post", "patch", "put", "head", "options"]

    def get_queryset(self):
        return User.objects.filter(workspace=current_workspace(self.request.user)).order_by("date_joined", "id")

    def perform_create(self, serializer):
        serializer.save(workspace=current_workspace(self.request.user))
