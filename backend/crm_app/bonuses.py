import re
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from django.db import transaction
from django.db.models import Sum
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from .models import Client, ClientBonusTransaction, FinanceCategory, Payment, Project

BONUS_ORDER_THRESHOLD = Decimal("30000")
BONUS_RATE = Decimal("0.03")
BONUS_REDEMPTION_RATE = Decimal("0.10")
MONEY_QUANT = Decimal("0.01")
ADVANCE_KEYWORDS = ("аванс", "предоплат")
ADVANCE_NEGATIVE_KEYWORDS = ("возврат", "вернул", "вернули", "отмена", "refund")


def normalize_bonus_promo_code(value):
    raw_value = str(value or "").strip()
    if not raw_value:
        return ""

    digits = re.sub(r"\D", "", raw_value)
    if len(digits) != 5:
        raise ValidationError({"bonus_promo_code": "Промокод должен состоять из последних 5 цифр телефона."})
    return digits


def promo_code_for_phone(phone):
    digits = re.sub(r"\D", "", str(phone or ""))
    return digits[-5:] if len(digits) >= 5 else ""


def _money(value):
    if isinstance(value, str):
        value = value.strip().replace(" ", "").replace(",", ".")
    try:
        return Decimal(value or 0).quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)
    except (InvalidOperation, TypeError, ValueError):
        raise ValidationError({"total_amount": "Укажите корректную сумму проекта."})


def preview_project_bonus_promo_code(*, workspace, promo_code, total_amount, exclude_client_id=None, exclude_phone=""):
    code = normalize_bonus_promo_code(promo_code)
    project_total = _money(total_amount)
    if project_total <= 0:
        raise ValidationError({"bonus_promo_code": "Укажите сумму проекта, чтобы проверить промокод."})

    if exclude_phone and promo_code_for_phone(exclude_phone) == code:
        raise ValidationError({"bonus_promo_code": "Нельзя использовать промокод этого же клиента."})

    queryset = Client.objects.filter(workspace=workspace)
    if exclude_client_id:
        queryset = queryset.exclude(pk=exclude_client_id)

    candidates = [client for client in queryset if promo_code_for_phone(client.phone) == code]
    if not candidates:
        raise ValidationError({"bonus_promo_code": "Клиент с таким промокодом не найден."})
    if len(candidates) > 1:
        raise ValidationError({"bonus_promo_code": "Найдено несколько клиентов с таким промокодом. Уточните телефон."})

    referrer = candidates[0]
    available_bonus = _money(referrer.bonus_balance)
    if available_bonus <= 0:
        raise ValidationError({"bonus_promo_code": "На этом промокоде нет бонусов для списания."})

    max_redeem_amount = _money(project_total * BONUS_REDEMPTION_RATE)
    redeem_amount = min(available_bonus, max_redeem_amount)
    if redeem_amount <= 0:
        raise ValidationError({"bonus_promo_code": "Бонусами можно покрыть до 10% стоимости проекта."})

    discounted_total = max(Decimal("0.00"), _money(project_total - redeem_amount))
    return {
        "ok": True,
        "promo_code": code,
        "referrer_client_id": referrer.id,
        "referrer_name": referrer.name,
        "available_bonus": str(available_bonus),
        "max_redeem_amount": str(max_redeem_amount),
        "redeem_amount": str(redeem_amount),
        "original_total_amount": str(project_total),
        "discounted_total_amount": str(discounted_total),
    }


def _has_advance_text(*values):
    text = " ".join(str(value or "") for value in values).casefold()
    if not any(keyword in text for keyword in ADVANCE_KEYWORDS):
        return False
    return not _has_negative_advance_text(text)


def _has_negative_advance_text(*values):
    text = " ".join(str(value or "") for value in values).casefold()
    return any(keyword in text for keyword in ADVANCE_NEGATIVE_KEYWORDS)


def _is_bonus_advance_payment(payment):
    category = payment.category
    category_name = category.name if category else ""
    if _has_negative_advance_text(category_name, payment.comment):
        return False

    if _has_advance_text(category_name, payment.comment):
        return True
    if category and category.type == FinanceCategory.Type.INCOME:
        return True
    return payment.type == Payment.Type.ADVANCE


