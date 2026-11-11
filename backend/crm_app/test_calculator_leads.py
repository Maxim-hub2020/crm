from copy import deepcopy
from decimal import Decimal
from unittest.mock import patch

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

    def create_project(self):
        return Project.objects.create(
            workspace=self.workspace, manager=self.user, title="Проект после замера",
            client_name="Андрей", status="applications", total_amount=100,
        )

    def link_quote(self, project):
        response = self.client.post(
            f"/api/projects/{project.pk}/calculator-quote/",
            {"quote_id": self.quote["id"]}, format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        return response

    def test_saved_quote_stays_in_archive_without_creating_project_or_client(self):
        response = self.sync()
        self.assertEqual(response.data["quotes"][0]["id"], self.quote["id"])
        self.assertIsNone(CalculatorQuote.objects.get().project_id)
        self.assertFalse(Project.objects.exists())
        self.assertFalse(Client.objects.exists())
        self.assertFalse(CalculatorLead.objects.exists())

    def test_repeat_and_new_revision_update_same_project(self):
        project = self.create_project()
        self.sync()
        self.link_quote(project)
        self.sync()
        updated = deepcopy(self.quote)
        updated.update(updatedAt="2026-09-02T10:00:00Z", manualTotal=75500)
        self.sync(updated)
        self.assertEqual(Project.objects.count(), 1)
        project.refresh_from_db()
        self.assertEqual(project.total_amount, Decimal("75500"))
        self.assertEqual(project.title, "Проект после замера")
        self.assertEqual(project.client_name, "Андрей")
        self.assertIsNone(project.client_id)

    def test_unchanged_quote_sync_preserves_project_amount(self):
        project = self.create_project()
        self.sync()
        self.link_quote(project)
        Project.objects.filter(pk=project.pk).update(total_amount=Decimal("90000"))
        self.sync()
        project.refresh_from_db()
        self.assertEqual(project.total_amount, Decimal("90000"))

    def test_project_exposes_direct_link_to_linked_quote(self):
        project = self.create_project()
        self.sync()
        self.link_quote(project)
        response = self.client.get(f"/api/projects/{project.pk}/")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["calculator_quote_info"]["id"], self.quote["id"])
        self.assertEqual(response.data["calculator_quote_info"]["number"], self.quote["number"])
        self.assertEqual(
            response.data["calculator_quote_info"]["url"],
            "https://calc.cehcrm.ru/?quote=saved-quote-1",
        )

    def test_existing_project_can_pull_quote_and_quote_total(self):
        client = Client.objects.create(workspace=self.workspace, name="Существующий", phone="+7-914-070-70-07")
        target = Project.objects.create(
            workspace=self.workspace,
            manager=self.user,
            client=client,
            client_name=client.name,
            client_phone=client.phone,
            title="Проект после замера",
            object_address="г Ростов-на-Дону, ул Тестовая, д 10",
            apartment="15",
            floor="3",
            status="applications",
            total_amount=100,
        )

        self.sync()
        self.assertEqual(Project.objects.count(), 1)
        self.assertIsNone(CalculatorQuote.objects.get().project_id)
        response = self.link_quote(target)

        self.assertEqual(response.status_code, 200, response.data)
        target.refresh_from_db()
        quote = CalculatorQuote.objects.get(quote_id=self.quote["id"])
        self.assertEqual(quote.project, target)
        self.assertEqual(target.total_amount, Decimal("81000"))
        self.assertEqual(target.object_address, "г Ростов-на-Дону, ул Тестовая, д 10")
        self.assertEqual(target.apartment, "15")
        self.assertIsNone(response.data["moved_from_project_id"])
        self.assertEqual(response.data["project"]["calculator_quote_info"]["number"], "1001")

    def test_project_can_unlink_quote_without_deleting_archive(self):
        project = self.create_project()
        self.sync()
        self.link_quote(project)

        response = self.client.delete(f"/api/projects/{project.pk}/calculator-quote/")

        self.assertEqual(response.status_code, 200, response.data)
        quote = CalculatorQuote.objects.get(quote_id=self.quote["id"])
        self.assertIsNone(quote.project)
        self.assertTrue(quote.project_sync_disabled)
        self.assertEqual(response.data["project"]["calculator_quote_info"], None)
        self.quote.update(updatedAt="2026-09-02T10:00:00Z", manualTotal=75500)
        self.sync()
        quote.refresh_from_db()
        project.refresh_from_db()
        self.assertIsNone(quote.project_id)
        self.assertEqual(project.total_amount, Decimal("81000"))

    def test_stale_revision_does_not_change_project(self):
        self.sync()
        self.link_quote(self.create_project())
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

    def test_deleting_linked_project_keeps_quote_archive_and_prevents_resurrection(self):
        project = self.create_project()
        self.sync()
        self.link_quote(project)
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
        project = self.create_project()
        self.sync()
        self.link_quote(project)
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
