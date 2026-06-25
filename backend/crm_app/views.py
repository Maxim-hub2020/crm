import json
import logging
import uuid
from io import BytesIO

from django.core.files.storage import default_storage
from django.db import transaction
from django.db.models import F, Q, Value
from django.db.models.functions import Replace
from django.http import FileResponse
from django.utils import timezone
from django.utils.dateparse import parse_date
from django.utils.text import get_valid_filename
from rest_framework import viewsets
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.exceptions import ValidationError
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response
from rest_framework import status as drf_status

from .ai_assistant import CRMAssistantService, GeminiClient, GeminiConfigurationError, GeminiRequestError
from .bonuses import ensure_project_bonus_accrual, preview_project_bonus_promo_code, reverse_project_bonus_effects
from .finance_analytics import (
    build_cash_forecast,
    build_finance_overview,
    build_project_finance_analytics,
    compact_cash_forecast_for_ai,
    compact_finance_overview_for_ai,
)
from .models import (
    Account,
    AuditLog,
    ChatIntegrationSettings,
    Client,
    ClientBonusTransaction,
    DocumentTemplate,
    FinanceCategory,
    Payment,
    Project,
    ProjectComment,
    ProjectCustomField,
    ProjectStatus,
    SubscriptionInvoice,
    Task,
    TaskTemplate,
    User,
    YandexDiskSettings,
)
from .permissions import HasActiveSubscription, HasAssistantSubscription, IsAdmin, IsAuthenticatedAny
from .phones import phone_search_digits
from .serializers import (
    AdminUserSerializer,
    AccountSerializer,
    AuditLogSerializer,
    ChatIntegrationSettingsSerializer,
    ClientBonusTransactionSerializer,
    ClientSerializer,
    DocumentTemplateSerializer,
    FinanceCategorySerializer,
    MeSerializer,
    PaymentSerializer,
    ProjectCommentSerializer,
    ProjectCustomFieldSerializer,
    ProjectStatusSerializer,
    ProjectSerializer,
    TaskSerializer,
    TaskTemplateSerializer,
    YandexDiskSettingsSerializer,
)
from .subscription import (
    activate_subscription_invoice,
    billing_summary_payload,
    can_create_trial_project,
    get_workspace_subscription,
    is_subscription_active,
    issue_subscription_invoice,
    record_project_created,
)
from .tenancy import current_workspace
from .workflow import apply_task_templates_for_project, build_project_status_check, create_audit_log, snapshot_model, user_display_name
from .yandex_disk import YandexDiskError, archive_project_disk_folder, ensure_project_disk_folder, is_archive_project_status, list_disk_folders

logger = logging.getLogger(__name__)


def phone_digits_expression(field_name):
    expression = F(field_name)
    for char in ("+", "-", " ", "(", ")"):
        expression = Replace(expression, Value(char), Value(""))
    return expression


def _request_params(request):
    return request.data if request.method == "POST" else request.query_params


def _visible_finance_projects(user):
    workspace = current_workspace(user)
    queryset = Project.objects.filter(workspace=workspace)
    if user.is_admin():
        return queryset
    return queryset.filter(manager=user)


def _finance_scope(request):
    params = _request_params(request)
    project_queryset = _visible_finance_projects(request.user)
    project_id = str(params.get("project") or params.get("project_id") or "").strip()
    if project_id and project_id != "all":
        project_queryset = project_queryset.filter(id=project_id)

    payment_queryset = Payment.objects.filter(project__in=project_queryset)

    operation_kind = str(params.get("kind") or params.get("category_kind") or "").strip()
    if operation_kind in FinanceCategory.Type.values:
        payment_queryset = payment_queryset.filter(category__type=operation_kind)

    category_id = str(params.get("category") or "").strip()
    if category_id and category_id != "all":
        payment_queryset = payment_queryset.filter(category_id=category_id)

    account_id = str(params.get("account") or "").strip()
    if account_id and account_id != "all":
        payment_queryset = payment_queryset.filter(account_id=account_id)

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


