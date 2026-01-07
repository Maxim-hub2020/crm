from django.db import models
from django.contrib.auth.models import AbstractUser
from django.utils import timezone

class User(AbstractUser):
    class Role(models.TextChoices):
        ADMIN = "admin", "Admin"
        MANAGER = "manager", "Manager"

    role = models.CharField(max_length=20, choices=Role.choices, default=Role.MANAGER)

    def is_admin(self):
        return self.role == self.Role.ADMIN or self.is_superuser


class Project(models.Model):
    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        CLOSED = "closed", "Closed"
        CANCELED = "canceled", "Canceled"

    manager = models.ForeignKey(User, on_delete=models.PROTECT, related_name="projects")
    client_name = models.CharField(max_length=200)
    client_phone = models.CharField(max_length=50, db_index=True)
    client_email = models.EmailField(blank=True, null=True)
    object_address = models.CharField(max_length=300, blank=True, null=True)
    description = models.TextField(blank=True, default="")
    total_amount = models.DecimalField(max_digits=12, decimal_places=2, blank=True, null=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.ACTIVE)

    # MVP: CSV. Можно заменить на ManyToMany позже.
    categories = models.CharField(max_length=200, blank=True, default="")  # "mirrors,furniture,shower"

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)


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
    paid_at = models.DateTimeField(default=timezone.now, db_index=True)
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    type = models.CharField(max_length=20, choices=Type.choices)
    method = models.CharField(max_length=20, choices=Method.choices, default=Method.TRANSFER)
    comment = models.CharField(max_length=500, blank=True, default="")
    attachment_url = models.URLField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)


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
    actor = models.ForeignKey(User, on_delete=models.PROTECT, related_name="audit_logs")
    entity_type = models.CharField(max_length=50)
    entity_id = models.CharField(max_length=50)
    action = models.CharField(max_length=50)  # create/update/delete/cancel
    before_json = models.JSONField(null=True, blank=True)
    after_json = models.JSONField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