def _has_advance_payment(project):
    payments = (
        Payment.objects.select_related("category")
        .filter(project=project, amount__gt=0, paid_at__lte=timezone.now())
        .order_by("id")
    )
    return any(_is_bonus_advance_payment(payment) for payment in payments)


def _change_bonus_balance(*, client, amount, transaction_type, project=None, related_client=None, promo_code="", actor=None, comment=""):
    client = Client.objects.select_for_update().get(pk=client.pk)
    amount = _money(amount)
    next_balance = _money(client.bonus_balance) + amount

    if next_balance < 0:
        raise ValidationError({"bonus_promo_code": "На бонусном счете клиента недостаточно бонусов."})

    client.bonus_balance = next_balance
    client.save(update_fields=["bonus_balance", "updated_at"])

    return ClientBonusTransaction.objects.create(
        workspace=client.workspace,
        client=client,
        project=project,
        related_client=related_client,
        created_by=actor if getattr(actor, "is_authenticated", False) else None,
        type=transaction_type,
        amount=amount,
        balance_after=next_balance,
        promo_code=promo_code,
        comment=comment,
    )


def _bonus_accrual_totals_by_client(project):
    rows = (
        ClientBonusTransaction.objects.filter(
            project=project,
            type__in=[
                ClientBonusTransaction.Type.ACCRUAL,
                ClientBonusTransaction.Type.ACCRUAL_REVERSAL,
            ],
        )
        .values("client")
        .annotate(total=Sum("amount"))
    )
    return {row["client"]: _money(row["total"] or 0) for row in rows if row["client"]}


def ensure_project_bonus_accrual(project, actor=None):
    with transaction.atomic():
        project = Project.objects.select_for_update().select_related("client").get(pk=project.pk)
        total_amount = _money(project.total_amount)

        target_bonus = Decimal("0.00")
        target_by_client = {}
        if project.client_id and total_amount >= BONUS_ORDER_THRESHOLD and _has_advance_payment(project):
            target_bonus = _money(total_amount * BONUS_RATE)
            target_by_client[project.client_id] = target_bonus

        current_by_client = _bonus_accrual_totals_by_client(project)
        if project.client_id:
            current_by_client.setdefault(project.client_id, Decimal("0.00"))

        changed_rows = []
        project_label = project.order_number or project.id
        for client_id in sorted(set(current_by_client) | set(target_by_client)):
            current_amount = _money(current_by_client.get(client_id, 0))
            desired_amount = _money(target_by_client.get(client_id, 0))
            delta = _money(desired_amount - current_amount)
            if delta == 0:
                continue

            client = Client.objects.select_for_update().get(pk=client_id)
            if delta > 0:
                transaction_type = ClientBonusTransaction.Type.ACCRUAL
                comment = (
                    f"Начисление 3% после аванса по проекту №{project_label}."
                    if current_amount <= 0
                    else f"Корректировка бонусов до 3% по проекту №{project_label}."
                )
            else:
                transaction_type = ClientBonusTransaction.Type.ACCRUAL_REVERSAL
                comment = f"Сторно бонусов по проекту №{project_label}."

            changed_rows.append(
                _change_bonus_balance(
                    client=client,
                    amount=delta,
                    transaction_type=transaction_type,
                    project=project,
                    actor=actor,
                    comment=comment,
                )
            )

        project.bonus_accrued_amount = target_bonus
        project.bonus_accrued_at = project.bonus_accrued_at if target_bonus > 0 else None
        if target_bonus > 0 and not project.bonus_accrued_at:
            project.bonus_accrued_at = timezone.now()
        project.save(update_fields=["bonus_accrued_amount", "bonus_accrued_at", "updated_at"])
        return changed_rows