def _build_finance_ai_text(overview):
    compact_payload = compact_finance_overview_for_ai(overview)
    client = GeminiClient()
    response = client.generate_content(
        model=client.fast_model,
        system_instruction=(
            "Отвечай максимум 5 короткими пунктами, без вступления и длинных объяснений. "
            "Ты финансовый аналитик CRM производства мебели/стекла. "
            "Пиши по-русски, кратко и по делу. Анализируй только переданные цифры. "
            "Если данных мало, прямо скажи, какие операции или расходники нужно внести."
        ),
        contents=[
            {
                "role": "user",
                "parts": [
                    {
                        "text": (
                            "Коротко оцени маржу, риски, прогноз расходов и что проверить.\n\n"
                            "Проанализируй финансовую выборку CRM. Дай: 1) короткий вывод, "
                            "2) риски, 3) что проверить по проектам, 4) конкретные рекомендации.\n\n"
                            f"{json.dumps(compact_payload, ensure_ascii=False)}"
                        )
                    }
                ],
            }
        ],
        temperature=0.2,
        max_output_tokens=500,
    )
    content = client.extract_candidate_content(response)
    return client.extract_text(content)


def _build_cash_forecast_ai_text(forecast):
    compact_payload = compact_cash_forecast_for_ai(forecast)
    client = GeminiClient()
    response = client.generate_content(
        model=client.fast_model,
        system_instruction=(
            "Ты финансовый аналитик CRM. Дай кассовый прогноз максимум 5 короткими пунктами. "
            "Пиши по-русски, без вступления. Не придумывай цифры вне переданного JSON. "
            "Если есть риск кассового разрыва, назови период и что сделать первым."
        ),
        contents=[
            {
                "role": "user",
                "parts": [
                    {
                        "text": (
                            "Проанализируй кассовый прогноз CRM: входящий поток, расходы, ожидаемые оплаты, "
                            "будущий баланс и риски.\n\n"
                            f"{json.dumps(compact_payload, ensure_ascii=False)}"
                        )
                    }
                ],
            }
        ],
        temperature=0.2,
        max_output_tokens=450,
    )
    content = client.extract_candidate_content(response)
    return client.extract_text(content)


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
    return {
        "type": "payment",
        "id": payment.id,
        "project_id": payment.project_id,
        "title": f"{getattr(payment.category, 'name', '') or 'Операция'} · {payment.amount} ₽",
        "subtitle": " · ".join([value for value in [getattr(payment.project, "title", ""), payment.comment] if value]),
        "route": "/projects",
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


@api_view(["GET"])
@permission_classes([])
def health_view(_request):
    return Response({"status": "ok"})


@api_view(["GET"])
@permission_classes([IsAuthenticatedAny])
def billing_summary_view(request):
    return Response(billing_summary_payload(request.user))


@api_view(["POST"])
@permission_classes([IsAdmin])
def billing_create_invoice_view(request):
    invoice = issue_subscription_invoice(actor=request.user, plan_code=request.data.get("plan_code"))
    return Response(
        {
            "detail": "Счет на подписку создан.",
            "invoice_id": invoice.id,
            "summary": billing_summary_payload(request.user),
        },
        status=drf_status.HTTP_201_CREATED,
    )


@api_view(["POST"])
@permission_classes([IsAdmin])
def billing_activate_invoice_view(request):
    invoice_id = request.data.get("invoice_id")
    if not invoice_id:
        return Response({"detail": "Укажите invoice_id."}, status=drf_status.HTTP_400_BAD_REQUEST)

    invoice = SubscriptionInvoice.objects.select_related("subscription", "plan").filter(id=invoice_id).first()
    if not invoice:
        return Response({"detail": "Счет не найден."}, status=drf_status.HTTP_404_NOT_FOUND)

    activate_subscription_invoice(invoice)
    return Response(
        {
            "detail": "Подписка активирована.",
            "summary": billing_summary_payload(request.user),
        }
    )


@api_view(["POST"])
@permission_classes([IsAuthenticatedAny, HasActiveSubscription])
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
@permission_classes([IsAuthenticatedAny, HasActiveSubscription])
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
@permission_classes([IsAuthenticatedAny, HasActiveSubscription])
def yandex_disk_settings_view(request):
    workspace = current_workspace(request.user)
    settings, _created = YandexDiskSettings.objects.get_or_create(workspace=workspace)

    if request.method == "GET":
        return Response(YandexDiskSettingsSerializer(settings).data)

    if not request.user.is_admin():
        return Response({"detail": "Настройки Яндекс.Диска может менять только администратор."}, status=drf_status.HTTP_403_FORBIDDEN)

    serializer = YandexDiskSettingsSerializer(settings, data=request.data, partial=True)
    serializer.is_valid(raise_exception=True)
    serializer.save(updated_by=request.user)
    return Response(serializer.data)


@api_view(["GET"])
@permission_classes([IsAuthenticatedAny, HasActiveSubscription])
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


@api_view(["GET"])
@permission_classes([IsAuthenticatedAny, HasActiveSubscription])
def address_suggestions_view(request):
    query = (request.query_params.get("q") or "").strip()
    if len(query) < 3:
        return Response({"suggestions": [], "configured": bool(CRMAssistantService._dadata_api_key())})

    if not CRMAssistantService._dadata_api_key():
        return Response(
            {
                "suggestions": [],
                "configured": False,
                "detail": "DADATA_API_KEY не настроен в backend .env.",
            }
        )

    suggestions = CRMAssistantService._suggest_dadata_address(query, count=6)
    return Response(
        {
            "configured": bool(CRMAssistantService._dadata_api_key()),
            "default_region": CRMAssistantService._dadata_default_region(),
            "suggestions": [
                {
                    "value": item.get("value") or "",
                    "unrestricted_value": item.get("unrestricted_value") or item.get("value") or "",
                    "lat": (item.get("data") or {}).get("geo_lat") or "",
                    "lon": (item.get("data") or {}).get("geo_lon") or "",
                }
                for item in suggestions
                if isinstance(item, dict)
            ],
        }
    )


@api_view(["GET"])
@permission_classes([IsAuthenticatedAny, HasActiveSubscription])
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


@api_view(["POST"])
@permission_classes([IsAuthenticatedAny, HasAssistantSubscription])
def finance_analytics_ai_view(request):
    project_queryset, payment_queryset, filters = _finance_scope(request)
    reference_queryset = _visible_finance_projects(request.user)
    overview = build_finance_overview(
        project_queryset,
        payment_queryset,
        filters=filters,
        reference_projects_queryset=reference_queryset,
    )

    try:
        analysis = _build_finance_ai_text(overview)
    except GeminiConfigurationError as exc:
        return Response({"detail": str(exc)}, status=drf_status.HTTP_503_SERVICE_UNAVAILABLE)
    except GeminiRequestError as exc:
        return Response({"detail": str(exc)}, status=drf_status.HTTP_502_BAD_GATEWAY)

    return Response({"analysis": analysis, "overview": overview})


@api_view(["GET"])
@permission_classes([IsAuthenticatedAny, HasActiveSubscription])
def cash_forecast_view(request):
    project_queryset, payment_queryset, filters = _finance_scope(request)
    reference_queryset = _visible_finance_projects(request.user)
    return Response(
        build_cash_forecast(
            project_queryset,
            payment_queryset,
            reference_projects_queryset=reference_queryset,
        )
    )


@api_view(["POST"])
@permission_classes([IsAuthenticatedAny, HasAssistantSubscription])
def cash_forecast_ai_view(request):
    project_queryset, payment_queryset, filters = _finance_scope(request)
    reference_queryset = _visible_finance_projects(request.user)
    forecast = build_cash_forecast(
        project_queryset,
        payment_queryset,
        reference_projects_queryset=reference_queryset,
    )

    try:
        analysis = _build_cash_forecast_ai_text(forecast)
    except GeminiConfigurationError as exc:
        return Response({"detail": str(exc)}, status=drf_status.HTTP_503_SERVICE_UNAVAILABLE)
    except GeminiRequestError as exc:
        return Response({"detail": str(exc)}, status=drf_status.HTTP_502_BAD_GATEWAY)

    return Response({"analysis": analysis, "forecast": forecast})


@api_view(["GET"])
@permission_classes([IsAuthenticatedAny, HasActiveSubscription])
def global_search_view(request):
    query = str(request.query_params.get("q") or "").strip()
    if len(query) < 2:
        return Response({"query": query, "results": []})

    workspace = current_workspace(request.user)
    phone_query = phone_search_digits(query)
    project_queryset = Project.objects.filter(workspace=workspace).select_related("client")
    if not request.user.is_admin():
        project_queryset = project_queryset.filter(manager=request.user)

    project_filter = (
        Q(title__icontains=query)
        | Q(client_name__icontains=query)
        | Q(client_phone__icontains=query)
        | Q(object_address__icontains=query)
        | Q(description__icontains=query)
    )
    if phone_query:
        project_filter |= Q(client_phone__icontains=phone_query)
    projects = list(project_queryset.filter(project_filter).order_by("-updated_at")[:8])

    client_queryset = Client.objects.filter(workspace=workspace)
    client_filter = Q(name__icontains=query) | Q(phone__icontains=query) | Q(email__icontains=query) | Q(address__icontains=query)
    if phone_query:
        client_filter |= Q(phone__icontains=phone_query)
    clients = list(client_queryset.filter(client_filter).order_by("name")[:6])

    task_queryset = Task.objects.select_related("project").filter(assignee__workspace=workspace)
    task_queryset = task_queryset.filter(Q(project__isnull=True) | Q(project__workspace=workspace))
    if not request.user.is_admin():
        task_queryset = task_queryset.filter(assignee=request.user)
    tasks = list(task_queryset.filter(Q(title__icontains=query) | Q(notes__icontains=query) | Q(project__title__icontains=query)).order_by("status", "due_date")[:6])

    payment_queryset = Payment.objects.select_related("project", "category").filter(project__in=project_queryset)
    payments = list(
        payment_queryset.filter(
            Q(comment__icontains=query)
            | Q(project__title__icontains=query)
            | Q(project__client_name__icontains=query)
            | Q(category__name__icontains=query)
        ).order_by("-paid_at")[:6]
    )

    comments = list(
        ProjectComment.objects.select_related("project")
        .filter(project__in=project_queryset, text__icontains=query)
        .order_by("-created_at")[:6]
    )

    results = []
    results.extend(_project_result(project) for project in projects)
    results.extend(_client_result(client) for client in clients)
    results.extend(_task_result(task) for task in tasks)
    results.extend(_payment_result(payment) for payment in payments)
    results.extend(_comment_result(comment) for comment in comments)

    return Response({"query": query, "results": results[:30]})


@api_view(["POST"])
@permission_classes([IsAuthenticatedAny, HasAssistantSubscription])
def assistant_chat_view(request):
    message = (request.data.get("message") or "").strip()
    history = request.data.get("history") or []

    if not message:
        return Response({"detail": "Сообщение не может быть пустым."}, status=drf_status.HTTP_400_BAD_REQUEST)

    try:
        fast_service = CRMAssistantService(request.user, init_gemini_client=False)
        fast_result = fast_service._fast_mutation_clarification(message) or fast_service._fast_crm_answer(message)
        if fast_result:
            return Response(fast_result)

        result = CRMAssistantService(request.user).handle_message(message, history=history)
        return Response(result)
    except GeminiConfigurationError as exc:
        return Response({"detail": str(exc)}, status=drf_status.HTTP_503_SERVICE_UNAVAILABLE)
    except GeminiRequestError as exc:
        return Response({"detail": str(exc)}, status=drf_status.HTTP_502_BAD_GATEWAY)
    except ValueError as exc:
        return Response({"detail": str(exc)}, status=drf_status.HTTP_400_BAD_REQUEST)


@api_view(["POST"])
@permission_classes([IsAuthenticatedAny, HasAssistantSubscription])
def assistant_voice_view(request):
    audio_file = request.FILES.get("audio")
    raw_history = request.data.get("history") or "[]"
    include_audio = str(request.data.get("include_audio", "1")).strip().lower() not in {"0", "false", "no", "off"}

    if isinstance(raw_history, str):
        try:
            history = json.loads(raw_history)
        except json.JSONDecodeError:
            history = []
    else:
        history = raw_history or []

    if not audio_file:
        return Response({"detail": "Аудиофайл не был передан."}, status=drf_status.HTTP_400_BAD_REQUEST)

    try:
        result = CRMAssistantService(request.user).handle_audio(
            audio_bytes=audio_file.read(),
            mime_type=audio_file.content_type or "audio/wav",
            history=history,
            include_audio=include_audio,
        )
        return Response(result)
    except GeminiConfigurationError as exc:
        return Response({"detail": str(exc)}, status=drf_status.HTTP_503_SERVICE_UNAVAILABLE)
    except GeminiRequestError as exc:
        return Response({"detail": str(exc)}, status=drf_status.HTTP_502_BAD_GATEWAY)
    except ValueError as exc:
        return Response({"detail": str(exc)}, status=drf_status.HTTP_400_BAD_REQUEST)


class ProjectViewSet(viewsets.ModelViewSet):
    serializer_class = ProjectSerializer
    permission_classes = [IsAuthenticatedAny, HasActiveSubscription]

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
        qs = Project.objects.select_related("client").filter(workspace=workspace).order_by("-created_at")
        if self.request.user.is_admin():
            return qs
        return qs.filter(manager=self.request.user)

    def perform_create(self, serializer):
        workspace = current_workspace(self.request.user)
        subscription = get_workspace_subscription(workspace=workspace)
        user = self.request.user
        if not user.is_admin() and not is_subscription_active(subscription) and not can_create_trial_project(subscription):
            raise ValidationError(
                {
                    "subscription": (
                        "Бесплатный лимит 10 созданных проектов исчерпан. "
                        "Оформите подписку: 1000 ₽/мес без AI-помощника или 1500 ₽/мес с AI-помощником."
                    )
                }
            )

        project = serializer.save(manager=user, workspace=workspace)
        record_project_created(subscription)
        apply_task_templates_for_project(project, actor=user)
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
        project = serializer.save()
        if previous_status != project.status:
            apply_task_templates_for_project(project, actor=self.request.user)
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
        before = snapshot_model(instance, ["id", "title", "client_name", "client_phone", "object_address", "total_amount", "status"])
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

    @action(detail=True, methods=["post"], url_path="yandex-disk-folder")
    def yandex_disk_folder(self, request, pk=None):
        project = self.get_object()
        result = ensure_project_disk_folder(project, actor=request.user, force=True)
        project.refresh_from_db()
        return Response({"result": result, "project": self.get_serializer(project).data})

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

        file_values = []
        for uploaded_file in uploaded_files:
            original_name = uploaded_file.name or "file"
            safe_name = get_valid_filename(original_name) or "file"
            storage_path = f"project_custom_fields/{project.id}/{field.id}/{uuid.uuid4().hex}-{safe_name}"
            saved_path = default_storage.save(storage_path, uploaded_file)
            file_url = default_storage.url(saved_path)
            if file_url.startswith("/"):
                file_url = request.build_absolute_uri(file_url)

            file_values.append(
                {
                    "name": original_name,
                    "original_name": original_name,
                    "url": file_url,
                    "path": saved_path,
                    "content_type": uploaded_file.content_type or "",
                    "size": uploaded_file.size,
                }
            )

        custom_fields = dict(project.custom_fields or {})
        existing_value = custom_fields.get(str(field.id))
        if isinstance(existing_value, list):
            existing_files = [item for item in existing_value if isinstance(item, dict)]
        elif isinstance(existing_value, dict):
            existing_files = [existing_value]
        else:
            existing_files = []

        custom_fields[str(field.id)] = existing_files + file_values
        project.custom_fields = custom_fields
        project.save(update_fields=["custom_fields", "updated_at"])

        return Response(
            {
                "field_id": str(field.id),
                "value": custom_fields[str(field.id)],
                "uploaded": file_values,
                "project": self.get_serializer(project).data,
            }
        )

    @action(detail=True, methods=["get"], url_path=r"documents/(?P<document_type>contract|act)")
    def document(self, request, pk=None, document_type=None):
        project = self.get_object()

        works_with_contract = bool(project.client.works_with_contract) if project.client else bool(project.works_with_contract)

        if document_type == DocumentTemplate.Type.CONTRACT and not works_with_contract:
            return Response(
                {"detail": "Для этого клиента не включена работа по договору."},
                status=drf_status.HTTP_400_BAD_REQUEST,
            )

        template = DocumentTemplate.objects.filter(workspace=current_workspace(request.user), type=document_type).first()
        if not template or not template.file:
            return Response({"detail": "Шаблон документа не загружен."}, status=drf_status.HTTP_404_NOT_FOUND)

        try:
            content = render_pdf_template(template, project)
        except ImportError:
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
    from pypdf import PdfReader, PdfWriter

    client = project.client
    values = {
        "CLIENT_NAME": (client.name if client else project.client_name) or "",
        "CLIENT_PHONE": (client.phone if client else project.client_phone) or "",
        "CLIENT_EMAIL": (client.email if client else project.client_email) or "",
        "CLIENT_ADDRESS": (client.address if client else project.object_address) or "",
        "DEAL_VALUE": str(project.total_amount or ""),
        "PROJECT_TITLE": project.title or project.client_name or "",
        "DOCUMENT_DATE": timezone.localdate().strftime("%d.%m.%Y"),
        "REMARKS": "Замечания отсутствуют",
    }

    with template.file.open("rb") as file_obj:
        reader = PdfReader(file_obj)
        writer = PdfWriter()
        for page in reader.pages:
            writer.add_page(page)

        if "/AcroForm" in reader.trailer["/Root"]:
            writer.set_need_appearances_writer()
            for page in writer.pages:
                writer.update_page_form_field_values(page, values)

        output = BytesIO()
        writer.write(output)
        return output.getvalue()


class ClientViewSet(viewsets.ModelViewSet):
    serializer_class = ClientSerializer
    permission_classes = [IsAuthenticatedAny, HasActiveSubscription]
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
            after=snapshot_model(client, ["id", "name", "phone", "email", "address", "works_with_contract", "bonus_balance"]),
            workspace=client.workspace,
        )

    def perform_update(self, serializer):
        before = snapshot_model(serializer.instance, ["id", "name", "phone", "email", "address", "works_with_contract", "bonus_balance"])
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
            after=snapshot_model(client, ["id", "name", "phone", "email", "address", "works_with_contract", "bonus_balance"]),
            workspace=client.workspace,
        )

    def perform_destroy(self, instance):
        before = snapshot_model(instance, ["id", "name", "phone", "email", "address", "works_with_contract", "bonus_balance"])
        create_audit_log(self.request.user, "client", instance.id, "delete", before=before, workspace=instance.workspace)
        instance.delete()


