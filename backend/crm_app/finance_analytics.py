import re
from datetime import timedelta
from decimal import Decimal, ROUND_HALF_UP
from math import ceil

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
        "key": "montage",
        "label": "Монтаж",
        "keywords": ("монтаж", "сборк", "установ"),
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

FALLBACK_REQUIRED_EXPENSE_RATIOS = {
    "delivery": Decimal("0.05"),
    "montage": Decimal("0.12"),
    "contractors": Decimal("0.08"),
    "calculations": Decimal("0.03"),
    "components": Decimal("0.25"),
}
FALLBACK_REQUIRED_EXPENSE_MINIMUMS = {
    "delivery": Decimal("2500"),
    "montage": Decimal("7000"),
    "contractors": Decimal("0"),
    "calculations": Decimal("0"),
    "components": Decimal("0"),
}
FALLBACK_TOTAL_EXPENSE_RATIO = sum(FALLBACK_REQUIRED_EXPENSE_RATIOS.values(), Decimal("0"))
ALWAYS_FORECAST_REQUIRED_GROUPS = {"delivery", "montage"}
LEARNED_CATEGORY_MIN_FREQUENCY = Decimal("0.60")
PROJECT_TOKEN_STOP_WORDS = {
    "проект",
    "заказ",
    "работа",
    "новый",
    "новая",
    "ростов",
    "ростове",
    "ростова",
    "область",
}


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


def _expense_group_for_payment(payment):
    text = _payment_text(payment)
    for group in REQUIRED_EXPENSE_GROUPS:
        if any(keyword in text for keyword in group["keywords"]):
            return group["key"]
    return "other"


def _current_expense_payments(project):
    now = timezone.now()
    payments = list(project.payments.select_related("category", "account").order_by("paid_at", "id"))
    return [
        payment
        for payment in payments
        if (not payment.paid_at or payment.paid_at <= now)
        and _payment_kind(payment) == FinanceCategory.Type.EXPENSE
    ]


def _expense_group_totals(payments):
    totals = {}
    for payment in payments:
        group_key = _expense_group_for_payment(payment)
        totals[group_key] = totals.get(group_key, Decimal("0")) + _money(payment.amount)
    return totals


def _expense_category_totals(payments):
    totals = {}
    for payment in payments:
        category = getattr(payment, "category", None)
        if not category or category.type != FinanceCategory.Type.EXPENSE:
            continue
        category_key = str(category.pk)
        if category_key not in totals:
            totals[category_key] = {
                "category": category.pk,
                "label": category.name,
                "total": Decimal("0"),
            }
        totals[category_key]["total"] += _money(payment.amount)
    return totals


def _median_decimal(values):
    ordered = sorted(values)
    if not ordered:
        return Decimal("0")
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / Decimal("2")


def _is_terminal_status(project):
    statuses = ProjectStatus.objects.filter(workspace=project.workspace)
    latest_status = statuses.order_by("sort_order", "id").last()
    if statuses.count() > 1 and latest_status and project.status == latest_status.code:
        return True

    status_text = str(project.status or "").casefold()
    return any(marker in status_text for marker in ("заверш", "закры", "closed", "done", "finish"))


def _is_expense_review_status(project):
    status_text = str(project.status or "").casefold()
    has_review_marker = any(
        marker in status_text
        for marker in (
            "монтаж",
            "заверш",
            "закры",
            "install",
            "montage",
            "closed",
            "done",
            "finish",
        )
    )
    statuses = list(ProjectStatus.objects.filter(workspace=project.workspace).order_by("sort_order", "id"))
    if len(statuses) >= 2:
        return project.status in {statuses[-1].code, statuses[-2].code} or has_review_marker
    if len(statuses) == 1:
        return project.status == statuses[-1].code or has_review_marker

    return has_review_marker


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

    project_margin_amount = _money(expected_income - expense_total)
    project_margin_percent = None
    if expected_income > 0:
        project_margin_percent = (
            project_margin_amount / expected_income * Decimal("100")
        ).quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)

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
    expense_review_active = _is_expense_review_status(project)
    should_review = expense_review_active

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

    if not expense_review_active:
        recommendations = []

    if future_payments:
        recommendations.append("Есть операции будущей датой, они не входят в текущую маржу.")

    return {
        "project": project.id,
        "expected_income": _decimal_string(expected_income),
        "income_paid": _decimal_string(income_paid),
        "expense_total": _decimal_string(expense_total),
        "margin_amount": _decimal_string(margin_amount),
        "margin_percent": _percent_string(margin_percent),
        "project_margin_amount": _decimal_string(project_margin_amount),
        "project_margin_percent": _percent_string(project_margin_percent),
        "project_low_margin": project_margin_percent is not None and project_margin_percent < MARGIN_WARNING_PERCENT,
        "margin_warning_percent": _decimal_string(MARGIN_WARNING_PERCENT),
        "paid_in_full": paid_in_full,
        "low_margin": low_margin,
        "is_terminal_status": is_terminal_status,
        "expense_review_active": expense_review_active,
        "should_review": should_review,
        "needs_attention": bool(
            expense_review_active and (low_margin or missing_required_expenses or not paid_in_full)
        ),
        "income_payment_count": len(income_payments),
        "expense_payment_count": len(expense_payments),
        "has_future_payments": bool(future_payments),
        "required_expenses": required_expenses,
        "missing_required_expenses": missing_required_expenses,
        "recommendations": recommendations,
    }


