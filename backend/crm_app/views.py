import json
from io import BytesIO

from django.db.models import Q
from django.http import FileResponse
from django.utils import timezone
from rest_framework import viewsets
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.exceptions import ValidationError
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response
from rest_framework import status as drf_status

from .ai_assistant import CRMAssistantService, GeminiConfigurationError, GeminiRequestError
from .models import (
    Account,
    ChatIntegrationSettings,
    Client,
    DocumentTemplate,
    FinanceCategory,
    Payment,
    Project,
    ProjectComment,
    ProjectCustomField,
    ProjectStatus,
    SubscriptionInvoice,
    Task,
    User,
)
from .permissions import HasActiveSubscription, HasAssistantSubscription, IsAdmin, IsAuthenticatedAny
from .serializers import (
    AdminUserSerializer,
    AccountSerializer,
    ChatIntegrationSettingsSerializer,
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

        serializer.save(manager=user, workspace=workspace)
        record_project_created(subscription)

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
            qs = qs.filter(
                Q(name__icontains=query)
                | Q(phone__icontains=query)
                | Q(email__icontains=query)
                | Q(address__icontains=query)
            )
        return qs.distinct()

    def perform_create(self, serializer):
        serializer.save(workspace=current_workspace(self.request.user))

    def perform_update(self, serializer):
        client = serializer.save()
        Project.objects.filter(workspace=client.workspace, client=client).update(
            client_name=client.name,
            client_phone=client.phone or "",
            client_email=client.email,
            works_with_contract=client.works_with_contract,
        )


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
        serializer.save(created_by=self.request.user)


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
        serializer.save(author=self.request.user)


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
        return FinanceCategory.objects.filter(workspace=current_workspace(self.request.user)).order_by("type", "name", "id")

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
    permission_classes = [IsAdmin, HasActiveSubscription]
    http_method_names = ["get", "post", "patch", "put", "delete", "head", "options"]

    def get_queryset(self):
        return ProjectCustomField.objects.filter(workspace=current_workspace(self.request.user)).order_by("sort_order", "id")

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
        serializer.save(created_by=self.request.user, assignee=assignee)


class UserViewSet(viewsets.ModelViewSet):
    serializer_class = AdminUserSerializer
    permission_classes = [IsAdmin, HasActiveSubscription]
    http_method_names = ["get", "post", "patch", "put", "head", "options"]

    def get_queryset(self):
        return User.objects.filter(workspace=current_workspace(self.request.user)).order_by("date_joined", "id")

    def perform_create(self, serializer):
        serializer.save(workspace=current_workspace(self.request.user))