class PaymentViewSet(viewsets.ModelViewSet):
    serializer_class = PaymentSerializer
    permission_classes = [IsAuthenticatedAny, HasActiveSubscription]

    def get_queryset(self):
        workspace = current_workspace(self.request.user)
        qs = Payment.objects.select_related("project", "created_by", "category", "account").filter(project__workspace=workspace).order_by("-paid_at")
        if self.request.user.is_admin():
            return qs
        return qs.filter(project__manager=self.request.user)

    def perform_create(self, serializer):
        with transaction.atomic():
            payment = serializer.save(created_by=self.request.user)
            ensure_project_bonus_accrual(payment.project, actor=self.request.user)
            create_audit_log(
                self.request.user,
                "payment",
                payment.id,
                "create",
                after=snapshot_model(payment, ["id", "project_id", "category_id", "account_id", "paid_at", "amount", "type", "comment"]),
                workspace=payment.project.workspace,
            )

    def perform_update(self, serializer):
        previous_project_id = serializer.instance.project_id
        before = snapshot_model(serializer.instance, ["id", "project_id", "category_id", "account_id", "paid_at", "amount", "type", "comment"])
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
                after=snapshot_model(payment, ["id", "project_id", "category_id", "account_id", "paid_at", "amount", "type", "comment"]),
                workspace=payment.project.workspace,
            )

    def perform_destroy(self, instance):
        payment_id = instance.id
        project_id = instance.project_id
        workspace = instance.project.workspace
        before = snapshot_model(instance, ["id", "project_id", "category_id", "account_id", "paid_at", "amount", "type", "comment"])
        with transaction.atomic():
            instance.delete()
            if project_id:
                ensure_project_bonus_accrual(Project.objects.get(pk=project_id), actor=self.request.user)
            create_audit_log(self.request.user, "payment", payment_id, "delete", before=before, workspace=workspace)


class ClientBonusTransactionViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = ClientBonusTransactionSerializer
    permission_classes = [IsAuthenticatedAny, HasActiveSubscription]

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
    permission_classes = [IsAuthenticatedAny, HasActiveSubscription]

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


class ProjectStatusViewSet(viewsets.ModelViewSet):
    serializer_class = ProjectStatusSerializer
    http_method_names = ["get", "post", "patch", "put", "delete", "head", "options"]

    def get_queryset(self):
        return ProjectStatus.objects.filter(workspace=current_workspace(self.request.user)).order_by("sort_order", "id")

    def get_permissions(self):
        if self.action in {"list", "retrieve"}:
            return [IsAuthenticatedAny(), HasActiveSubscription()]
        return [IsAdmin(), HasActiveSubscription()]

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
            return [IsAuthenticatedAny(), HasActiveSubscription()]
        return [IsAdmin(), HasActiveSubscription()]

    def perform_create(self, serializer):
        serializer.save(workspace=current_workspace(self.request.user))


class AccountViewSet(viewsets.ModelViewSet):
    serializer_class = AccountSerializer
    http_method_names = ["get", "post", "patch", "put", "delete", "head", "options"]

    def get_queryset(self):
        return Account.objects.filter(workspace=current_workspace(self.request.user)).order_by("name", "id")

    def get_permissions(self):
        if self.action in {"list", "retrieve"}:
            return [IsAuthenticatedAny(), HasActiveSubscription()]
        return [IsAdmin(), HasActiveSubscription()]

    def perform_create(self, serializer):
        serializer.save(workspace=current_workspace(self.request.user))


