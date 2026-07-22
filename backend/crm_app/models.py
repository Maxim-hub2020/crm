from django.utils import timezone
from django.db import models
from django.contrib.auth.models import AbstractUser


class Workspace(models.Model):
    name = models.CharField(max_length=160)
    slug = models.SlugField(max_length=80, unique=True, allow_unicode=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name", "id"]

    def __str__(self):
        return self.name


def default_workspace():
    workspace = Workspace.objects.order_by("id").first()
    if workspace:
        return workspace
    return Workspace.objects.create(name="Основная компания", slug="default")

class User(AbstractUser):
    class Role(models.TextChoices):
        ADMIN = "admin", "Admin"
        MANAGER = "manager", "Manager"

    role = models.CharField(max_length=20, choices=Role.choices, default=Role.MANAGER)
    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.PROTECT,
        related_name="users",
        blank=True,
        null=True,
        db_index=True,
    )

    def is_admin(self):
        return self.role == self.Role.ADMIN or self.is_superuser

    def save(self, *args, **kwargs):
        if not self.workspace_id:
            self.workspace = default_workspace()
        super().save(*args, **kwargs)


class ProjectStatus(models.Model):
    class Color(models.TextChoices):
        SKY = "sky", "Sky"
        EMERALD = "emerald", "Emerald"
        ROSE = "rose", "Rose"
        AMBER = "amber", "Amber"
        VIOLET = "violet", "Violet"
        SLATE = "slate", "Slate"

    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name="project_statuses",
        blank=True,
        null=True,
        db_index=True,
    )
    code = models.SlugField(max_length=50, allow_unicode=True)
    name = models.CharField(max_length=100)
    short_name = models.CharField(max_length=40, blank=True, default="")
    color = models.CharField(max_length=20, choices=Color.choices, default=Color.SKY)
    sort_order = models.PositiveIntegerField(default=0)
    stuck_after_days = models.PositiveIntegerField(default=3)
    is_default = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["sort_order", "id"]
        constraints = [
            models.UniqueConstraint(fields=["workspace", "code"], name="unique_workspace_project_status_code"),
        ]

    def save(self, *args, **kwargs):
        if not self.workspace_id:
            self.workspace = default_workspace()
        super().save(*args, **kwargs)
        if self.is_default:
            ProjectStatus.objects.exclude(pk=self.pk).filter(workspace=self.workspace, is_default=True).update(is_default=False)


class Client(models.Model):
    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name="clients",
        blank=True,
        null=True,
        db_index=True,
    )
    name = models.CharField(max_length=200)
    phone = models.CharField(max_length=50, blank=True, default="", db_index=True)
    email = models.EmailField(blank=True, null=True)
    address = models.CharField(max_length=300, blank=True, null=True)
    address_lat = models.CharField(max_length=32, blank=True, null=True)
    address_lon = models.CharField(max_length=32, blank=True, null=True)
    apartment = models.CharField(max_length=50, blank=True, default="")
    floor = models.CharField(max_length=50, blank=True, default="")
    works_with_contract = models.BooleanField(default=False)
    bonus_balance = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "phone"],
                condition=~models.Q(phone=""),
                name="unique_workspace_client_phone_non_empty",
            ),
        ]

    def __str__(self):
        return self.name

    def save(self, *args, **kwargs):
        if not self.workspace_id:
            self.workspace = default_workspace()
        super().save(*args, **kwargs)


