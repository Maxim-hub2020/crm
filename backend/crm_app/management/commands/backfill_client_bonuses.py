import re

from django.core.management.base import BaseCommand
from django.db.models import Q

from crm_app.bonuses import ensure_project_bonus_accrual
from crm_app.models import Project


class Command(BaseCommand):
    help = "Backfill and reconcile client bonus accruals for existing projects with advance payments."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Only count projects that are candidates for bonus accruals.",
        )
        parser.add_argument("--client-name", help="Only reconcile projects for clients whose name contains this value.")
        parser.add_argument("--client-id", type=int, help="Only reconcile projects for this client id.")
        parser.add_argument("--client-phone", help="Only reconcile projects for a client phone. Digits are matched.")
        parser.add_argument("--project-id", type=int, action="append", help="Only reconcile one project id. Can be passed multiple times.")

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        client_name = str(options.get("client_name") or "").strip()
        client_id = options.get("client_id")
        client_phone = re.sub(r"\D", "", str(options.get("client_phone") or ""))
        project_ids = options.get("project_id") or []

        queryset = (
            Project.objects.select_related("client", "workspace")
            .filter(
                Q(client__isnull=False, total_amount__gt=50000)
                | Q(bonus_accrued_amount__gt=0)
                | Q(bonus_accrued_at__isnull=False)
            )
            .order_by("id")
        )
        if client_name:
            queryset = queryset.filter(client__name__icontains=client_name)
        if client_id:
            queryset = queryset.filter(client_id=client_id)
        if project_ids:
            queryset = queryset.filter(id__in=project_ids)
        if client_phone:
            matching_project_ids = [
                project.id
                for project in queryset
                if client_phone in re.sub(r"\D", "", project.client.phone if project.client else "")
            ]
            queryset = queryset.filter(id__in=matching_project_ids)

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
            self.stdout.write(self.style.WARNING(f"Found {checked_count} candidate projects. Run without --dry-run to reconcile matching bonuses."))
            return

        self.stdout.write(self.style.SUCCESS(f"Checked {checked_count} projects, changed bonuses for {accrued_count}."))