def _project_label(project):
    order_label = f"№{project.order_number:04d}" if project.order_number else f"#{project.id}"
    title = project.title or project.client_name or "Проект"
    return f"{order_label} · {title}"


def _serialize_payment_for_analytics(payment):
    kind = _payment_kind(payment)
    amount = _money(payment.amount)
    signed_amount = -amount if kind == FinanceCategory.Type.EXPENSE else amount
    project = getattr(payment, "project", None)
    return {
        "id": payment.id,
        "project": payment.project_id,
        "project_title": _project_label(project) if project else "",
        "category": payment.category_id,
        "category_name": getattr(payment.category, "name", "") or "Без категории",
        "category_type": kind,
        "account": payment.account_id,
        "account_name": getattr(payment.account, "name", "") or "",
        "amount": _decimal_string(amount),
        "signed_amount": _decimal_string(signed_amount),
        "comment": payment.comment or "",
        "paid_at": payment.paid_at.isoformat() if payment.paid_at else "",
        "is_future": bool(payment.paid_at and payment.paid_at > timezone.now()),
    }


def _serialize_project_analytics(project, analytics):
    return {
        "id": project.id,
        "title": _project_label(project),
        "client_name": project.client_name,
        "status": project.status,
        "expected_income": analytics["expected_income"],
        "income_paid": analytics["income_paid"],
        "expense_total": analytics["expense_total"],
        "margin_amount": analytics["margin_amount"],
        "margin_percent": analytics["margin_percent"],
        "project_margin_amount": analytics["project_margin_amount"],
        "project_margin_percent": analytics["project_margin_percent"],
        "project_low_margin": analytics["project_low_margin"],
        "paid_in_full": analytics["paid_in_full"],
        "low_margin": analytics["low_margin"],
        "expense_review_active": analytics["expense_review_active"],
        "needs_attention": analytics["needs_attention"],
        "missing_required_expenses": analytics["missing_required_expenses"],
        "recommendations": analytics["recommendations"],
    }


def _tokenize_project(project):
    value = " ".join(
        [
            project.title or "",
            project.categories or "",
        ]
    )
    return {
        token
        for token in re.findall(r"[0-9a-zA-Zа-яА-ЯёЁ]+", value.casefold())
        if len(token) >= 3 and token not in PROJECT_TOKEN_STOP_WORDS and not token.isdigit()
    }


def _project_similarity_score(target_project, source_project):
    target_tokens = _tokenize_project(target_project)
    source_tokens = _tokenize_project(source_project)
    if not target_tokens or not source_tokens:
        return 0
    return len(target_tokens & source_tokens) / len(target_tokens)


def _reference_project_learning_ready(project, analytics):
    expected_income = Decimal(analytics["expected_income"])
    expense_total = Decimal(analytics["expense_total"])
    return _is_terminal_status(project) and expected_income > 0 and expense_total > 0