class ProjectCustomFieldViewSet(viewsets.ModelViewSet):
    serializer_class = ProjectCustomFieldSerializer
    http_method_names = ["get", "post", "patch", "put", "delete", "head", "options"]

    def get_queryset(self):
        return ProjectCustomField.objects.filter(workspace=current_workspace(self.request.user)).order_by("sort_order", "id")

    def get_permissions(self):
        if self.action in {"list", "retrieve"}:
            return [IsAuthenticatedAny(), HasActiveSubscription()]
        return [IsAdmin(), HasActiveSubscription()]

    def perform_create(self, serializer):
        serializer.save(workspace=current_workspace(self.request.user))


class DocumentTemplateViewSet(viewsets.ModelViewSet):
    serializer_class = DocumentTemplateSerializer
    permission_classes = [IsAdmin, HasActiveSubscription]
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
    permission_classes = [IsAuthenticatedAny, HasActiveSubscription]

    def get_queryset(self):
        workspace = current_workspace(self.request.user)
        qs = Task.objects.select_related("assignee", "created_by", "project").filter(assignee__workspace=workspace).order_by("status", "due_date", "-created_at")
        qs = qs.filter(Q(project__isnull=True) | Q(project__workspace=workspace))
        if not self.request.user.is_admin():
            qs = qs.filter(assignee=self.request.user)

        project_id = self.request.query_params.get("project")
        if project_id:
            qs = qs.filter(project_id=project_id)

        return qs

    def perform_create(self, serializer):
        assignee = serializer.validated_data.get("assignee") or self.request.user
        task = serializer.save(created_by=self.request.user, assignee=assignee)
        create_audit_log(
            self.request.user,
            "task",
            task.id,
            "create",
            after=snapshot_model(task, ["id", "project_id", "title", "status", "priority", "due_date"]),
            workspace=getattr(task.project, "workspace", current_workspace(self.request.user)),
        )

    def perform_update(self, serializer):
        before = snapshot_model(serializer.instance, ["id", "project_id", "title", "status", "priority", "due_date"])
        task = serializer.save()
        create_audit_log(
            self.request.user,
            "task",
            task.id,
            "update",
            before=before,
            after=snapshot_model(task, ["id", "project_id", "title", "status", "priority", "due_date"]),
            workspace=getattr(task.project, "workspace", current_workspace(self.request.user)),
        )

    def perform_destroy(self, instance):
        workspace = getattr(instance.project, "workspace", current_workspace(self.request.user))
        before = snapshot_model(instance, ["id", "project_id", "title", "status", "priority", "due_date"])
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
            return [IsAuthenticatedAny(), HasActiveSubscription()]
        return [IsAdmin(), HasActiveSubscription()]

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
    permission_classes = [IsAdmin, HasActiveSubscription]

    def get_queryset(self):
        return AuditLog.objects.select_related("actor").filter(workspace=current_workspace(self.request.user)).order_by("-created_at", "-id")


class UserViewSet(viewsets.ModelViewSet):
    serializer_class = AdminUserSerializer
    permission_classes = [IsAdmin, HasActiveSubscription]
    http_method_names = ["get", "post", "patch", "put", "head", "options"]

    def get_queryset(self):
        return User.objects.filter(workspace=current_workspace(self.request.user)).order_by("date_joined", "id")

    def perform_create(self, serializer):
        serializer.save(workspace=current_workspace(self.request.user))
