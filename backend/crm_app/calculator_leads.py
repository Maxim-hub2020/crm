"""Link accepted calculator archive revisions to tenant-scoped CRM requests."""

import hashlib
from decimal import Decimal, InvalidOperation, ROUND_CEILING

from django.db import transaction

from .models import CalculatorLead, CalculatorQuote
from .phones import normalize_russian_phone


def _dict(value):
    return value if isinstance(value, dict) else {}


def _money(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        amount = Decimal(str(value))
        if amount.is_finite() and 0 <= amount < Decimal("10000000000"):
            return amount.quantize(Decimal("0.01"))
    except InvalidOperation:
        pass
    return None


def _round_up_hundred(value):
    return (value / 100).to_integral_value(rounding=ROUND_CEILING) * 100


def quote_summary(payload):
    items = payload.get("items")
    items = [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []
    items = items or [payload]
    lines = []
    for item in items:
        quantity = _money(item.get("quantity")) or Decimal(1)
        quantity = min(999, max(1, int(quantity)))
        lines.append({
            "id": str(item.get("id") or ""),
            "title": str(item.get("positionName") or item.get("mirrorTitle") or item.get("constructionTitle") or "Изделие")[:300],
            "quantity": quantity,
            "amount": str((_money(_dict(item.get("result")).get("total")) or Decimal(0)) * quantity),
        })
    variants = payload.get("variants")
    variants = [v for v in variants if isinstance(v, dict) and isinstance(v.get("itemIds"), list)] if isinstance(variants, list) and len(variants) >= 2 else []
    totals = []
    for variant in variants:
        total = _money(variant.get("manualTotal"))
        if total is not None:
            total = _round_up_hundred(total)
        else:
            total = sum((Decimal(line["amount"]) for line in lines if line["id"] in variant["itemIds"]), Decimal(0))
            if _dict(variant.get("orderDelivery")).get("enabled"):
                total += _round_up_hundred(_money(variant.get("deliveryPrice")) or Decimal(0))
        totals.append(total)
    total = min(totals) if totals else _money(payload.get("manualTotal"))
    if total is None:
        total = _money(_dict(payload.get("result")).get("total"))
    kinds = {item.get("kind", "shower") for item in items if isinstance(item.get("kind", "shower"), str)}
    product = next(iter(kinds)) if len(kinds) == 1 else "mixed"
    return _money(total), {"items": lines, "amount_is_from": bool(totals), "product": product}


def sync_quote_lead(quote):
    """Caller holds the quote row lock; never overwrite the manager's workflow fields."""
    if quote.lead_deleted:
        return None
    payload = _dict(quote.payload)
    customer = _dict(payload.get("customer") if payload.get("customer") is not None else payload.get("form"))
    name = str(customer.get("clientName") or customer.get("name") or "").strip()[:200]
    phone = str(customer.get("clientPhone") or "").strip()[:50]
    if not (name or phone):
        return None
    amount, configuration = quote_summary(payload)
    if amount is None:
        return None
    configuration["customer_note"] = str(customer.get("note") or "")[:5000]
    # Public-site requests predate this link. Attach them instead of duplicating them.
    lead = CalculatorLead.objects.filter(quote=quote).first()
    if lead is None and quote.quote_id.startswith("public-"):
        lead = CalculatorLead.objects.filter(
            workspace_id=quote.workspace_id, calculation_id=quote.quote_id.removeprefix("public-"),
        ).first()
    if lead is None:
        identity = hashlib.sha256(f"{quote.workspace_id}:{quote.quote_id}".encode()).hexdigest()
        lead = CalculatorLead.objects.filter(workspace_id=quote.workspace_id, calculation_id=identity).first()
        if lead is None:
            lead = CalculatorLead(workspace_id=quote.workspace_id, calculation_id=identity,
                                  source_url="https://calc.cehcrm.ru/", price_version="")
    lead.quote = quote
    lead.client_name = name or "Клиент без имени"
    lead.client_phone = normalize_russian_phone(phone, strict=False)
    lead.amount = amount
    lead.product = configuration["product"][:20]
    lead.configuration = {**_dict(lead.configuration), **configuration}
    lead.save()
    return lead


@transaction.atomic
def delete_lead(lead):
    # Keep only a quote-id tombstone so offline calculator sync cannot restore PII.
    quotes = CalculatorQuote.objects.select_for_update().filter(workspace_id=lead.workspace_id)
    quote = quotes.filter(pk=lead.quote_id).first() if lead.quote_id else quotes.filter(quote_id=f"public-{lead.calculation_id}").first()
    if quote:
        quote.lead_deleted = True
        quote.payload = {}
        quote.number = ""
        quote.save(update_fields=["lead_deleted", "payload", "number", "updated_at"])
    lead.delete()