def _build_required_expense_forecast(expected_income, current_group_totals, basis):
    use_full_fallback = not basis
    rows = []
    estimated_required_total = Decimal("0")

    for group in REQUIRED_EXPENSE_GROUPS:
        group_key = group["key"]
        historical_ratios = []
        for item in basis:
            reference_income = Decimal(item["analytics"]["expected_income"])
            reference_group_amount = item["expense_group_totals"].get(group_key, Decimal("0"))
            if reference_income > 0 and reference_group_amount > 0:
                historical_ratios.append(reference_group_amount / reference_income)

        if historical_ratios:
            ratio = sum(historical_ratios, Decimal("0")) / Decimal(len(historical_ratios))
            source = "history"
        elif use_full_fallback or group_key in ALWAYS_FORECAST_REQUIRED_GROUPS:
            ratio = FALLBACK_REQUIRED_EXPENSE_RATIOS.get(group_key, Decimal("0"))
            source = "baseline"
        else:
            ratio = Decimal("0")
            source = "none"

        estimated_total = _money(expected_income * ratio)
        if source != "none":
            estimated_total = max(estimated_total, FALLBACK_REQUIRED_EXPENSE_MINIMUMS.get(group_key, Decimal("0")))
        current_total = _money(current_group_totals.get(group_key, Decimal("0")))
        remaining = _money(max(estimated_total - current_total, Decimal("0")))

        if source != "none" or current_total > 0:
            rows.append(
                {
                    "key": group_key,
                    "label": group["label"],
                    "source": source,
                    "average_percent": _percent_string(ratio * Decimal("100")) if source != "none" else None,
                    "estimated_total": _decimal_string(estimated_total),
                    "current_total": _decimal_string(current_total),
                    "remaining": _decimal_string(remaining),
                }
            )

        estimated_required_total += estimated_total

    return rows, _money(estimated_required_total)


def _build_learned_category_forecast(expected_income, current_payments, basis):
    if not basis:
        return [], Decimal("0")

    current_totals = _expense_category_totals(current_payments)
    category_history = {}
    for item in basis:
        reference_income = Decimal(item["analytics"]["expected_income"])
        if reference_income <= 0:
            continue
        for category_key, category_total in item["expense_category_totals"].items():
            history = category_history.setdefault(
                category_key,
                {
                    "category": category_total["category"],
                    "label": category_total["label"],
                    "ratios": [],
                    "project_count": 0,
                },
            )
            history["ratios"].append(category_total["total"] / reference_income)
            history["project_count"] += 1

    minimum_project_count = max(1, ceil(Decimal(len(basis)) * LEARNED_CATEGORY_MIN_FREQUENCY))
    rows = []
    estimated_total = Decimal("0")
    for category_key, history in category_history.items():
        if history["project_count"] < minimum_project_count:
            continue

        ratio = _median_decimal(history["ratios"])
        category_estimate = _money(expected_income * ratio)
        current_total = _money(current_totals.get(category_key, {}).get("total", Decimal("0")))
        remaining = _money(max(category_estimate - current_total, Decimal("0")))
        if current_total <= 0:
            status = "missing"
        elif remaining > 0:
            status = "partial"
        else:
            status = "covered"

        frequency = Decimal(history["project_count"]) / Decimal(len(basis)) * Decimal("100")
        rows.append(
            {
                "category": history["category"],
                "label": history["label"],
                "status": status,
                "source": "similar_projects",
                "project_count": history["project_count"],
                "frequency_percent": _percent_string(frequency),
                "average_percent": _percent_string(ratio * Decimal("100")),
                "estimated_total": _decimal_string(category_estimate),
                "current_total": _decimal_string(current_total),
                "remaining": _decimal_string(remaining),
            }
        )
        estimated_total += category_estimate

    rows.sort(
        key=lambda row: (
            {"missing": 0, "partial": 1, "covered": 2}[row["status"]],
            -Decimal(row["remaining"]),
            row["label"].casefold(),
        )
    )
    return rows, _money(estimated_total)