def apply_project_bonus_promo_code(project, actor=None):
    code = normalize_bonus_promo_code(project.bonus_promo_code)
    if not code:
        return None

    with transaction.atomic():
        project = Project.objects.select_for_update().get(pk=project.pk)
        if project.referral_bonus_used and project.referred_by_client_id:
            return None
        if not project.client_id:
            raise ValidationError({"bonus_promo_code": "Сначала укажите клиента проекта."})

        preview = preview_project_bonus_promo_code(
            workspace=project.workspace,
            promo_code=code,
            total_amount=project.total_amount,
            exclude_client_id=project.client_id,
            exclude_phone=project.client.phone if project.client else "",
        )

        referrer = Client.objects.select_for_update().get(pk=preview["referrer_client_id"])
        available_bonus = _money(referrer.bonus_balance)
        transfer_amount = min(available_bonus, _money(preview["redeem_amount"]))
        if transfer_amount <= 0:
            raise ValidationError({"bonus_promo_code": "Бонусами можно покрыть до 10% стоимости проекта."})

        debit_transaction = _change_bonus_balance(
            client=referrer,
            amount=-transfer_amount,
            transaction_type=ClientBonusTransaction.Type.PROMO_DEBIT,
            project=project,
            related_client=project.client,
            promo_code=code,
            actor=actor,
            comment=f"Списание по промокоду для проекта №{project.order_number or project.id}.",
        )

        project.referred_by_client = referrer
        project.referral_bonus_used = transfer_amount
        project.bonus_promo_code = code
        project.save(update_fields=["referred_by_client", "referral_bonus_used", "bonus_promo_code", "updated_at"])
        return debit_transaction


def _bonus_transactions_sum(*, project, transaction_type, client=None):
    queryset = ClientBonusTransaction.objects.filter(project=project, type=transaction_type)
    if client is not None:
        queryset = queryset.filter(client=client)
    return _money(queryset.aggregate(total=Sum("amount")).get("total") or 0)


def reverse_project_bonus_effects(project, actor=None):
    with transaction.atomic():
        project = Project.objects.select_for_update().select_related("client", "referred_by_client").get(pk=project.pk)
        if Payment.objects.filter(project=project).exists():
            raise ValidationError({"project": "Нельзя удалить проект с финансовыми операциями. Сначала удалите операции проекта."})

        promo_code = project.bonus_promo_code or ""
        project_label = project.order_number or project.id

        if project.client_id:
            legacy_promo_credit = _bonus_transactions_sum(
                project=project,
                transaction_type=ClientBonusTransaction.Type.PROMO_CREDIT,
                client=project.client,
            )
            legacy_promo_credit_reversal = _bonus_transactions_sum(
                project=project,
                transaction_type=ClientBonusTransaction.Type.PROMO_CREDIT_REVERSAL,
                client=project.client,
            )
            legacy_credit_to_reverse = _money(legacy_promo_credit + legacy_promo_credit_reversal)
            if legacy_credit_to_reverse > 0:
                _change_bonus_balance(
                    client=project.client,
                    amount=-legacy_credit_to_reverse,
                    transaction_type=ClientBonusTransaction.Type.PROMO_CREDIT_REVERSAL,
                    project=project,
                    related_client=project.referred_by_client,
                    promo_code=promo_code,
                    actor=actor,
                    comment=f"Сторно старого зачисления по промокоду при удалении проекта №{project_label}.",
                )

        accrual_totals = _bonus_accrual_totals_by_client(project)
        if not accrual_totals and project.client_id and project.bonus_accrued_amount:
            accrual_totals[project.client_id] = _money(project.bonus_accrued_amount)
        for client_id, net_amount in accrual_totals.items():
            if net_amount <= 0:
                continue
            accrual_client = Client.objects.select_for_update().get(pk=client_id)
            _change_bonus_balance(
                client=accrual_client,
                amount=-net_amount,
                transaction_type=ClientBonusTransaction.Type.ACCRUAL_REVERSAL,
                project=project,
                related_client=project.referred_by_client,
                promo_code=promo_code,
                actor=actor,
                comment=f"Сторно начисления 3% при удалении проекта №{project_label}.",
            )
        if project.bonus_accrued_amount or accrual_totals:
            project.bonus_accrued_amount = Decimal("0.00")
            project.bonus_accrued_at = None

        if project.referred_by_client_id and project.referral_bonus_used:
            _change_bonus_balance(
                client=project.referred_by_client,
                amount=project.referral_bonus_used,
                transaction_type=ClientBonusTransaction.Type.PROMO_REFUND,
                project=project,
                related_client=project.client,
                promo_code=promo_code,
                actor=actor,
                comment=f"Возврат списания по промокоду при удалении проекта №{project_label}.",
            )
            project.referral_bonus_used = Decimal("0.00")
            project.referred_by_client = None

        project.save(update_fields=["referral_bonus_used", "referred_by_client", "bonus_accrued_amount", "bonus_accrued_at", "updated_at"])
