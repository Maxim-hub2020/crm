from decimal import Decimal, ROUND_HALF_UP
from django.db import transaction
from django.utils import timezone
from .models import Payment, Commission

RATE_LOW = Decimal("0.05")
RATE_HIGH = Decimal("0.08")
THRESHOLD = 3  # >3 => 8%

def month_start(dt):
    d = dt.date()
    return d.replace(day=1)

def next_month_start(month_start_date):
    y = month_start_date.year
    m = month_start_date.month
    if m == 12:
        return month_start_date.replace(year=y + 1, month=1, day=1)
    return month_start_date.replace(month=m + 1, day=1)

def money_round(x: Decimal) -> Decimal:
    return x.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

def is_first_advance_for_project_in_month(payment: Payment, period_month):
    start = timezone.make_aware(timezone.datetime.combine(period_month, timezone.datetime.min.time()))
    end = timezone.make_aware(timezone.datetime.combine(next_month_start(period_month), timezone.datetime.min.time()))
    return not Payment.objects.filter(
        project_id=payment.project_id,
        type=Payment.Type.ADVANCE,
        paid_at__gte=start,
        paid_at__lt=end,
    ).exclude(id=payment.id).exists()

def count_sales_for_manager_in_month(manager_id, period_month):
    return Commission.objects.filter(
        manager_id=manager_id,
        period_month=period_month,
        sale_number_in_month__gt=0,
        status__in=[Commission.Status.ACCRUED, Commission.Status.PAYABLE, Commission.Status.PAID],
    ).count()

@transaction.atomic
def create_commission_for_advance(payment: Payment) -> Commission | None:
    if payment.type != Payment.Type.ADVANCE:
        return None

    if hasattr(payment, "commission"):
        return payment.commission

    period = month_start(payment.paid_at)
    first_for_project_month = is_first_advance_for_project_in_month(payment, period)
    sale_number = 0

    if first_for_project_month:
        prev_sales = count_sales_for_manager_in_month(payment.project.manager_id, period)
        sale_number = prev_sales + 1
        rate = RATE_HIGH if sale_number > THRESHOLD else RATE_LOW
    else:
        prev_sales = count_sales_for_manager_in_month(payment.project.manager_id, period)
        rate = RATE_HIGH if prev_sales > THRESHOLD else RATE_LOW

    base = payment.amount
    comm_amount = money_round(base * rate)

    c = Commission.objects.create(
        payment=payment,
        project=payment.project,
        manager=payment.project.manager,
        period_month=period,
        base_amount=base,
        rate=rate,
        commission_amount=comm_amount,
        sale_number_in_month=sale_number,
        status=Commission.Status.ACCRUED,
    )
    return c
