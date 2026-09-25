from django.core.management.base import BaseCommand
from django.db import transaction

from crm_app.calculator_leads import sync_quote_lead
from crm_app.models import CalculatorQuote


class Command(BaseCommand):
    help = "Create/update CRM requests from the existing calculator archive."

    def handle(self, *args, **options):
        count = 0
        for pk in CalculatorQuote.objects.filter(lead_deleted=False).values_list("pk", flat=True).iterator():
            with transaction.atomic():
                quote = CalculatorQuote.objects.select_for_update().get(pk=pk)
                count += sync_quote_lead(quote) is not None
        self.stdout.write(self.style.SUCCESS(f"Synchronized {count} calculator requests."))