def _build_project_expense_prediction(project, reference_projects):
    if not project:
        return None

    project_analytics = build_project_finance_analytics(project)
    expected_income = Decimal(project_analytics["expected_income"])
    current_expense = Decimal(project_analytics["expense_total"])
    current_expense_payments = _current_expense_payments(project)
    current_group_totals = _expense_group_totals(current_expense_payments)

    empty_prediction = {
        "project": project.id,
        "project_title": _project_label(project),
        "confidence": "none",
        "learning_scope": "none",
        "basis_project_count": 0,
        "basis_projects": [],
        "average_expense_percent": None,
        "estimated_expense_total": None,
        "current_expense_total": _decimal_string(current_expense),
        "estimated_remaining_expense": None,
        "required_expense_forecast": [],
        "learned_expense_forecast": [],
        "missing_learned_expenses": [],
        "message": "У проекта пока нет суммы, поэтому прогноз расходов построить нельзя.",
    }
    if expected_income <= 0:
        return empty_prediction

    candidates = []
    for reference_project in reference_projects:
        if reference_project.pk == project.pk:
            continue

        reference_analytics = build_project_finance_analytics(reference_project)
        if not _reference_project_learning_ready(reference_project, reference_analytics):
            continue
        reference_income = Decimal(reference_analytics["expected_income"])
        reference_expense = Decimal(reference_analytics["expense_total"])
        reference_expense_payments = _current_expense_payments(reference_project)

        candidates.append(
            {
                "project": reference_project,
                "analytics": reference_analytics,
                "expense_ratio": reference_expense / reference_income,
                "expense_group_totals": _expense_group_totals(reference_expense_payments),
                "expense_category_totals": _expense_category_totals(reference_expense_payments),
                "score": _project_similarity_score(project, reference_project),
            }
        )

    matching_candidates = [item for item in candidates if item["score"] > 0]
    basis = sorted(
        matching_candidates or candidates,
        key=lambda item: (item["score"], item["project"].created_at or timezone.now()),
        reverse=True,
    )[:5]

    if basis:
        average_ratio = sum((item["expense_ratio"] for item in basis), Decimal("0")) / Decimal(len(basis))
        learning_scope = "similar_completed_projects" if matching_candidates else "completed_projects"
    else:
        average_ratio = FALLBACK_TOTAL_EXPENSE_RATIO
        learning_scope = "baseline_required_expenses"

    required_forecast, estimated_required_total = _build_required_expense_forecast(
        expected_income,
        current_group_totals,
        basis,
    )
    learned_forecast, estimated_learned_total = _build_learned_category_forecast(
        expected_income,
        current_expense_payments,
        basis if matching_candidates else [],
    )
    estimated_expense = max(
        _money(expected_income * average_ratio),
        estimated_required_total,
        estimated_learned_total,
    )
    remaining_expense = _money(max(estimated_expense - current_expense, Decimal("0")))
    average_percent = (average_ratio * Decimal("100")).quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)
    confidence = "fallback" if not basis else "medium" if len(basis) >= 3 else "low"
    if len(matching_candidates) >= 3:
        confidence = "high"
    if learning_scope == "baseline_required_expenses":
        message = "Завершённых проектов для обучения пока мало, применены базовые обязательные статьи расходов."
    elif matching_candidates:
        message = "Прогноз построен по похожим завершённым проектам и обязательным статьям расходов."
    else:
        message = "Похожих завершённых проектов не найдено, использована база всех завершённых проектов и обязательные статьи расходов."

    return {
        "project": project.id,
        "project_title": _project_label(project),
        "confidence": confidence,
        "learning_scope": learning_scope,
        "basis_project_count": len(basis),
        "basis_projects": [
            {
                "id": item["project"].id,
                "title": _project_label(item["project"]),
                "expense_total": item["analytics"]["expense_total"],
                "expected_income": item["analytics"]["expected_income"],
                "expense_percent": _percent_string(item["expense_ratio"] * Decimal("100")),
            }
            for item in basis
        ],
        "average_expense_percent": _percent_string(average_percent),
        "estimated_expense_total": _decimal_string(estimated_expense),
        "current_expense_total": _decimal_string(current_expense),
        "estimated_remaining_expense": _decimal_string(remaining_expense),
        "required_expense_forecast": required_forecast,
        "learned_expense_forecast": learned_forecast,
        "missing_learned_expenses": [
            item["label"] for item in learned_forecast if item["status"] in {"missing", "partial"}
        ],
        "message": message,
    }


