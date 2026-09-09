from django.core.management.base import BaseCommand
from django.db import transaction

from crm_app.calculator_leads import sync_quote_lead
from crm_app.models import CalculatorQuote


class Command(BaseCommand):
    help = "Create kanban projects from existing internal calculator quotes."

    def handle(self, *args, **options):
        created = 0
        skipped = 0
        quote_ids = CalculatorQuote.objects.filter(
            lead_deleted=False,
            project_sync_disabled=False,
            project__isnull=True,
        ).exclude(quote_id__startswith="public-").values_list("pk", flat=True)
        for quote_pk in quote_ids.iterator():
            with transaction.atomic():
                quote = CalculatorQuote.objects.select_for_update().get(pk=quote_pk)
                was_linked = bool(quote.project_id)
                destination = sync_quote_lead(quote)
                if destination and not was_linked:
                    created += 1
                else:
                    skipped += 1
        self.stdout.write(self.style.SUCCESS(f"Created {created} calculator projects; skipped {skipped}."))
