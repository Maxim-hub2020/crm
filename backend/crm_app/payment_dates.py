from datetime import datetime, time, timedelta

from django.utils import timezone


def payment_local_date(paid_at):
    if not paid_at:
        return None
    if timezone.is_aware(paid_at):
        paid_at = timezone.localtime(paid_at)
    return paid_at.date()


def payment_is_future(paid_at, today=None):
    paid_date = payment_local_date(paid_at)
    return bool(paid_date and paid_date > (today or timezone.localdate()))


def start_of_next_local_day(today=None):
    next_day = (today or timezone.localdate()) + timedelta(days=1)
    return timezone.make_aware(
        datetime.combine(next_day, time.min),
        timezone.get_current_timezone(),
    )
