from django.core.management.base import BaseCommand

from crm_app.models import Client, Project
from crm_app.phones import normalize_russian_phone


class Command(BaseCommand):
    help = "Normalize client and project phone numbers to +7-999-123-45-67."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="Show counts without writing changes.")

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        client_updates = 0
        project_updates = 0

        skipped_client_conflicts = 0

        for client in Client.objects.exclude(phone="").only("id", "workspace_id", "phone").iterator():
            normalized = normalize_russian_phone(client.phone, strict=False)
            if normalized != client.phone:
                if Client.objects.exclude(pk=client.pk).filter(workspace_id=client.workspace_id, phone=normalized).exists():
                    skipped_client_conflicts += 1
                    continue
                client_updates += 1
                if not dry_run:
                    Client.objects.filter(pk=client.pk).update(phone=normalized)

        for project in Project.objects.exclude(client_phone="").only("id", "client_phone").iterator():
            normalized = normalize_russian_phone(project.client_phone, strict=False)
            if normalized != project.client_phone:
                project_updates += 1
                if not dry_run:
                    Project.objects.filter(pk=project.pk).update(client_phone=normalized)

        mode = "would update" if dry_run else "updated"
        self.stdout.write(
            self.style.SUCCESS(
                f"Phones normalized: clients {mode}={client_updates}, projects {mode}={project_updates}, "
                f"client_conflicts_skipped={skipped_client_conflicts}"
            )
        )