def build_finance_overview(projects_queryset, payments_queryset, filters=None, reference_projects_queryset=None):
    now = timezone.now()
    projects = list(projects_queryset.select_related("client").order_by("-created_at", "-id"))
    reference_queryset = reference_projects_queryset if reference_projects_queryset is not None else projects_queryset
    reference_projects = list(reference_queryset.select_related("client").order_by("-created_at", "-id"))
    payments = list(
        payments_queryset.select_related("project", "category", "account").order_by("-paid_at", "-id")
    )
    current_payments = [payment for payment in payments if not payment.paid_at or payment.paid_at <= now]
    future_payments = [payment for payment in payments if payment.paid_at and payment.paid_at > now]
    income_payments = [payment for payment in current_payments if _payment_kind(payment) == FinanceCategory.Type.INCOME]
    expense_payments = [payment for payment in current_payments if _payment_kind(payment) == FinanceCategory.Type.EXPENSE]

    income_total = _money(sum((payment.amount for payment in income_payments), Decimal("0")))
    expense_total = _money(sum((payment.amount for payment in expense_payments), Decimal("0")))
    margin_amount = _money(income_total - expense_total)
    margin_percent = None
    if income_total > 0:
        margin_percent = (margin_amount / income_total * Decimal("100")).quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)

    categories = {}
    for payment in current_payments:
        kind = _payment_kind(payment)
        category_key = f"{kind}:{payment.category_id or 'none'}"
        if category_key not in categories:
            categories[category_key] = {
                "id": payment.category_id,
                "name": getattr(payment.category, "name", "") or "Без категории",
                "type": kind,
                "count": 0,
                "total": Decimal("0"),
            }
        categories[category_key]["count"] += 1
        categories[category_key]["total"] += payment.amount

    category_rows = sorted(
        (
            {
                "id": item["id"],
                "name": item["name"],
                "type": item["type"],
                "count": item["count"],
                "total": _decimal_string(item["total"]),
            }
            for item in categories.values()
        ),
        key=lambda item: (item["type"], -Decimal(item["total"]), item["name"]),
    )

    project_rows = []
    for project in projects:
        analytics = build_project_finance_analytics(project)
        project_rows.append(_serialize_project_analytics(project, analytics))

    at_risk_projects = sorted(
        [project for project in project_rows if project["needs_attention"]],
        key=lambda project: (
            not project["low_margin"],
            len(project["missing_required_expenses"]),
            Decimal(project["margin_percent"] or "999"),
        ),
    )
    review_project_rows = [project for project in project_rows if project["expense_review_active"]]

    recommendations = []
    if review_project_rows and margin_percent is not None and margin_percent < MARGIN_WARNING_PERCENT:
        recommendations.append("Общая маржа по выбранным операциям ниже 30%. Проверьте расходы и цены по проектам.")
    if at_risk_projects:
        recommendations.append(f"Есть проекты, требующие проверки: {len(at_risk_projects)}.")
    if future_payments:
        recommendations.append(f"Есть будущие операции: {len(future_payments)}. Они не входят в текущую маржу.")
    selected_project = None
    filter_project_id = str((filters or {}).get("project") or "").strip()
    if filter_project_id and filter_project_id != "all" and len(projects) == 1:
        selected_project = projects[0]

    expense_prediction = _build_project_expense_prediction(selected_project, reference_projects)
    if (
        selected_project
        and _is_expense_review_status(selected_project)
        and expense_prediction
        and expense_prediction.get("estimated_remaining_expense")
    ):
        remaining_expense = Decimal(expense_prediction["estimated_remaining_expense"])
        if remaining_expense > 0:
            recommendations.append(
                f"Прогноз дополнительных расходов по проекту: {_decimal_string(remaining_expense)} ₽."
            )

    if not recommendations:
        recommendations.append("Критичных финансовых отклонений по выбранной выборке не найдено.")

    return {
        "generated_at": now.isoformat(),
        "filters": filters or {},
        "summary": {
            "income_total": _decimal_string(income_total),
            "expense_total": _decimal_string(expense_total),
            "margin_amount": _decimal_string(margin_amount),
            "margin_percent": _percent_string(margin_percent),
            "margin_warning_percent": _decimal_string(MARGIN_WARNING_PERCENT),
            "operation_count": len(payments),
            "current_operation_count": len(current_payments),
            "future_operation_count": len(future_payments),
            "income_operation_count": len(income_payments),
            "expense_operation_count": len(expense_payments),
            "project_count": len(projects),
            "at_risk_project_count": len(at_risk_projects),
        },
        "category_totals": category_rows,
        "projects": project_rows,
        "at_risk_projects": at_risk_projects,
        "recent_operations": [_serialize_payment_for_analytics(payment) for payment in payments[:12]],
        "expense_prediction": expense_prediction,
        "recommendations": recommendations,
    }


def _bucket_key_for_date(target_date, today):
    days = (target_date - today).days
    if days <= 0:
        return "today"
    if days <= 7:
        return "week"
    if days <= 30:
        return "month"
    return "sixty_days"


