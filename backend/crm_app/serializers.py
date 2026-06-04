from rest_framework import serializers
from django.utils.text import slugify

from .models import (
    Account,
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
from .subscription import is_subscription_active

class MeSerializer(serializers.ModelSerializer):
    full_name = serializers.SerializerMethodField()
    is_admin = serializers.SerializerMethodField()
    subscription_active = serializers.SerializerMethodField()

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
        ]

    def get_full_name(self, obj):
        fn = obj.get_full_name()
        return fn if fn else obj.username

    def get_is_admin(self, obj):
        return obj.is_admin()

    def get_subscription_active(self, obj):
        if obj.is_admin():
            return True
        return is_subscription_active()


class ProjectSerializer(serializers.ModelSerializer):
    def validate_status(self, value):
        if value and not ProjectStatus.objects.filter(code=value).exists():
            raise serializers.ValidationError("Укажите существующий статус канбана.")
        return value

    def validate(self, attrs):
        if self.instance is None and not attrs.get("status"):
            default_status = ProjectStatus.objects.filter(is_default=True).first() or ProjectStatus.objects.first()
            if default_status:
                attrs["status"] = default_status.code
        return attrs

    class Meta:
        model = Project
        fields = "__all__"
        read_only_fields = ["manager", "created_at", "updated_at"]
        extra_kwargs = {
            "client_phone": {"required": False, "allow_blank": True},
            "client_email": {"required": False, "allow_blank": True, "allow_null": True},
            "object_address": {"required": False, "allow_blank": True, "allow_null": True},
            "description": {"required": False, "allow_blank": True},
            "total_amount": {"required": False, "allow_null": True},
            "status": {"required": False},
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
        return Project.objects.filter(status=obj.code).count()

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
            Project.objects.filter(status=old_code).update(status=instance.code)

        return instance


class FinanceCategorySerializer(serializers.ModelSerializer):
    class Meta:
        model = FinanceCategory
        fields = ["id", "name", "type", "created_at"]
        read_only_fields = ["created_at"]


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


class PaymentSerializer(serializers.ModelSerializer):
    def validate_project(self, project):
        request = self.context.get("request")
        user = getattr(request, "user", None)

        if user and user.is_authenticated and not user.is_admin() and project.manager_id != user.id:
            raise serializers.ValidationError("You can create payments only for your own projects.")

        return project

    class Meta:
        model = Payment
        fields = "__all__"
        read_only_fields = ["created_by", "created_at"]
        extra_kwargs = {
            "comment": {"required": False, "allow_blank": True},
            "attachment_url": {"required": False, "allow_blank": True, "allow_null": True},
            "paid_at": {"required": False},
            "method": {"required": False},
        }


class ProjectCommentSerializer(serializers.ModelSerializer):
    author_name = serializers.SerializerMethodField()

    def validate_project(self, project):
        request = self.context.get("request")
        user = getattr(request, "user", None)

        if user and user.is_authenticated and not user.is_admin() and project.manager_id != user.id:
            raise serializers.ValidationError("You can comment only on your own projects.")

        return project

    def get_author_name(self, obj):
        return obj.author.get_full_name() or obj.author.username

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

    class Meta:
        model = Task
        fields = [
            "id",
            "title",
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
        read_only_fields = ["created_by", "created_at", "updated_at", "assignee_name", "created_by_name"]
        extra_kwargs = {
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

    def validate_assignee(self, assignee):
        request = self.context.get("request")
        user = getattr(request, "user", None)

        if user and user.is_authenticated and not user.is_admin() and assignee and assignee.id != user.id:
            raise serializers.ValidationError("You can assign tasks only to yourself.")

        return assignee


class AdminUserSerializer(serializers.ModelSerializer):
    full_name = serializers.SerializerMethodField()
    is_admin = serializers.SerializerMethodField()
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
            "date_joined",
            "password",
        ]
        read_only_fields = ["is_staff", "is_superuser", "is_admin", "full_name", "date_joined"]
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
