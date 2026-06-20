import re
from decimal import Decimal, ROUND_HALF_UP

from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from .models import Client, ClientBonusTransaction, FinanceCategory, Payment, Project

BONUS_ORDER_THRESHOLD = Decimal("50000")
BONUS_RATE = Decimal("0.03")
MONEY_QUANT = Decimal("0.01")


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
    return Decimal(value or 0).quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)


def _has_advance_payment(project):
    category_names = Payment.objects.filter(
        project=project,
        category__type=FinanceCategory.Type.INCOME,
    ).values_list("category__name", flat=True)
    return any("аванс" in str(name or "").casefold() or "предоплат" in str(name or "").casefold() for name in category_names)


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


def ensure_project_bonus_accrual(project, actor=None):
    with transaction.atomic():
        project = Project.objects.select_for_update().select_related("client", "workspace").get(pk=project.pk)
        total_amount = _money(project.total_amount)

        if project.bonus_accrued_at or project.bonus_accrued_amount:
            return None
        if not project.client_id or total_amount <= BONUS_ORDER_THRESHOLD:
            return None
        if not _has_advance_payment(project):
            return None

        bonus_amount = _money(total_amount * BONUS_RATE)
        transaction_row = _change_bonus_balance(
            client=project.client,
            amount=bonus_amount,
            transaction_type=ClientBonusTransaction.Type.ACCRUAL,
            project=project,
            actor=actor,
            comment=f"Начисление 3% после аванса по проекту №{project.order_number or project.id}.",
        )

        project.bonus_accrued_amount = bonus_amount
        project.bonus_accrued_at = timezone.now()
        project.save(update_fields=["bonus_accrued_amount", "bonus_accrued_at", "updated_at"])
        return transaction_row


def apply_project_bonus_promo_code(project, actor=None):
    code = normalize_bonus_promo_code(project.bonus_promo_code)
    if not code:
        return None

    with transaction.atomic():
        project = Project.objects.select_for_update().select_related("client", "workspace", "referred_by_client").get(pk=project.pk)
        if project.referral_bonus_used and project.referred_by_client_id:
            return None
        if not project.client_id:
            raise ValidationError({"bonus_promo_code": "Сначала укажите клиента проекта."})

        candidates = [
            client
            for client in Client.objects.filter(workspace=project.workspace).exclude(pk=project.client_id)
            if promo_code_for_phone(client.phone) == code
        ]
        if not candidates:
            raise ValidationError({"bonus_promo_code": "Клиент с таким промокодом не найден."})
        if len(candidates) > 1:
            raise ValidationError({"bonus_promo_code": "Найдено несколько клиентов с таким промокодом. Уточните телефон."})

        referrer = Client.objects.select_for_update().get(pk=candidates[0].pk)
        available_bonus = _money(referrer.bonus_balance)
        if available_bonus <= 0:
            raise ValidationError({"bonus_promo_code": "У клиента-рекомендателя нет доступных бонусов."})

        project_limit = _money(project.total_amount) if project.total_amount else available_bonus
        transfer_amount = min(available_bonus, project_limit)
        if transfer_amount <= 0:
            raise ValidationError({"bonus_promo_code": "Укажите сумму проекта, чтобы применить бонусы."})

        _change_bonus_balance(
            client=referrer,
            amount=-transfer_amount,
            transaction_type=ClientBonusTransaction.Type.PROMO_DEBIT,
            project=project,
            related_client=project.client,
            promo_code=code,
            actor=actor,
            comment=f"Списание по промокоду для проекта №{project.order_number or project.id}.",
        )
        credit_transaction = _change_bonus_balance(
            client=project.client,
            amount=transfer_amount,
            transaction_type=ClientBonusTransaction.Type.PROMO_CREDIT,
            project=project,
            related_client=referrer,
            promo_code=code,
            actor=actor,
            comment=f"Зачисление по промокоду клиента {referrer.name}.",
        )

        project.referred_by_client = referrer
        project.referral_bonus_used = transfer_amount
        project.bonus_promo_code = code
        project.save(update_fields=["referred_by_client", "referral_bonus_used", "bonus_promo_code", "updated_at"])
        return credit_transaction
