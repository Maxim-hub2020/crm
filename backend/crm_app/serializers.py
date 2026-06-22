import logging

from django.db import transaction
from rest_framework import serializers
from django.utils import timezone
from django.utils.dateparse import parse_date
from django.utils.text import slugify

from .bonuses import apply_project_bonus_promo_code, ensure_project_bonus_accrual, normalize_bonus_promo_code, promo_code_for_phone
from .models import (
    Account,
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
    Task,
    User,
)
from .phones import PHONE_VALIDATION_ERROR, normalize_russian_phone, phone_digits
from .subscription import has_trial_access, is_subscription_active
from .tenancy import current_workspace

logger = logging.getLogger(__name__)


def normalize_client_phone(value):
    try:
        return normalize_russian_phone(value)
    except ValueError:
        raise serializers.ValidationError(PHONE_VALIDATION_ERROR)

class MeSerializer(serializers.ModelSerializer):
    full_name = serializers.SerializerMethodField()
    is_admin = serializers.SerializerMethodField()
    subscription_active = serializers.SerializerMethodField()
    workspace = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            "id",
            "username",
            "full_name",
            "role",
            "is_active",
            "is_staff",
            "is_superuser",
            "is_admin",
            "subscription_active",
            "workspace",
        ]

    def get_full_name(self, obj):
        fn = obj.get_full_name()
        return fn if fn else obj.username

    def get_is_admin(self, obj):
        return obj.is_admin()

    def get_subscription_active(self, obj):
        if obj.is_admin():
            return True
        from .subscription import get_workspace_subscription

        subscription = get_workspace_subscription(obj)
        return is_subscription_active(subscription) or has_trial_access(subscription)

    def get_workspace(self, obj):
        workspace = current_workspace(obj)
        return {
            "id": workspace.id if workspace else None,
            "name": workspace.name if workspace else "",
            "slug": workspace.slug if workspace else "",
        }


