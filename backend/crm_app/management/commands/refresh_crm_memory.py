import time

from django.core.management.base import BaseCommand

from crm_app.ai_assistant import CRMAssistantService
from crm_app.models import CRMMemorySnapshot, User


class Command(BaseCommand):
    help = "Refresh cached CRM snapshots used by the AI assistant."

    def add_arguments(self, parser):
        parser.add_argument(
            "--force",
            action="store_true",
            help="Rebuild snapshots even if they are still inside the configured TTL.",
        )
        parser.add_argument(
            "--interval",
            type=int,
            default=0,
            help="Repeat refresh every N seconds. Use 0 for one-shot mode.",
        )

    def handle(self, *args, **options):
        interval = max(0, int(options["interval"] or 0))

        while True:
            self.refresh_snapshots(force=options["force"])
            if not interval:
                break
            time.sleep(interval)

    def refresh_snapshots(self, force=False):
        users = User.objects.filter(is_active=True).order_by("id")
        refreshed = 0

        for user in users:
            if force:
                CRMMemorySnapshot.objects.filter(owner=user).delete()

            service = CRMAssistantService(user, init_gemini_client=False)
            if service.memory_snapshot:
                refreshed += 1
                self.stdout.write(f"Refreshed CRM memory for user #{user.id} {user.username}")

        self.stdout.write(self.style.SUCCESS(f"CRM memory refresh complete: {refreshed} snapshot(s)."))
