from copy import deepcopy
from decimal import Decimal
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from rest_framework.test import APITestCase

from .models import CalculatorLead, CalculatorQuote, Client, Project, ProjectStatus, User, Workspace


class CalculatorQuoteProjectTests(APITestCase):
    def setUp(self):
        self.workspace = Workspace.objects.create(name="Calculator team", slug="calculator-team")
        self.user = User.objects.create_user(username="calc-admin", role="admin", workspace=self.workspace)
        ProjectStatus.objects.create(
            workspace=self.workspace, code="applications", name="Заявки", sort_order=10, is_default=True,
        )
        self.client.force_authenticate(self.user)
        self.quote = {
            "id": "saved-quote-1", "number": "1001", "createdAt": "2026-09-01T10:00:00Z",
            "updatedAt": "2026-09-01T10:00:00Z", "kind": "shower",
            "customer": {"clientName": "Максим", "clientPhone": "89140707007", "note": "Позвонить"},
            "result": {"total": 81000},
            "items": [{"id": "item-1", "kind": "shower", "constructionTitle": "Душевая",
                       "quantity": 2, "result": {"total": 40000}}],
        }

    def sync(self, quote=None):
        response = self.client.post("/api/calculator-quotes/", {"quotes": [quote or self.quote]}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        return response

    def test_saved_quote_creates_project_in_applications_and_client(self):
        self.sync()
        project = Project.objects.select_related("client").get()
        quote = CalculatorQuote.objects.get()
        self.assertEqual(quote.project, project)
        self.assertEqual(project.status, "applications")
        self.assertEqual(project.manager, self.user)
        self.assertEqual(project.title, "Душевая")
        self.assertEqual(project.total_amount, Decimal("81000"))
        self.assertEqual(project.client_phone, "+7-914-070-70-07")
        self.assertEqual(project.client.phone, "+7-914-070-70-07")
        self.assertIn("КП калькулятора №1001", project.description)
        self.assertFalse(CalculatorLead.objects.exists())

    def test_repeat_and_new_revision_update_same_project(self):
        self.sync()
        project_id = Project.objects.get().pk
        self.sync()
        updated = deepcopy(self.quote)
        updated.update(updatedAt="2026-09-02T10:00:00Z", manualTotal=75500)
        self.sync(updated)
        self.assertEqual(Project.objects.count(), 1)
        project = Project.objects.get()
        self.assertEqual(project.pk, project_id)
        self.assertEqual(project.total_amount, Decimal("75500"))

    def test_stale_revision_does_not_change_project(self):
        self.sync()
        stale = deepcopy(self.quote)
        stale.update(updatedAt="2026-08-01T10:00:00Z", manualTotal=100)
        self.sync(stale)
        self.assertEqual(Project.objects.get().total_amount, Decimal("81000"))

    def test_contactless_or_invalid_total_quote_does_not_create_project(self):
        draft = deepcopy(self.quote)
        draft["customer"] = {}
        self.sync(draft)
        self.assertFalse(Project.objects.exists())
        invalid = deepcopy(self.quote)
        invalid.update(id="invalid", updatedAt="2026-09-02T10:00:00Z")
        invalid["result"]["total"] = "invalid"
        self.sync(invalid)
        self.assertFalse(Project.objects.exists())

    def test_existing_client_is_reused_by_phone(self):
        client = Client.objects.create(workspace=self.workspace, name="Существующий", phone="+7-914-070-70-07")
        self.sync()
        self.assertEqual(Project.objects.get().client, client)
        self.assertEqual(Client.objects.count(), 1)

    def test_existing_request_from_previous_version_is_removed(self):
        quote = CalculatorQuote.objects.create(
            workspace=self.workspace, quote_id=self.quote["id"], payload=self.quote,
            created_by=self.user, updated_by=self.user,
        )
        CalculatorLead.objects.create(
            workspace=self.workspace, quote=quote, calculation_id="legacy", client_name="Максим",
            client_phone="89140707007", product="shower", configuration={}, amount=81000, price_version="",
        )
        call_command("backfill_calculator_projects", stdout=StringIO())
        self.assertTrue(Project.objects.exists())
        self.assertFalse(CalculatorLead.objects.exists())

    def test_backfill_is_idempotent_and_isolated_by_workspace(self):
        CalculatorQuote.objects.create(
            workspace=self.workspace, quote_id=self.quote["id"], payload=self.quote,
            created_by=self.user, updated_by=self.user,
        )
        call_command("backfill_calculator_projects", stdout=StringIO())
        call_command("backfill_calculator_projects", stdout=StringIO())
        self.assertEqual(Project.objects.count(), 1)
        other = Workspace.objects.create(name="Other", slug="other")
        other_user = User.objects.create_user(username="other-admin", role="admin", workspace=other)
        ProjectStatus.objects.create(workspace=other, code="lead", name="Заявки", is_default=True)
        self.client.force_authenticate(other_user)
        self.sync()
        self.assertEqual(Project.objects.count(), 2)
        self.assertEqual(Project.objects.filter(workspace=other).get().status, "lead")

    def test_deleting_generated_project_keeps_quote_archive_and_prevents_resurrection(self):
        self.sync()
        project = Project.objects.get()
        response = self.client.delete(f"/api/projects/{project.pk}/")
        self.assertEqual(response.status_code, 204)
        quote = CalculatorQuote.objects.get()
        self.assertFalse(quote.lead_deleted)
        self.assertTrue(quote.project_sync_disabled)
        self.assertEqual(quote.payload, self.quote)
        archive = self.client.get("/api/calculator-quotes/")
        self.assertEqual(archive.status_code, 200)
        self.assertEqual(archive.data["quotes"][0]["id"], self.quote["id"])
        self.quote["updatedAt"] = "2026-09-03T10:00:00Z"
        self.sync()
        self.assertFalse(Project.objects.exists())

    @patch("crm_app.views.ensure_project_disk_folder")
    def test_disk_folder_is_created_only_after_project_leaves_applications(self, ensure_folder):
        next_status = ProjectStatus.objects.create(
            workspace=self.workspace, code="measurement", name="Замер", sort_order=20,
        )
        ProjectStatus.objects.create(
            workspace=self.workspace, code="completed", name="Завершён", sort_order=30,
        )
        self.sync()
        project = Project.objects.get()
        ensure_folder.assert_not_called()

        response = self.client.patch(
            f"/api/projects/{project.pk}/", {"status": next_status.code}, format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        ensure_folder.assert_called_once()

    def test_legacy_deleted_quote_can_be_restored_without_recreating_project(self):
        CalculatorQuote.objects.create(
            workspace=self.workspace,
            quote_id=self.quote["id"],
            lead_deleted=True,
            project_sync_disabled=True,
            payload={},
            created_by=self.user,
            updated_by=self.user,
        )
        self.sync()
        quote = CalculatorQuote.objects.get()
        self.assertFalse(quote.lead_deleted)
        self.assertEqual(quote.payload, self.quote)
        self.assertFalse(Project.objects.exists())

    def test_public_quote_still_uses_requests_module(self):
        public = deepcopy(self.quote)
        public["id"] = "public-public-token"
        lead = CalculatorLead.objects.create(
            workspace=self.workspace, calculation_id="public-token", client_name="Максим",
            client_phone="89140707007", product="shower", configuration={}, amount=81000, price_version="",
        )
        self.sync(public)
        lead.refresh_from_db()
        self.assertIsNotNone(lead.quote_id)
        self.assertFalse(Project.objects.exists())
