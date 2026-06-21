from django.core.management.base import BaseCommand

from crm_app.bonuses import ensure_project_bonus_accrual
from crm_app.models import Project


class Command(BaseCommand):
    help = "Backfill client bonus accruals for existing projects with advance payments."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Only count projects that are candidates for bonus accruals.",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        queryset = (
            Project.objects.select_related("client", "workspace")
            .filter(client__isnull=False, total_amount__gt=50000, bonus_accrued_at__isnull=True, bonus_accrued_amount=0)
            .order_by("id")
        )

        checked_count = 0
        accrued_count = 0
        for project in queryset.iterator():
            checked_count += 1
            if dry_run:
                continue

            transaction_row = ensure_project_bonus_accrual(project)
            if transaction_row:
                accrued_count += 1

        if dry_run:
            self.stdout.write(self.style.WARNING(f"Found {checked_count} candidate projects. Run without --dry-run to accrue matching bonuses."))
            return

        self.stdout.write(self.style.SUCCESS(f"Checked {checked_count} projects, accrued bonuses for {accrued_count}."))