def _bucket_date_for_project(project, statuses, today):
    status_codes = [status.code for status in statuses]
    if project.status in status_codes:
        index = status_codes.index(project.status)
    else:
        index = 0

    if len(status_codes) >= 2 and index >= len(status_codes) - 2:
        return today + timedelta(days=7)
    if len(status_codes) >= 4 and index >= len(status_codes) // 2:
        return today + timedelta(days=30)
    return today + timedelta(days=60)


def _average_reference_expense_ratio(reference_projects):
    ratios = []
    for project in reference_projects:
        analytics = build_project_finance_analytics(project)
        if _reference_project_learning_ready(project, analytics):
            expected_income = Decimal(analytics["expected_income"])
            expense_total = Decimal(analytics["expense_total"])
            ratios.append(expense_total / expected_income)

    if not ratios:
        return FALLBACK_TOTAL_EXPENSE_RATIO
    return sum(ratios, Decimal("0")) / Decimal(len(ratios))


def _empty_cash_bucket(key, label, days_to):
    return {
        "key": key,
        "label": label,
        "days_to": days_to,
        "income": _decimal_string(Decimal("0")),
        "expense": _decimal_string(Decimal("0")),
        "net": _decimal_string(Decimal("0")),
        "items": [],
    }


def _add_cash_item(bucket, item):
    income = Decimal(bucket["income"])
    expense = Decimal(bucket["expense"])
    amount = _money(Decimal(item["amount"]))
    if item["kind"] == FinanceCategory.Type.EXPENSE:
        expense += amount
    else:
        income += amount
    bucket["income"] = _decimal_string(income)
    bucket["expense"] = _decimal_string(expense)
    bucket["net"] = _decimal_string(income - expense)
    bucket["items"].append({**item, "amount": _decimal_string(amount)})