class ClientSerializer(serializers.ModelSerializer):
    project_count = serializers.SerializerMethodField()
    promo_code = serializers.SerializerMethodField()

    class Meta:
        model = Client
        fields = [
            "id",
            "name",
            "phone",
            "email",
            "address",
            "works_with_contract",
            "bonus_balance",
            "promo_code",
            "project_count",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["bonus_balance", "promo_code", "project_count", "created_at", "updated_at"]
        extra_kwargs = {
            "phone": {"required": False, "allow_blank": True},
            "email": {"required": False, "allow_blank": True, "allow_null": True},
            "address": {"required": False, "allow_blank": True, "allow_null": True},
            "works_with_contract": {"required": False},
        }

    def get_project_count(self, obj):
        return obj.projects.count()

    def get_promo_code(self, obj):
        return promo_code_for_phone(obj.phone)

    def validate_phone(self, value):
        return normalize_client_phone(value)

    def validate(self, attrs):
        attrs = super().validate(attrs)
        phone = attrs.get("phone")
        if phone:
            request = self.context.get("request")
            user = getattr(request, "user", None)
            workspace = current_workspace(user) if user and user.is_authenticated else getattr(self.instance, "workspace", None)
            duplicate_query = Client.objects.filter(workspace=workspace, phone=phone)
            if self.instance is not None:
                duplicate_query = duplicate_query.exclude(pk=self.instance.pk)
            if duplicate_query.exists():
                raise serializers.ValidationError({"phone": "Клиент с таким телефоном уже существует."})
        return attrs


class ProjectSerializer(serializers.ModelSerializer):
    client_info = ClientSerializer(source="client", read_only=True)
    order_number_label = serializers.SerializerMethodField()
    referred_by_client_name = serializers.CharField(source="referred_by_client.name", read_only=True)

    def _workspace(self):
        request = self.context.get("request")
        user = getattr(request, "user", None)
        return current_workspace(user) if user and user.is_authenticated else None

    def _resolve_client(self, attrs):
        instance = self.instance
        if instance is not None and "client" in attrs and attrs.get("client") is None:
            attrs["client_name"] = str(attrs.get("client_name", "") or "").strip()
            attrs["client_phone"] = str(attrs.get("client_phone", "") or "").strip()
            attrs["client_email"] = attrs.get("client_email", None)
            return attrs

        current_client = attrs.get("client") or getattr(instance, "client", None)
        workspace = self._workspace() or getattr(current_client, "workspace", None) or getattr(instance, "workspace", None)

        name = str(attrs.get("client_name", getattr(instance, "client_name", "")) or "").strip()
        phone = str(attrs.get("client_phone", getattr(instance, "client_phone", "")) or "").strip()
        email = attrs.get("client_email", getattr(instance, "client_email", None))

        client = current_client
        if phone:
            phone_match = Client.objects.filter(workspace=workspace, phone=phone).first()
            if not phone_match:
                normalized_digits = phone_digits(phone)
                phone_match = next(
                    (
                        candidate
                        for candidate in Client.objects.filter(workspace=workspace).exclude(phone="").only("id", "phone")
                        if phone_digits(candidate.phone) == normalized_digits
                    ),
                    None,
                )
            if phone_match:
                client = phone_match

        if client is None and name:
            client = Client.objects.filter(workspace=workspace, name__iexact=name, phone="").first()

        if client is None:
            if not name:
                raise serializers.ValidationError({"client_name": "Укажите клиента."})
            client = Client.objects.create(
                workspace=workspace,
                name=name,
                phone=phone,
                email=email or None,
            )
        else:
            if not name:
                name = client.name
            if not phone:
                phone = client.phone or ""

            changed_fields = []
            if name and client.name != name:
                client.name = name
                changed_fields.append("name")
            if phone and client.phone != phone and not Client.objects.exclude(pk=client.pk).filter(workspace=workspace, phone=phone).exists():
                client.phone = phone
                changed_fields.append("phone")
            if "client_email" in attrs and client.email != (email or None):
                client.email = email or None
                changed_fields.append("email")
            if changed_fields:
                changed_fields.append("updated_at")
                client.save(update_fields=changed_fields)

        attrs["client"] = client
        attrs["client_name"] = name or client.name
        attrs["client_phone"] = phone or client.phone or ""
        attrs["client_email"] = email if "client_email" in attrs else client.email

        return attrs

    def validate_status(self, value):
        workspace = self._workspace()
        if value and not ProjectStatus.objects.filter(workspace=workspace, code=value).exists():
            raise serializers.ValidationError("Укажите существующий статус канбана.")
        return value

    def validate_client_phone(self, value):
        return normalize_client_phone(value)

    def validate_bonus_promo_code(self, value):
        normalized = normalize_bonus_promo_code(value)
        if self.instance and self.instance.referral_bonus_used and normalized != (self.instance.bonus_promo_code or ""):
            raise serializers.ValidationError("Промокод уже применен, изменить его нельзя.")
        return normalized

    def _normalize_custom_fields(self, value):
        if value in (None, ""):
            return {}
        if not isinstance(value, dict):
            raise serializers.ValidationError("Project custom fields must be an object.")

        workspace = self._workspace() or getattr(self.instance, "workspace", None)
        fields = {
            str(field.id): field
            for field in ProjectCustomField.objects.filter(workspace=workspace).order_by("sort_order", "id")
        }
        normalized = {}

        for raw_key, raw_value in value.items():
            key = str(raw_key)
            field = fields.get(key)
            if not field:
                continue
            if raw_value in (None, ""):
                continue

            if field.field_type == ProjectCustomField.FieldType.NUMBER:
                clean_value = str(raw_value).strip().replace(" ", "").replace(",", ".")
                try:
                    float(clean_value)
                except (TypeError, ValueError):
                    raise serializers.ValidationError({key: "Enter a numeric value."})
            elif field.field_type == ProjectCustomField.FieldType.DATE:
                clean_value = str(raw_value).strip()
                if clean_value and not parse_date(clean_value):
                    raise serializers.ValidationError({key: "Enter a date in YYYY-MM-DD format."})
            elif field.field_type == ProjectCustomField.FieldType.FILE:
                raw_files = raw_value if isinstance(raw_value, list) else [raw_value] if isinstance(raw_value, dict) else []
                clean_value = []
                for raw_file in raw_files:
                    if not isinstance(raw_file, dict):
                        continue
                    try:
                        file_size = int(raw_file.get("size") or 0)
                    except (TypeError, ValueError):
                        file_size = 0
                    file_value = {
                        "name": str(raw_file.get("name") or raw_file.get("original_name") or "").strip(),
                        "original_name": str(raw_file.get("original_name") or raw_file.get("originalName") or raw_file.get("name") or "").strip(),
                        "url": str(raw_file.get("url") or "").strip(),
                        "path": str(raw_file.get("path") or "").strip(),
                        "content_type": str(raw_file.get("content_type") or raw_file.get("contentType") or "").strip(),
                        "size": file_size,
                    }
                    if file_value["name"] or file_value["url"] or file_value["path"]:
                        clean_value.append(file_value)
            else:
                clean_value = str(raw_value).strip()

            if clean_value:
                normalized[key] = clean_value

        return normalized

    def validate(self, attrs):
        if "custom_fields" in attrs:
            attrs["custom_fields"] = self._normalize_custom_fields(attrs.get("custom_fields"))
        is_detaching_client = self.instance is not None and "client" in attrs and attrs.get("client") is None
        if is_detaching_client:
            return attrs
        has_client = attrs.get("client") or getattr(self.instance, "client", None)
        has_name = str(attrs.get("client_name", getattr(self.instance, "client_name", "")) or "").strip()
        has_phone = str(attrs.get("client_phone", getattr(self.instance, "client_phone", "")) or "").strip()
        if not has_client and not has_name and not has_phone:
            raise serializers.ValidationError({"client_name": "Укажите клиента."})
        title = str(attrs.get("title", getattr(self.instance, "title", "")) or "").strip()
        if self.instance is None and not title:
            attrs["title"] = has_name or "Новый проект"
        if self.instance is None and not attrs.get("status"):
            workspace = self._workspace()
            default_status = ProjectStatus.objects.filter(workspace=workspace, is_default=True).first() or ProjectStatus.objects.filter(workspace=workspace).first()
            if default_status:
                attrs["status"] = default_status.code
        return attrs

    def _actor(self):
        request = self.context.get("request")
        return getattr(request, "user", None)

    def _run_project_side_effects(self, project):
        try:
            ensure_project_bonus_accrual(project, actor=self._actor())
        except Exception:
            logger.exception("Project bonus accrual failed for project_id=%s", project.pk)

    def create(self, validated_data):
        with transaction.atomic():
            project = super().create(self._resolve_client(validated_data))
            apply_project_bonus_promo_code(project, actor=self._actor())
            project.refresh_from_db()

        self._run_project_side_effects(project)
        project.refresh_from_db()
        return project

    def update(self, instance, validated_data):
        with transaction.atomic():
            project = super().update(instance, self._resolve_client(validated_data))
            apply_project_bonus_promo_code(project, actor=self._actor())
            project.refresh_from_db()

        self._run_project_side_effects(project)
        project.refresh_from_db()
        return project

    def get_order_number_label(self, obj):
        return f"{obj.order_number:04d}" if obj.order_number else ""

    class Meta:
        model = Project
        fields = "__all__"
        read_only_fields = [
            "workspace",
            "manager",
            "created_at",
            "updated_at",
            "client_info",
            "order_number",
            "order_number_label",
            "referred_by_client",
            "referred_by_client_name",
            "referral_bonus_used",
            "bonus_accrued_amount",
            "bonus_accrued_at",
        ]
        extra_kwargs = {
            "client": {"required": False, "allow_null": True},
            "title": {"required": False, "allow_blank": True},
            "client_name": {"required": False, "allow_blank": True},
            "client_phone": {"required": False, "allow_blank": True},
            "client_email": {"required": False, "allow_blank": True, "allow_null": True},
            "object_address": {"required": False, "allow_blank": True, "allow_null": True},
            "object_lat": {"required": False, "allow_blank": True, "allow_null": True},
            "object_lon": {"required": False, "allow_blank": True, "allow_null": True},
            "apartment": {"required": False, "allow_blank": True},
            "entrance": {"required": False, "allow_blank": True},
            "floor": {"required": False, "allow_blank": True},
            "description": {"required": False, "allow_blank": True},
            "total_amount": {"required": False, "allow_null": True},
            "status": {"required": False},
            "custom_fields": {"required": False},
            "categories": {"required": False, "allow_blank": True},
            "works_with_contract": {"required": False},
        }


class ProjectStatusSerializer(serializers.ModelSerializer):
    project_count = serializers.SerializerMethodField()

    class Meta:
        model = ProjectStatus
        fields = [
            "id",
            "code",
            "name",
            "short_name",
            "color",
            "sort_order",
            "stuck_after_days",
            "is_default",
            "project_count",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["project_count", "created_at", "updated_at"]
        extra_kwargs = {
            "code": {"required": False, "allow_blank": True},
            "short_name": {"required": False, "allow_blank": True},
            "stuck_after_days": {"required": False},
        }

    def get_project_count(self, obj):
        return Project.objects.filter(workspace=obj.workspace, status=obj.code).count()

    def validate(self, attrs):
        name = attrs.get("name", getattr(self.instance, "name", ""))
        code = attrs.get("code", getattr(self.instance, "code", ""))

        if not code:
            code = slugify(name, allow_unicode=True)

        if not code:
            raise serializers.ValidationError({"code": "Укажите код статуса латиницей или коротким словом."})

        attrs["code"] = code

        if not attrs.get("short_name"):
            attrs["short_name"] = name[:40]

        return attrs

    def create(self, validated_data):
        return ProjectStatus.objects.create(**validated_data)

    def update(self, instance, validated_data):
        old_code = instance.code

        for key, value in validated_data.items():
            setattr(instance, key, value)
        instance.save()

        if old_code != instance.code:
            Project.objects.filter(workspace=instance.workspace, status=old_code).update(status=instance.code)

        return instance


class FinanceCategorySerializer(serializers.ModelSerializer):
    class Meta:
        model = FinanceCategory
        fields = ["id", "name", "type", "sort_order", "created_at"]
        read_only_fields = ["created_at"]
        extra_kwargs = {
            "sort_order": {"required": False},
        }

    def validate(self, attrs):
        if self.instance is None and "sort_order" not in attrs:
            request = self.context.get("request")
            workspace = current_workspace(getattr(request, "user", None))
            category_type = attrs.get("type", FinanceCategory.Type.EXPENSE)
            max_order = (
                FinanceCategory.objects.filter(workspace=workspace, type=category_type)
                .order_by("-sort_order")
                .values_list("sort_order", flat=True)
                .first()
            )
            attrs["sort_order"] = (max_order or 0) + 10
        return attrs


class AccountSerializer(serializers.ModelSerializer):
    class Meta:
        model = Account
        fields = ["id", "name", "created_at"]
        read_only_fields = ["created_at"]


class ProjectCustomFieldSerializer(serializers.ModelSerializer):
    class Meta:
        model = ProjectCustomField
        fields = ["id", "name", "field_type", "sort_order", "created_at"]
        read_only_fields = ["created_at"]
        extra_kwargs = {
            "sort_order": {"required": False},
        }

    def validate(self, attrs):
        if self.instance is None and "sort_order" not in attrs:
            max_order = ProjectCustomField.objects.order_by("-sort_order").values_list("sort_order", flat=True).first()
            attrs["sort_order"] = (max_order or 0) + 10
        return attrs


class DocumentTemplateSerializer(serializers.ModelSerializer):
    file_url = serializers.SerializerMethodField()

    class Meta:
        model = DocumentTemplate
        fields = ["id", "type", "file", "file_url", "original_name", "uploaded_by", "created_at", "updated_at"]
        read_only_fields = ["uploaded_by", "created_at", "updated_at", "file_url"]
        extra_kwargs = {
            "file": {"write_only": True},
            "original_name": {"required": False, "allow_blank": True},
        }

    def get_file_url(self, obj):
        request = self.context.get("request")
        if not obj.file:
            return ""
        url = obj.file.url
        return request.build_absolute_uri(url) if request else url

    def validate_file(self, uploaded_file):
        content_type = getattr(uploaded_file, "content_type", "")
        filename = getattr(uploaded_file, "name", "")
        if content_type and "pdf" not in content_type.lower() and not filename.lower().endswith(".pdf"):
            raise serializers.ValidationError("Загрузите PDF-файл.")
        if not filename.lower().endswith(".pdf"):
            raise serializers.ValidationError("Загрузите PDF-файл.")
        return uploaded_file


class ChatIntegrationSettingsSerializer(serializers.ModelSerializer):
    has_api_access_token = serializers.SerializerMethodField()
    app_url = serializers.SerializerMethodField()

    class Meta:
        model = ChatIntegrationSettings
        fields = [
            "id",
            "provider",
            "enabled",
            "base_url",
            "account_id",
            "inbox_name",
            "api_access_token",
            "has_api_access_token",
            "app_url",
            "updated_by",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["updated_by", "created_at", "updated_at", "has_api_access_token", "app_url"]
        extra_kwargs = {
            "base_url": {"required": False, "allow_blank": True},
            "account_id": {"required": False, "allow_blank": True},
            "inbox_name": {"required": False, "allow_blank": True},
            "api_access_token": {"required": False, "allow_blank": True, "write_only": True},
        }

    def get_has_api_access_token(self, obj):
        return bool(obj.api_access_token)

    def get_app_url(self, obj):
        base_url = (obj.base_url or "").strip().rstrip("/")
        return f"{base_url}/app" if obj.enabled and base_url else ""

    def validate_base_url(self, value):
        return str(value or "").strip().rstrip("/")


class PaymentSerializer(serializers.ModelSerializer):
    category_name = serializers.CharField(source="category.name", read_only=True)
    category_type = serializers.CharField(source="category.type", read_only=True)
    account_name = serializers.CharField(source="account.name", read_only=True)

    def validate_project(self, project):
        request = self.context.get("request")
        user = getattr(request, "user", None)
        workspace = current_workspace(user) if user and user.is_authenticated else None

        if user and user.is_authenticated and project.workspace_id != getattr(workspace, "id", None):
            raise serializers.ValidationError("Проект относится к другой компании.")

        if user and user.is_authenticated and not user.is_admin() and project.manager_id != user.id:
            raise serializers.ValidationError("You can create payments only for your own projects.")

        return project

    def validate_category(self, category):
        request = self.context.get("request")
        workspace = current_workspace(getattr(request, "user", None))
        if category and category.workspace_id != getattr(workspace, "id", None):
            raise serializers.ValidationError("Категория относится к другой компании.")
        return category

    def validate_account(self, account):
        request = self.context.get("request")
        workspace = current_workspace(getattr(request, "user", None))
        if account and account.workspace_id != getattr(workspace, "id", None):
            raise serializers.ValidationError("Счет относится к другой компании.")
        return account

    def validate(self, attrs):
        request = self.context.get("request")
        workspace = current_workspace(getattr(request, "user", None))

        category = attrs.get("category", getattr(self.instance, "category", None))
        if not category:
            raise serializers.ValidationError({"category": "Выберите категорию операции."})

        attrs["type"] = Payment.Type.CORRECTION if category.type == FinanceCategory.Type.EXPENSE else Payment.Type.ADVANCE
        attrs["method"] = attrs.get("method") or getattr(self.instance, "method", Payment.Method.TRANSFER) or Payment.Method.TRANSFER

        paid_at = attrs.get("paid_at")
        if paid_at is None and self.instance is None:
            attrs["paid_at"] = timezone.now()
            paid_at = attrs["paid_at"]
        if paid_at is not None and timezone.localtime(paid_at).date() < timezone.localdate():
            raise serializers.ValidationError({"paid_at": "Нельзя ставить операцию задним числом."})

        account = attrs.get("account", getattr(self.instance, "account", None))
        account_queryset = Account.objects.filter(workspace=workspace)
        account_count = account_queryset.count()
        if account_count == 1 and not account:
            attrs["account"] = account_queryset.first()
        elif account_count > 1 and not account:
            raise serializers.ValidationError({"account": "Выберите счет для операции."})

        return attrs

    class Meta:
        model = Payment
        fields = [
            "id",
            "project",
            "created_by",
            "category",
            "category_name",
            "category_type",
            "account",
            "account_name",
            "paid_at",
            "amount",
            "type",
            "method",
            "comment",
            "attachment_url",
            "created_at",
        ]
        read_only_fields = ["created_by", "created_at", "category_name", "category_type", "account_name"]
        extra_kwargs = {
            "category": {"required": True, "allow_null": False},
            "account": {"required": False, "allow_null": True},
            "comment": {"required": False, "allow_blank": True},
            "attachment_url": {"required": False, "allow_blank": True, "allow_null": True},
            "paid_at": {"required": False},
            "type": {"required": False},
            "method": {"required": False},
        }


class ClientBonusTransactionSerializer(serializers.ModelSerializer):
    client_name = serializers.CharField(source="client.name", read_only=True)
    related_client_name = serializers.CharField(source="related_client.name", read_only=True)
    project_title = serializers.SerializerMethodField()

    def get_project_title(self, obj):
        if not obj.project:
            return ""
        return obj.project.title or obj.project.client_name or f"Проект #{obj.project_id}"

    class Meta:
        model = ClientBonusTransaction
        fields = [
            "id",
            "client",
            "client_name",
            "project",
            "project_title",
            "related_client",
            "related_client_name",
            "type",
            "amount",
            "balance_after",
            "promo_code",
            "comment",
            "created_at",
        ]
        read_only_fields = fields


class ProjectCommentSerializer(serializers.ModelSerializer):
    author_name = serializers.SerializerMethodField()

    def validate_project(self, project):
        request = self.context.get("request")
        user = getattr(request, "user", None)
        workspace = current_workspace(user) if user and user.is_authenticated else None

        if user and user.is_authenticated and project.workspace_id != getattr(workspace, "id", None):
            raise serializers.ValidationError("Проект относится к другой компании.")

        if user and user.is_authenticated and not user.is_admin() and project.manager_id != user.id:
            raise serializers.ValidationError("You can comment only on your own projects.")

        return project

    def get_author_name(self, obj):
        return obj.author.get_full_name() or obj.author.username

    def validate_text(self, value):
        text = str(value or "").strip()
        if not text:
            raise serializers.ValidationError("Введите комментарий.")
        return text

    class Meta:
        model = ProjectComment
        fields = "__all__"
        read_only_fields = ["author", "created_at", "author_name"]
        extra_kwargs = {
            "text": {"required": True},
        }


class TaskSerializer(serializers.ModelSerializer):
    assignee_name = serializers.SerializerMethodField()
    created_by_name = serializers.SerializerMethodField()
    project_title = serializers.SerializerMethodField()

    class Meta:
        model = Task
        fields = [
            "id",
            "title",
            "project",
            "project_title",
            "notes",
            "due_date",
            "status",
            "priority",
            "assignee",
            "assignee_name",
            "created_by",
            "created_by_name",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["created_by", "created_at", "updated_at", "assignee_name", "created_by_name", "project_title"]
        extra_kwargs = {
            "project": {"required": False, "allow_null": True},
            "notes": {"required": False, "allow_blank": True},
            "due_date": {"required": False, "allow_null": True},
            "status": {"required": False},
            "priority": {"required": False},
            "assignee": {"required": False, "allow_null": True},
        }

    def get_assignee_name(self, obj):
        return obj.assignee.get_full_name() or obj.assignee.username

    def get_created_by_name(self, obj):
        return obj.created_by.get_full_name() or obj.created_by.username

    def get_project_title(self, obj):
        if not obj.project:
            return ""
        return obj.project.title or obj.project.client_name or f"Проект #{obj.project_id}"

    def validate_project(self, project):
        request = self.context.get("request")
        user = getattr(request, "user", None)
        workspace = current_workspace(user) if user and user.is_authenticated else None

        if user and user.is_authenticated and project and project.workspace_id != getattr(workspace, "id", None):
            raise serializers.ValidationError("Проект относится к другой компании.")

        if user and user.is_authenticated and project and not user.is_admin() and project.manager_id != user.id:
            raise serializers.ValidationError("You can create tasks only for your own projects.")

        return project

    def validate_assignee(self, assignee):
        request = self.context.get("request")
        user = getattr(request, "user", None)
        workspace = current_workspace(user) if user and user.is_authenticated else None

        if user and user.is_authenticated and assignee and assignee.workspace_id != getattr(workspace, "id", None):
            raise serializers.ValidationError("Пользователь относится к другой компании.")

        if user and user.is_authenticated and not user.is_admin() and assignee and assignee.id != user.id:
            raise serializers.ValidationError("You can assign tasks only to yourself.")

        return assignee


class AdminUserSerializer(serializers.ModelSerializer):
    full_name = serializers.SerializerMethodField()
    is_admin = serializers.SerializerMethodField()
    workspace_name = serializers.SerializerMethodField()
    password = serializers.CharField(write_only=True, required=False)

    class Meta:
        model = User
        fields = [
            "id",
            "username",
            "first_name",
            "last_name",
            "email",
            "full_name",
            "role",
            "is_active",
            "is_staff",
            "is_superuser",
            "is_admin",
            "workspace",
            "workspace_name",
            "date_joined",
            "password",
        ]
        read_only_fields = ["workspace", "workspace_name", "is_staff", "is_superuser", "is_admin", "full_name", "date_joined"]
        extra_kwargs = {
            "email": {"required": False, "allow_blank": True},
            "first_name": {"required": False, "allow_blank": True},
            "last_name": {"required": False, "allow_blank": True},
        }

    def get_full_name(self, obj):
        fn = obj.get_full_name()
        return fn if fn else obj.username

    def get_is_admin(self, obj):
        return obj.is_admin()

    def get_workspace_name(self, obj):
        return obj.workspace.name if obj.workspace_id else ""

    def validate(self, attrs):
        if self.instance is None and not attrs.get("password"):
            raise serializers.ValidationError({"password": "Укажите пароль для нового пользователя."})
        return attrs

    def create(self, validated_data):
        password = validated_data.pop("password")
        return User.objects.create_user(password=password, **validated_data)

    def update(self, instance, validated_data):
        password = validated_data.pop("password", None)
        for key, value in validated_data.items():
            setattr(instance, key, value)
        if password:
            instance.set_password(password)
        instance.save()
        return instance
