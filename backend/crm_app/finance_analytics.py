from decimal import Decimal, ROUND_HALF_UP

from django.utils import timezone

from .models import FinanceCategory, Payment, ProjectStatus


MARGIN_WARNING_PERCENT = Decimal("30")
MONEY_QUANT = Decimal("0.01")

REQUIRED_EXPENSE_GROUPS = [
    {
        "key": "delivery",
        "label": "Доставка",
        "keywords": ("достав",),
    },
    {
        "key": "contractors",
        "label": "Контрагенты",
        "keywords": ("контрагент", "подрядчик", "поставщик"),
    },
    {
        "key": "calculations",
        "label": "Расчеты",
        "keywords": ("расчет", "расчёт"),
    },
    {
        "key": "components",
        "label": "Комплектующие",
        "keywords": ("комплект", "материал", "фурнитур", "расходник"),
    },
]


def _money(value):
    return (value or Decimal("0")).quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)


def _decimal_string(value):
    return str(_money(value))


def _percent_string(value):
    if value is None:
        return None
    return str(value.quantize(MONEY_QUANT, rounding=ROUND_HALF_UP))


def _payment_kind(payment):
    category_type = getattr(payment.category, "type", "")
    if category_type == FinanceCategory.Type.EXPENSE:
        return FinanceCategory.Type.EXPENSE
    if category_type == FinanceCategory.Type.INCOME:
        return FinanceCategory.Type.INCOME
    if payment.type in (Payment.Type.REFUND, Payment.Type.CORRECTION):
        return FinanceCategory.Type.EXPENSE
    return FinanceCategory.Type.INCOME


def _payment_text(payment):
    return f"{getattr(payment.category, 'name', '')} {payment.comment or ''}".casefold()


def _is_terminal_status(project):
    statuses = ProjectStatus.objects.filter(workspace=project.workspace)
    latest_status = statuses.order_by("sort_order", "id").last()
    if statuses.count() > 1 and latest_status and project.status == latest_status.code:
        return True

    status_text = str(project.status or "").casefold()
    return any(marker in status_text for marker in ("заверш", "закры", "closed", "done", "finish"))


def build_project_finance_analytics(project):
    now = timezone.now()
    expected_income = _money(Decimal(project.total_amount or 0) - Decimal(project.referral_bonus_used or 0))
    if expected_income < 0:
        expected_income = Decimal("0.00")

    all_payments = list(project.payments.select_related("category", "account").order_by("paid_at", "id"))
    current_payments = [payment for payment in all_payments if payment.paid_at <= now]
    future_payments = [payment for payment in all_payments if payment.paid_at > now]

    income_payments = [payment for payment in current_payments if _payment_kind(payment) == FinanceCategory.Type.INCOME]
    expense_payments = [payment for payment in current_payments if _payment_kind(payment) == FinanceCategory.Type.EXPENSE]

    income_paid = _money(sum((payment.amount for payment in income_payments), Decimal("0")))
    expense_total = _money(sum((payment.amount for payment in expense_payments), Decimal("0")))
    margin_amount = _money(income_paid - expense_total)
    margin_percent = None
    if income_paid > 0:
        margin_percent = (margin_amount / income_paid * Decimal("100")).quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)

    required_expenses = []
    for group in REQUIRED_EXPENSE_GROUPS:
        matched = [
            payment
            for payment in expense_payments
            if any(keyword in _payment_text(payment) for keyword in group["keywords"])
        ]
        required_expenses.append(
            {
                "key": group["key"],
                "label": group["label"],
                "present": bool(matched),
                "count": len(matched),
                "amount": _decimal_string(sum((payment.amount for payment in matched), Decimal("0"))),
            }
        )

    missing_required_expenses = [item["label"] for item in required_expenses if not item["present"]]
    paid_in_full = expected_income > 0 and income_paid >= expected_income
    low_margin = margin_percent is not None and margin_percent < MARGIN_WARNING_PERCENT
    is_terminal_status = _is_terminal_status(project)
    should_review = paid_in_full or is_terminal_status

    recommendations = []
    if expected_income <= 0:
        recommendations.append("Укажите сумму проекта, чтобы система могла сравнить план и оплату клиента.")
    elif not paid_in_full:
        recommendations.append("Доходы клиента пока не закрывают сумму проекта.")

    if missing_required_expenses:
        recommendations.append(
            "Перед закрытием проверьте обязательные расходники: "
            + ", ".join(missing_required_expenses)
            + "."
        )

    if low_margin:
        recommendations.append(
            "Маржа ниже 30%. Проверьте себестоимость, цены контрагентов и комплектующие."
        )
    elif margin_percent is not None and paid_in_full and not missing_required_expenses:
        recommendations.append("Проект финансово закрыт: оплата сходится, обязательные расходники внесены.")

    if future_payments:
        recommendations.append("Есть операции будущей датой, они не входят в текущую маржу.")

    return {
        "project": project.id,
        "expected_income": _decimal_string(expected_income),
        "income_paid": _decimal_string(income_paid),
        "expense_total": _decimal_string(expense_total),
        "margin_amount": _decimal_string(margin_amount),
        "margin_percent": _percent_string(margin_percent),
        "margin_warning_percent": _decimal_string(MARGIN_WARNING_PERCENT),
        "paid_in_full": paid_in_full,
        "low_margin": low_margin,
        "is_terminal_status": is_terminal_status,
        "should_review": should_review,
        "needs_attention": bool(low_margin or missing_required_expenses or (should_review and not paid_in_full)),
        "income_payment_count": len(income_payments),
        "expense_payment_count": len(expense_payments),
        "has_future_payments": bool(future_payments),
        "required_expenses": required_expenses,
        "missing_required_expenses": missing_required_expenses,
        "recommendations": recommendations,
    }