def build_cash_forecast(projects_queryset, payments_queryset, reference_projects_queryset=None):
    now = timezone.now()
    today = timezone.localdate()
    first_project = projects_queryset.first()
    workspace = getattr(first_project, "workspace", None)
    statuses = list(ProjectStatus.objects.filter(workspace=workspace).order_by("sort_order", "id"))
    projects = list(projects_queryset.select_related("client").prefetch_related("payments").order_by("-created_at", "-id"))
    reference_source = reference_projects_queryset if reference_projects_queryset is not None else projects_queryset
    reference_projects = list(reference_source.select_related("client").prefetch_related("payments"))
    payments = list(payments_queryset.select_related("project", "category", "account").order_by("paid_at", "id"))

    buckets = {
        "today": _empty_cash_bucket("today", "Сегодня", 0),
        "week": _empty_cash_bucket("week", "7 дней", 7),
        "month": _empty_cash_bucket("month", "30 дней", 30),
        "sixty_days": _empty_cash_bucket("sixty_days", "60 дней", 60),
    }

    current_balance = Decimal("0")
    future_payment_ids = set()
    for payment in payments:
        amount = _money(payment.amount)
        kind = _payment_kind(payment)
        signed = -amount if kind == FinanceCategory.Type.EXPENSE else amount
        if not payment.paid_at or payment.paid_at <= now:
            current_balance += signed
            continue

        future_payment_ids.add(payment.id)
        paid_date = timezone.localtime(payment.paid_at).date()
        bucket = buckets[_bucket_key_for_date(paid_date, today)]
        _add_cash_item(
            bucket,
            {
                "type": "planned_operation",
                "kind": kind,
                "date": paid_date.isoformat(),
                "amount": amount,
                "title": getattr(payment.category, "name", "") or ("Расход" if kind == FinanceCategory.Type.EXPENSE else "Доход"),
                "project": payment.project_id,
                "project_title": _project_label(payment.project),
                "comment": payment.comment or "",
            },
        )

    average_expense_ratio = _average_reference_expense_ratio(reference_projects)
    project_rows = []
    for project in projects:
        analytics = build_project_finance_analytics(project)
        expected_income = Decimal(analytics["expected_income"])
        income_paid = Decimal(analytics["income_paid"])
        expense_total = Decimal(analytics["expense_total"])
        if expected_income <= 0:
            continue

        due_date = _bucket_date_for_project(project, statuses, today)
        bucket = buckets[_bucket_key_for_date(due_date, today)]
        receivable = _money(max(expected_income - income_paid, Decimal("0")))
        expense_prediction = _build_project_expense_prediction(project, reference_projects)
        estimated_expense_total = _money(
            Decimal(expense_prediction["estimated_expense_total"])
            if expense_prediction and expense_prediction.get("estimated_expense_total")
            else expected_income * average_expense_ratio
        )
        remaining_expense = _money(
            Decimal(expense_prediction["estimated_remaining_expense"])
            if expense_prediction and expense_prediction.get("estimated_remaining_expense")
            else max(estimated_expense_total - expense_total, Decimal("0"))
        )

        if receivable > 0:
            _add_cash_item(
                bucket,
                {
                    "type": "expected_project_income",
                    "kind": FinanceCategory.Type.INCOME,
                    "date": due_date.isoformat(),
                    "amount": receivable,
                    "title": "Ожидаемая оплата клиента",
                    "project": project.id,
                    "project_title": _project_label(project),
                    "comment": "Расчет по сумме проекта и уже внесенным доходам.",
                },
            )

        if remaining_expense > 0:
            missing_required = [
                item["label"]
                for item in (expense_prediction or {}).get("required_expense_forecast", [])
                if Decimal(item.get("remaining") or "0") > 0
            ][:4]
            _add_cash_item(
                bucket,
                {
                    "type": "expected_project_expense",
                    "kind": FinanceCategory.Type.EXPENSE,
                    "date": due_date.isoformat(),
                    "amount": remaining_expense,
                    "title": "Прогноз остатка расходников",
                    "project": project.id,
                    "project_title": _project_label(project),
                    "comment": (
                        (expense_prediction or {}).get("message")
                        or f"Средняя доля расходов по завершённым проектам: {_percent_string(average_expense_ratio * Decimal('100'))}%."
                    ),
                    "missing_required_expenses": missing_required,
                },
            )

        project_rows.append(
            {
                "id": project.id,
                "title": _project_label(project),
                "status": project.status,
                "expected_income": _decimal_string(expected_income),
                "income_paid": _decimal_string(income_paid),
                "receivable": _decimal_string(receivable),
                "expense_total": _decimal_string(expense_total),
                "estimated_expense_total": _decimal_string(estimated_expense_total),
                "estimated_remaining_expense": _decimal_string(remaining_expense),
                "expense_prediction": expense_prediction,
                "forecast_date": due_date.isoformat(),
            }
        )

    cumulative = _money(current_balance)
    cash_gap_bucket = None
    bucket_rows = []
    for key in ("today", "week", "month", "sixty_days"):
        bucket = buckets[key]
        cumulative = _money(cumulative + Decimal(bucket["net"]))
        if cumulative < 0 and not cash_gap_bucket:
            cash_gap_bucket = key
        bucket_rows.append({**bucket, "projected_balance": _decimal_string(cumulative)})

    total_income = sum((Decimal(bucket["income"]) for bucket in bucket_rows), Decimal("0"))
    total_expense = sum((Decimal(bucket["expense"]) for bucket in bucket_rows), Decimal("0"))

    return {
        "generated_at": now.isoformat(),
        "current_balance": _decimal_string(current_balance),
        "forecast_income": _decimal_string(total_income),
        "forecast_expense": _decimal_string(total_expense),
        "forecast_net": _decimal_string(total_income - total_expense),
        "projected_balance_60_days": _decimal_string(cumulative),
        "average_expense_percent": _percent_string(average_expense_ratio * Decimal("100")),
        "cash_gap_bucket": cash_gap_bucket,
        "buckets": bucket_rows,
        "projects": project_rows[:30],
        "planned_operation_count": len(future_payment_ids),
    }


def compact_cash_forecast_for_ai(forecast):
    return {
        "current_balance": forecast.get("current_balance"),
        "forecast_income": forecast.get("forecast_income"),
        "forecast_expense": forecast.get("forecast_expense"),
        "forecast_net": forecast.get("forecast_net"),
        "projected_balance_60_days": forecast.get("projected_balance_60_days"),
        "average_expense_percent": forecast.get("average_expense_percent"),
        "cash_gap_bucket": forecast.get("cash_gap_bucket"),
        "buckets": [
            {
                "label": bucket.get("label"),
                "income": bucket.get("income"),
                "expense": bucket.get("expense"),
                "net": bucket.get("net"),
                "projected_balance": bucket.get("projected_balance"),
                "items": (bucket.get("items") or [])[:8],
            }
            for bucket in (forecast.get("buckets") or [])
        ],
        "projects": (forecast.get("projects") or [])[:12],
    }
