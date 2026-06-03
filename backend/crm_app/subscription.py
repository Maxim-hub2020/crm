from calendar import monthrange
from datetime import date, timedelta
from decimal import Decimal

from django.utils import timezone

from .models import SubscriptionInvoice, SubscriptionPlan, WorkspaceSubscription


DEFAULT_SUBSCRIPTION_PLAN = {
    "code": "procrm-monthly",
    "name": "ProCRM",
    "description": "Полный доступ ко всей CRM-системе, голосовому помощнику и модулям команды.",
    "price_rub": Decimal("1500.00"),
    "interval_months": 1,
    "is_active": True,
}


def add_months(source_date, months):
    base_date = source_date or timezone.localdate()
    month_index = base_date.month - 1 + months
    year = base_date.year + month_index // 12
    month = month_index % 12 + 1
    day = min(base_date.day, monthrange(year, month)[1])
    return date(year, month, day)


def ensure_subscription_defaults():
    plan, _ = SubscriptionPlan.objects.get_or_create(
        code=DEFAULT_SUBSCRIPTION_PLAN["code"],
        defaults=DEFAULT_SUBSCRIPTION_PLAN,
    )
    subscription = WorkspaceSubscription.objects.select_related("plan").first()
    if not subscription:
        subscription = WorkspaceSubscription.objects.create(plan=plan)
    elif not subscription.plan_id:
        subscription.plan = plan
        subscription.save(update_fields=["plan", "updated_at"])
    return plan, subscription


def get_workspace_subscription():
    _, subscription = ensure_subscription_defaults()
    return WorkspaceSubscription.objects.select_related("plan").prefetch_related("invoices").get(pk=subscription.pk)


def get_latest_invoice(subscription=None):
    active_subscription = subscription or get_workspace_subscription()
    return active_subscription.invoices.select_related("plan", "created_by").first()


def is_subscription_active(subscription=None):
    active_subscription = subscription or get_workspace_subscription()
    return active_subscription.is_active_now()


def issue_subscription_invoice(actor=None):
    subscription = get_workspace_subscription()
    latest_pending = subscription.invoices.filter(status=SubscriptionInvoice.Status.PENDING).first()
    if latest_pending:
        return latest_pending

    today = timezone.localdate()
    if subscription.current_period_end and subscription.current_period_end >= today:
        period_start = subscription.current_period_end + timedelta(days=1)
    else:
        period_start = today

    period_end = add_months(period_start, subscription.plan.interval_months) - timedelta(days=1)

    return SubscriptionInvoice.objects.create(
        subscription=subscription,
        plan=subscription.plan,
        amount_rub=subscription.plan.price_rub,
        period_start=period_start,
        period_end=period_end,
        created_by=actor,
    )


def activate_subscription_invoice(invoice):
    if invoice.status == SubscriptionInvoice.Status.PAID:
        return invoice.subscription

    now = timezone.now()
    invoice.status = SubscriptionInvoice.Status.PAID
    invoice.paid_at = now
    invoice.save(update_fields=["status", "paid_at"])

    subscription = invoice.subscription
    subscription.status = WorkspaceSubscription.Status.ACTIVE
    subscription.started_at = subscription.started_at or now
    subscription.current_period_start = invoice.period_start
    subscription.current_period_end = invoice.period_end
    subscription.last_payment_at = now
    subscription.save(
        update_fields=[
            "status",
            "started_at",
            "current_period_start",
            "current_period_end",
            "last_payment_at",
            "updated_at",
        ]
    )
    return subscription


def billing_summary_payload(user):
    subscription = get_workspace_subscription()
    latest_invoice = get_latest_invoice(subscription)
    today = timezone.localdate()
    days_left = (
        (subscription.current_period_end - today).days + 1
        if subscription.current_period_end and subscription.current_period_end >= today
        else 0
    )

    return {
        "can_manage": bool(user and user.is_authenticated and user.is_admin()),
        "plan": {
            "id": subscription.plan.id,
            "code": subscription.plan.code,
            "name": subscription.plan.name,
            "description": subscription.plan.description,
            "price_rub": str(subscription.plan.price_rub),
            "interval_months": subscription.plan.interval_months,
            "is_active": subscription.plan.is_active,
        },
        "subscription": {
            "id": subscription.id,
            "status": subscription.status,
            "is_active_now": subscription.is_active_now(),
            "current_period_start": subscription.current_period_start.isoformat() if subscription.current_period_start else None,
            "current_period_end": subscription.current_period_end.isoformat() if subscription.current_period_end else None,
            "auto_renew": subscription.auto_renew,
            "days_left": days_left,
            "last_payment_at": subscription.last_payment_at.isoformat() if subscription.last_payment_at else None,
        },
        "latest_invoice": (
            {
                "id": latest_invoice.id,
                "amount_rub": str(latest_invoice.amount_rub),
                "status": latest_invoice.status,
                "period_start": latest_invoice.period_start.isoformat(),
                "period_end": latest_invoice.period_end.isoformat(),
                "payment_provider": latest_invoice.payment_provider,
                "checkout_url": latest_invoice.checkout_url,
                "paid_at": latest_invoice.paid_at.isoformat() if latest_invoice.paid_at else None,
                "created_at": latest_invoice.created_at.isoformat(),
            }
            if latest_invoice
            else None
        ),
    }