class Project(models.Model):
    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name="projects",
        blank=True,
        null=True,
        db_index=True,
    )
    manager = models.ForeignKey(User, on_delete=models.PROTECT, related_name="projects")
    client = models.ForeignKey(Client, on_delete=models.SET_NULL, related_name="projects", blank=True, null=True)
    order_number = models.PositiveIntegerField(blank=True, null=True, db_index=True)
    title = models.CharField(max_length=200, blank=True, default="")
    client_name = models.CharField(max_length=200)
    client_phone = models.CharField(max_length=50, db_index=True)
    client_email = models.EmailField(blank=True, null=True)
    object_address = models.CharField(max_length=300, blank=True, null=True)
    object_lat = models.CharField(max_length=32, blank=True, null=True)
    object_lon = models.CharField(max_length=32, blank=True, null=True)
    apartment = models.CharField(max_length=50, blank=True, default="")
    entrance = models.CharField(max_length=50, blank=True, default="")
    floor = models.CharField(max_length=50, blank=True, default="")
    works_with_contract = models.BooleanField(default=False)
    description = models.TextField(blank=True, default="")
    total_amount = models.DecimalField(max_digits=12, decimal_places=2, blank=True, null=True)
    status = models.CharField(max_length=50, default="active", db_index=True)
    custom_fields = models.JSONField(blank=True, default=dict)
    bonus_promo_code = models.CharField(max_length=5, blank=True, default="")
    referred_by_client = models.ForeignKey(
        Client,
        on_delete=models.SET_NULL,
        related_name="referred_projects",
        blank=True,
        null=True,
    )
    referral_bonus_used = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    bonus_accrued_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    bonus_accrued_at = models.DateTimeField(blank=True, null=True)
    yandex_disk_path = models.CharField(max_length=600, blank=True, default="")
    yandex_disk_web_url = models.URLField(max_length=1000, blank=True, default="")
    yandex_disk_created_at = models.DateTimeField(blank=True, null=True)
    yandex_disk_archived_at = models.DateTimeField(blank=True, null=True)
    yandex_disk_error = models.TextField(blank=True, default="")

    # MVP: CSV. Можно заменить на ManyToMany позже.
    categories = models.CharField(max_length=200, blank=True, default="")  # "mirrors,furniture,shower"

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["workspace", "order_number"], name="unique_workspace_project_order_number"),
        ]

    def save(self, *args, **kwargs):
        if not self.workspace_id and self.manager_id:
            self.workspace = self.manager.workspace
        if not self.workspace_id:
            self.workspace = default_workspace()
        if not self.title:
            self.title = self.client_name or "Проект"
        if not self.order_number:
            queryset = Project.objects.filter(workspace=self.workspace) if self.workspace_id else Project.objects.all()
            max_number = queryset.aggregate(models.Max("order_number")).get("order_number__max") or 0
            self.order_number = max_number + 1
        super().save(*args, **kwargs)


class ClientBonusTransaction(models.Model):
    class Type(models.TextChoices):
        ACCRUAL = "accrual", "Accrual"
        ACCRUAL_REVERSAL = "accrual_reversal", "Accrual reversal"
        PROMO_DEBIT = "promo_debit", "Promo debit"
        PROMO_CREDIT = "promo_credit", "Promo credit"
        PROMO_REFUND = "promo_refund", "Promo refund"
        PROMO_CREDIT_REVERSAL = "promo_credit_reverse", "Promo credit reversal"

    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name="client_bonus_transactions",
        blank=True,
        null=True,
        db_index=True,
    )
    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="bonus_transactions")
    project = models.ForeignKey(Project, on_delete=models.SET_NULL, related_name="bonus_transactions", blank=True, null=True)
    related_client = models.ForeignKey(
        Client,
        on_delete=models.SET_NULL,
        related_name="related_bonus_transactions",
        blank=True,
        null=True,
    )
    created_by = models.ForeignKey(User, on_delete=models.SET_NULL, related_name="created_bonus_transactions", blank=True, null=True)
    type = models.CharField(max_length=20, choices=Type.choices)
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    balance_after = models.DecimalField(max_digits=12, decimal_places=2)
    promo_code = models.CharField(max_length=5, blank=True, default="")
    comment = models.CharField(max_length=300, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(fields=["workspace", "client", "-created_at"]),
            models.Index(fields=["workspace", "project"]),
        ]

    def save(self, *args, **kwargs):
        if not self.workspace_id and self.client_id:
            self.workspace = self.client.workspace
        if not self.workspace_id:
            self.workspace = default_workspace()
        super().save(*args, **kwargs)


class FinanceCategory(models.Model):
    class Type(models.TextChoices):
        EXPENSE = "expense", "Expense"
        INCOME = "income", "Income"

    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name="finance_categories",
        blank=True,
        null=True,
        db_index=True,
    )
    name = models.CharField(max_length=120)
    type = models.CharField(max_length=20, choices=Type.choices, default=Type.EXPENSE, db_index=True)
    sort_order = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["type", "sort_order", "id"]
        constraints = [
            models.UniqueConstraint(fields=["workspace", "name", "type"], name="unique_workspace_finance_category_name_type"),
        ]

    def save(self, *args, **kwargs):
        if not self.workspace_id:
            self.workspace = default_workspace()
        super().save(*args, **kwargs)


