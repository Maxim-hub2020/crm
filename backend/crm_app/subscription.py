from calendar import monthrange
from datetime import date, timedelta
from decimal import Decimal

from django.utils import timezone

from .models import Project, SubscriptionInvoice, SubscriptionPlan, WorkspaceSubscription
from .tenancy import current_workspace, ensure_default_workspace


TRIAL_PROJECT_LIMIT = 10
BASIC_PLAN_CODE = "crm-basic-monthly"
ASSISTANT_PLAN_CODE = "crm-ai-monthly"

SUBSCRIPTION_PLANS = [
    {
        "code": BASIC_PLAN_CODE,
        "name": "CRM без AI-помощника",
        "description": "Доступ к CRM, проектам, клиентам, задачам и финансам без голосового AI-помощника.",
        "price_rub": Decimal("1000.00"),
        "interval_months": 1,
        "includes_assistant": False,
        "is_active": True,
    },
    {
        "code": ASSISTANT_PLAN_CODE,
        "name": "CRM + AI-помощник",
        "description": "Полный доступ к CRM и голосовому AI-помощнику.",
        "price_rub": Decimal("1500.00"),
        "interval_months": 1,
        "includes_assistant": True,
        "is_active": True,
    },
]


def add_months(source_date, months):
    base_date = source_date or timezone.localdate()
    month_index = base_date.month - 1 + months
    year = base_date.year + month_index // 12
    month = month_index % 12 + 1
    day = min(base_date.day, monthrange(year, month)[1])
    return date(year, month, day)


def ensure_subscription_defaults(workspace=None):
    workspace = workspace or ensure_default_workspace()
    plans_by_code = {}
    for plan_data in SUBSCRIPTION_PLANS:
        plan, _ = SubscriptionPlan.objects.update_or_create(
            code=plan_data["code"],
            defaults=plan_data,
        )
        plans_by_code[plan.code] = plan
    SubscriptionPlan.objects.filter(code="procrm-monthly").update(is_active=False)

    assistant_plan = plans_by_code[ASSISTANT_PLAN_CODE]
    subscription = WorkspaceSubscription.objects.select_related("plan").filter(workspace=workspace).first()
    if not subscription:
        subscription = WorkspaceSubscription.objects.create(
            workspace=workspace,
            plan=assistant_plan,
            project_creations_count=Project.objects.filter(workspace=workspace).count(),
        )
    elif not subscription.plan_id or subscription.plan.code == "procrm-monthly":
        subscription.plan = assistant_plan
        subscription.save(update_fields=["plan", "updated_at"])
    return assistant_plan, subscription


def get_workspace_subscription(user=None, workspace=None):
    active_workspace = workspace or (current_workspace(user) if user is not None else None)
    _, subscription = ensure_subscription_defaults(active_workspace)
    return WorkspaceSubscription.objects.select_related("plan").prefetch_related("invoices").get(pk=subscription.pk)


def get_latest_invoice(subscription=None):
    active_subscription = subscription or get_workspace_subscription()
    return active_subscription.invoices.select_related("plan", "created_by").first()


def is_subscription_active(subscription=None):
    active_subscription = subscription or get_workspace_subscription()
    return active_subscription.is_active_now()


def has_trial_access(subscription=None):
    active_subscription = subscription or get_workspace_subscription()
    return active_subscription.project_creations_count < TRIAL_PROJECT_LIMIT


def can_create_trial_project(subscription=None):
    active_subscription = subscription or get_workspace_subscription()
    return active_subscription.project_creations_count < TRIAL_PROJECT_LIMIT


def has_assistant_access(subscription=None):
    active_subscription = subscription or get_workspace_subscription()
    return active_subscription.is_active_now() and bool(active_subscription.plan.includes_assistant)


def record_project_created(subscription=None):
    active_subscription = subscription or get_workspace_subscription()
    active_subscription.project_creations_count += 1
    active_subscription.save(update_fields=["project_creations_count", "updated_at"])
    return active_subscription


def get_subscription_plan(plan_code=None, workspace=None):
    ensure_subscription_defaults(workspace)
    code = plan_code or ASSISTANT_PLAN_CODE
    return SubscriptionPlan.objects.filter(code=code, is_active=True).first() or SubscriptionPlan.objects.get(code=ASSISTANT_PLAN_CODE)


def issue_subscription_invoice(actor=None, plan_code=None):
    workspace = current_workspace(actor)
    subscription = get_workspace_subscription(workspace=workspace)
    plan = get_subscription_plan(plan_code, workspace=workspace)
    latest_pending = subscription.invoices.filter(status=SubscriptionInvoice.Status.PENDING, plan=plan).first()
    if latest_pending:
        return latest_pending

    if subscription.plan_id != plan.id:
        subscription.plan = plan
        subscription.save(update_fields=["plan", "updated_at"])

    today = timezone.localdate()
    if subscription.current_period_end and subscription.current_period_end >= today:
        period_start = subscription.current_period_end + timedelta(days=1)
    else:
        period_start = today

    period_end = add_months(period_start, plan.interval_months) - timedelta(days=1)

    return SubscriptionInvoice.objects.create(
        subscription=subscription,
        plan=plan,
        amount_rub=plan.price_rub,
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
    subscription.plan = invoice.plan
    subscription.status = WorkspaceSubscription.Status.ACTIVE
    subscription.started_at = subscription.started_at or now
    subscription.current_period_start = invoice.period_start
    subscription.current_period_end = invoice.period_end
    subscription.last_payment_at = now
    subscription.save(
        update_fields=[
            "plan",
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
    workspace = current_workspace(user)
    subscription = get_workspace_subscription(workspace=workspace)
    latest_invoice = get_latest_invoice(subscription)
    today = timezone.localdate()
    days_left = (
        (subscription.current_period_end - today).days + 1
        if subscription.current_period_end and subscription.current_period_end >= today
        else 0
    )

    plans = SubscriptionPlan.objects.filter(is_active=True).order_by("price_rub", "id")

    return {
        "can_manage": bool(user and user.is_authenticated and user.is_admin()),
        "workspace": {
            "id": workspace.id if workspace else None,
            "name": workspace.name if workspace else "",
            "slug": workspace.slug if workspace else "",
        },
        "plan": {
            "id": subscription.plan.id,
            "code": subscription.plan.code,
            "name": subscription.plan.name,
            "description": subscription.plan.description,
            "price_rub": str(subscription.plan.price_rub),
            "interval_months": subscription.plan.interval_months,
            "includes_assistant": subscription.plan.includes_assistant,
            "is_active": subscription.plan.is_active,
        },
        "plans": [
            {
                "id": plan.id,
                "code": plan.code,
                "name": plan.name,
                "description": plan.description,
                "price_rub": str(plan.price_rub),
                "interval_months": plan.interval_months,
                "includes_assistant": plan.includes_assistant,
                "is_active": plan.is_active,
            }
            for plan in plans
        ],
        "trial": {
            "project_limit": TRIAL_PROJECT_LIMIT,
            "project_creations_count": subscription.project_creations_count,
            "remaining_projects": max(TRIAL_PROJECT_LIMIT - subscription.project_creations_count, 0),
            "can_use_trial": has_trial_access(subscription),
            "can_create_project": subscription.is_active_now() or can_create_trial_project(subscription),
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