class Account(models.Model):
    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name="accounts",
        blank=True,
        null=True,
        db_index=True,
    )
    name = models.CharField(max_length=120)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name", "id"]
        constraints = [
            models.UniqueConstraint(fields=["workspace", "name"], name="unique_workspace_account_name"),
        ]

    def save(self, *args, **kwargs):
        if not self.workspace_id:
            self.workspace = default_workspace()
        super().save(*args, **kwargs)


class ProjectCustomField(models.Model):
    class FieldType(models.TextChoices):
        TEXT = "text", "Text"
        NUMBER = "number", "Number"
        DATE = "date", "Date"
        FILE = "file", "File"

    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name="project_custom_fields",
        blank=True,
        null=True,
        db_index=True,
    )
    name = models.CharField(max_length=120)
    field_type = models.CharField(max_length=20, choices=FieldType.choices, default=FieldType.TEXT)
    sort_order = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["sort_order", "id"]

    def save(self, *args, **kwargs):
        if not self.workspace_id:
            self.workspace = default_workspace()
        super().save(*args, **kwargs)


def document_template_upload_to(instance, filename):
    return f"document_templates/{instance.type}.pdf"


class DocumentTemplate(models.Model):
    class Type(models.TextChoices):
        CONTRACT = "contract", "Contract"
        ACT = "act", "Act"

    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name="document_templates",
        blank=True,
        null=True,
        db_index=True,
    )
    type = models.CharField(max_length=20, choices=Type.choices)
    file = models.FileField(upload_to=document_template_upload_to)
    original_name = models.CharField(max_length=255, blank=True, default="")
    uploaded_by = models.ForeignKey(
        User,
        on_delete=models.PROTECT,
        related_name="uploaded_document_templates",
        blank=True,
        null=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["type"]
        constraints = [
            models.UniqueConstraint(fields=["workspace", "type"], name="unique_workspace_document_template_type"),
        ]

    def save(self, *args, **kwargs):
        if not self.workspace_id:
            self.workspace = default_workspace()
        super().save(*args, **kwargs)


class ChatIntegrationSettings(models.Model):
    class Provider(models.TextChoices):
        CHATWOOT = "chatwoot", "Chatwoot"

    workspace = models.OneToOneField(
        Workspace,
        on_delete=models.CASCADE,
        related_name="chat_settings",
        blank=True,
        null=True,
    )
    provider = models.CharField(max_length=30, choices=Provider.choices, default=Provider.CHATWOOT)
    enabled = models.BooleanField(default=False)
    base_url = models.URLField(blank=True, default="")
    account_id = models.CharField(max_length=60, blank=True, default="")
    inbox_name = models.CharField(max_length=120, blank=True, default="")
    api_access_token = models.CharField(max_length=255, blank=True, default="")
    updated_by = models.ForeignKey(
        User,
        on_delete=models.PROTECT,
        related_name="updated_chat_settings",
        blank=True,
        null=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Chat integration settings"
        verbose_name_plural = "Chat integration settings"

    def __str__(self):
        return self.inbox_name or self.base_url or self.get_provider_display()

    def save(self, *args, **kwargs):
        if not self.workspace_id:
            self.workspace = default_workspace()
        super().save(*args, **kwargs)


def default_yandex_disk_folder_template():
    return [
        "Визуализация",
        "Закупочная смета",
        "Модель",
        "Раскрой",
        "Смета",
        "Согласование",
        "ТЗ",
        "Чертежи",
    ]


class YandexDiskSettings(models.Model):
    workspace = models.OneToOneField(
        Workspace,
        on_delete=models.CASCADE,
        related_name="yandex_disk_settings",
        blank=True,
        null=True,
    )
    enabled = models.BooleanField(default=False)
    auto_create_project_folders = models.BooleanField(default=True)
    base_path = models.CharField(max_length=500, blank=True, default="/CRM/Проекты")
    archive_path = models.CharField(max_length=500, blank=True, default="/CRM/Архив")
    folder_template = models.JSONField(default=default_yandex_disk_folder_template, blank=True)
    oauth_token = models.CharField(max_length=512, blank=True, default="")
    updated_by = models.ForeignKey(
        User,
        on_delete=models.PROTECT,
        related_name="updated_yandex_disk_settings",
        blank=True,
        null=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Yandex Disk settings"
        verbose_name_plural = "Yandex Disk settings"

    def __str__(self):
        return self.base_path or "Yandex Disk"

    def save(self, *args, **kwargs):
        if not self.workspace_id:
            self.workspace = default_workspace()
        super().save(*args, **kwargs)


class CalculatorSettings(models.Model):
    workspace = models.OneToOneField(
        Workspace,
        on_delete=models.CASCADE,
        related_name="calculator_settings",
        blank=True,
        null=True,
    )
    shower_catalog = models.JSONField(default=dict, blank=True)
    mirror_catalog = models.JSONField(default=dict, blank=True)
    updated_by = models.ForeignKey(
        User,
        on_delete=models.PROTECT,
        related_name="updated_calculator_settings",
        blank=True,
        null=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Calculator settings"
        verbose_name_plural = "Calculator settings"

    def __str__(self):
        return f"Calculator settings: {self.workspace or 'default'}"

    def save(self, *args, **kwargs):
        if not self.workspace_id:
            self.workspace = default_workspace()
        super().save(*args, **kwargs)


class Payment(models.Model):
    class Type(models.TextChoices):
        ADVANCE = "advance", "Advance"
        ADDITIONAL = "additional", "Additional"
        REFUND = "refund", "Refund"
        CORRECTION = "correction", "Correction"

    class Method(models.TextChoices):
        CASH = "cash", "Cash"
        CARD = "card", "Card"
        TRANSFER = "transfer", "Transfer"
        OTHER = "other", "Other"

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="payments")
    created_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name="created_payments")
    category = models.ForeignKey(
        FinanceCategory,
        on_delete=models.SET_NULL,
        related_name="payments",
        blank=True,
        null=True,
    )
    account = models.ForeignKey(
        Account,
        on_delete=models.SET_NULL,
        related_name="payments",
        blank=True,
        null=True,
    )
    paid_at = models.DateTimeField(default=timezone.now, db_index=True)
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    type = models.CharField(max_length=20, choices=Type.choices)
    method = models.CharField(max_length=20, choices=Method.choices, default=Method.TRANSFER)
    comment = models.CharField(max_length=500, blank=True, default="")
    attachment_url = models.URLField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)


class ProjectComment(models.Model):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="comments")
    author = models.ForeignKey(User, on_delete=models.PROTECT, related_name="project_comments")
    text = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)


class Task(models.Model):
    class Status(models.TextChoices):
        OPEN = "open", "Open"
        DONE = "done", "Done"

    class Priority(models.TextChoices):
        LOW = "low", "Low"
        MEDIUM = "medium", "Medium"
        HIGH = "high", "High"

    title = models.CharField(max_length=200)
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="tasks", blank=True, null=True)
    notes = models.TextField(blank=True, default="")
    due_date = models.DateField(blank=True, null=True, db_index=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.OPEN, db_index=True)
    priority = models.CharField(max_length=20, choices=Priority.choices, default=Priority.MEDIUM)
    assignee = models.ForeignKey(User, on_delete=models.PROTECT, related_name="tasks")
    created_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name="created_tasks")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)


class TaskTemplate(models.Model):
    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name="task_templates",
        blank=True,
        null=True,
        db_index=True,
    )
    status = models.ForeignKey(ProjectStatus, on_delete=models.CASCADE, related_name="task_templates")
    title = models.CharField(max_length=200)
    notes = models.TextField(blank=True, default="")
    due_in_days = models.PositiveIntegerField(default=0)
    priority = models.CharField(max_length=20, choices=Task.Priority.choices, default=Task.Priority.MEDIUM)
    auto_create = models.BooleanField(default=True)
    sort_order = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["status__sort_order", "sort_order", "id"]

    def save(self, *args, **kwargs):
        if not self.workspace_id and self.status_id:
            self.workspace = self.status.workspace
        if not self.workspace_id:
            self.workspace = default_workspace()
        super().save(*args, **kwargs)


class SubscriptionPlan(models.Model):
    code = models.SlugField(max_length=50, unique=True, allow_unicode=True)
    name = models.CharField(max_length=120)
    description = models.TextField(blank=True, default="")
    price_rub = models.DecimalField(max_digits=10, decimal_places=2, default="1500.00")
    interval_months = models.PositiveIntegerField(default=1)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["id"]


class WorkspaceSubscription(models.Model):
    class Status(models.TextChoices):
        INACTIVE = "inactive", "Inactive"
        ACTIVE = "active", "Active"
        PAST_DUE = "past_due", "Past due"
        CANCELED = "canceled", "Canceled"

    workspace = models.OneToOneField(
        Workspace,
        on_delete=models.CASCADE,
        related_name="subscription",
        blank=True,
        null=True,
    )
    plan = models.ForeignKey(SubscriptionPlan, on_delete=models.PROTECT, related_name="subscriptions")
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.INACTIVE, db_index=True)
    started_at = models.DateTimeField(blank=True, null=True)
    current_period_start = models.DateField(blank=True, null=True, db_index=True)
    current_period_end = models.DateField(blank=True, null=True, db_index=True)
    auto_renew = models.BooleanField(default=True)
    last_payment_at = models.DateTimeField(blank=True, null=True)
    project_creations_count = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["id"]

    def is_active_now(self):
        today = timezone.localdate()
        return (
            self.status == self.Status.ACTIVE
            and bool(self.current_period_end)
            and self.current_period_end >= today
        )

    def save(self, *args, **kwargs):
        if not self.workspace_id:
            self.workspace = default_workspace()
        super().save(*args, **kwargs)


class SubscriptionInvoice(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        PAID = "paid", "Paid"
        CANCELED = "canceled", "Canceled"

    subscription = models.ForeignKey(WorkspaceSubscription, on_delete=models.CASCADE, related_name="invoices")
    plan = models.ForeignKey(SubscriptionPlan, on_delete=models.PROTECT, related_name="invoices")
    amount_rub = models.DecimalField(max_digits=10, decimal_places=2)
    period_start = models.DateField(db_index=True)
    period_end = models.DateField(db_index=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING, db_index=True)
    payment_provider = models.CharField(max_length=30, blank=True, default="manual")
    external_id = models.CharField(max_length=120, blank=True, default="")
    checkout_url = models.URLField(blank=True, null=True)
    paid_at = models.DateTimeField(blank=True, null=True)
    created_by = models.ForeignKey(
        User,
        on_delete=models.PROTECT,
        related_name="created_subscription_invoices",
        blank=True,
        null=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]


class Commission(models.Model):
    class Status(models.TextChoices):
        ACCRUED = "accrued", "Accrued"
        PAYABLE = "payable", "Payable"
        PAID = "paid", "Paid"
        CANCELED = "canceled", "Canceled"

    payment = models.OneToOneField(Payment, on_delete=models.PROTECT, related_name="commission")
    project = models.ForeignKey(Project, on_delete=models.PROTECT, related_name="commissions")
    manager = models.ForeignKey(User, on_delete=models.PROTECT, related_name="commissions")

    # first day of month (date)
    period_month = models.DateField(db_index=True)

    base_amount = models.DecimalField(max_digits=12, decimal_places=2)
    rate = models.DecimalField(max_digits=5, decimal_places=4)  # 0.0500 / 0.0800
    commission_amount = models.DecimalField(max_digits=12, decimal_places=2)

    # meaningful only if this payment is the first project-advance in that month
    sale_number_in_month = models.PositiveIntegerField(default=0)

    status = models.CharField(max_length=20, choices=Status.choices, default=Status.ACCRUED)
    canceled_reason = models.CharField(max_length=500, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)


class Payout(models.Model):
    manager = models.ForeignKey(User, on_delete=models.PROTECT, related_name="payouts")
    period_month = models.DateField(db_index=True)
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    paid_at = models.DateTimeField(default=timezone.now)
    comment = models.CharField(max_length=500, blank=True, default="")
    created_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name="created_payouts")
    created_at = models.DateTimeField(auto_now_add=True)


class AuditLog(models.Model):
    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name="audit_logs",
        blank=True,
        null=True,
        db_index=True,
    )
    actor = models.ForeignKey(User, on_delete=models.PROTECT, related_name="audit_logs")
    entity_type = models.CharField(max_length=50)
    entity_id = models.CharField(max_length=50)
    action = models.CharField(max_length=50)  # create/update/delete/cancel
    before_json = models.JSONField(null=True, blank=True)
    after_json = models.JSONField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def save(self, *args, **kwargs):
        if not self.workspace_id and self.actor_id:
            self.workspace = self.actor.workspace
        if not self.workspace_id:
            self.workspace = default_workspace()
        super().save(*args, **kwargs)
