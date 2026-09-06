from copy import deepcopy
from decimal import Decimal
from io import StringIO

from django.core.management import call_command
from django.core.cache import cache
from rest_framework.test import APITestCase

from .models import CalculatorLead, CalculatorQuote, User, Workspace, default_workspace


class CalculatorArchiveLeadTests(APITestCase):
    def setUp(self):
        self.workspace = Workspace.objects.create(name="Calculator team", slug="calculator-team")
        self.user = User.objects.create_user(username="calc-admin", role="admin", workspace=self.workspace)
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

    def test_saved_quote_creates_request_and_repeat_preserves_manager_fields(self):
        self.sync()
        lead = CalculatorLead.objects.get()
        self.assertEqual(lead.client_phone, "+7-914-070-70-07")
        self.assertEqual(lead.amount, Decimal("81000"))
        self.assertEqual(lead.configuration["items"][0]["amount"], "80000.00")
        response = self.client.patch(f"/api/calculator-leads/{lead.pk}/", {
            "status": "in_progress", "manager_note": "Перезвонить", "follow_up_at": "2026-09-08T10:30:00Z",
        }, format="json")
        self.assertEqual(response.status_code, 200)
        self.sync()
        self.quote.update(updatedAt="2026-09-02T10:00:00Z", manualTotal=75500)
        self.sync()
        self.assertEqual(CalculatorLead.objects.count(), 1)
        lead.refresh_from_db()
        self.assertEqual(lead.amount, Decimal("75500"))
        self.assertEqual(lead.status, "in_progress")
        self.assertEqual(lead.manager_note, "Перезвонить")
        self.assertIsNotNone(lead.follow_up_at)
        result = self.client.get("/api/calculator-leads/").data[0]
        self.assertEqual(result["quote_number"], "1001")

    def test_stale_revision_does_not_change_request(self):
        self.sync()
        stale = deepcopy(self.quote)
        stale.update(updatedAt="2026-08-01T10:00:00Z", manualTotal=100)
        self.sync(stale)
        self.assertEqual(CalculatorLead.objects.get().amount, Decimal("81000"))

    def test_contactless_draft_appears_only_after_contact_is_added(self):
        draft = deepcopy(self.quote)
        draft["customer"] = {}
        self.sync(draft)
        self.assertFalse(CalculatorLead.objects.exists())
        self.quote["updatedAt"] = "2026-09-02T10:00:00Z"
        self.sync()
        self.assertEqual(CalculatorLead.objects.count(), 1)

    def test_invalid_amount_does_not_break_archive_sync(self):
        self.quote["result"]["total"] = "not a number"
        self.sync()
        self.assertTrue(CalculatorQuote.objects.exists())
        self.assertFalse(CalculatorLead.objects.exists())

    def test_variants_use_minimum_price_and_calculator_rounding(self):
        self.quote["variants"] = [
            {"itemIds": ["item-1"], "orderDelivery": {"enabled": True}, "deliveryPrice": 1001},
            {"itemIds": ["item-1"], "manualTotal": 80501},
        ]
        self.sync()
        lead = CalculatorLead.objects.get()
        self.assertEqual(lead.amount, Decimal("80600"))
        self.assertTrue(lead.configuration["amount_is_from"])

    def test_public_quote_links_existing_lead_without_duplicate(self):
        self.quote["id"] = "public-public-token"
        lead = CalculatorLead.objects.create(
            workspace=self.workspace, calculation_id="public-token", client_name="Максим",
            client_phone="89140707007", product="shower", amount=81000, price_version="",
            source_url="https://amalgama.cehcrm.ru/", configuration={"fingerprint": "original"},
        )
        self.sync()
        self.assertEqual(CalculatorLead.objects.count(), 1)
        lead.refresh_from_db()
        self.assertIsNotNone(lead.quote_id)
        self.assertEqual(lead.configuration["fingerprint"], "original")

    def test_delete_erases_contacts_and_rejects_offline_resurrection(self):
        self.sync()
        lead = CalculatorLead.objects.get()
        result = self.client.delete(f"/api/calculator-leads/{lead.pk}/")
        self.assertEqual(result.status_code, 204)
        self.assertFalse(CalculatorLead.objects.exists())
        quote = CalculatorQuote.objects.get()
        self.assertEqual(quote.payload, {})
        self.assertTrue(quote.lead_deleted)
        self.assertEqual(self.client.get("/api/calculator-quotes/").data["quotes"], [])
        self.client.delete(f"/api/calculator-quotes/{quote.quote_id}/")
        self.quote["updatedAt"] = "2026-09-03T10:00:00Z"
        self.assertEqual(self.sync().data["quotes"], [])
        call_command("backfill_calculator_leads", stdout=StringIO())
        self.assertFalse(CalculatorLead.objects.exists())

    def test_backfill_is_idempotent_and_uses_existing_archive(self):
        CalculatorQuote.objects.create(workspace=self.workspace, quote_id=self.quote["id"], payload=self.quote)
        call_command("backfill_calculator_leads", stdout=StringIO())
        call_command("backfill_calculator_leads", stdout=StringIO())
        self.assertEqual(CalculatorLead.objects.count(), 1)

    def test_resaving_quote_deleted_only_from_archive_relinks_original_request(self):
        self.sync()
        lead = CalculatorLead.objects.get()
        self.client.delete(f"/api/calculator-quotes/{self.quote['id']}/")
        self.sync()
        self.assertEqual(CalculatorLead.objects.get().pk, lead.pk)
        self.assertIsNotNone(CalculatorLead.objects.get().quote_id)

    def test_deleted_public_calculation_cannot_be_submitted_again(self):
        cache.clear()
        cache.set("public-calc:result:deleted-token", {"amount": 100}, 60)
        CalculatorQuote.objects.create(workspace=default_workspace(), quote_id="public-deleted-token", lead_deleted=True)
        self.client.force_authenticate(None)
        response = self.client.post("/api/public-calculator/lead/", {
            "calculation_id": "deleted-token", "name": "Клиент", "phone": "79000000001",
        }, format="json")
        self.assertEqual(response.status_code, 410)
        self.assertFalse(CalculatorLead.objects.exists())

    def test_tenant_isolation_and_same_quote_id_in_two_companies(self):
        self.sync()
        first = CalculatorLead.objects.get()
        other = Workspace.objects.create(name="Other", slug="other")
        user = User.objects.create_user(username="other-admin", role="admin", workspace=other)
        self.client.force_authenticate(user)
        self.assertEqual(self.client.get("/api/calculator-leads/").data, [])
        self.assertEqual(self.client.patch(f"/api/calculator-leads/{first.pk}/", {"status": "done"}).status_code, 404)
        self.assertEqual(self.client.delete(f"/api/calculator-leads/{first.pk}/").status_code, 404)
        self.sync()
        self.assertEqual(CalculatorLead.objects.count(), 2)

    def test_reminder_validation_and_permissions(self):
        self.sync()
        lead = CalculatorLead.objects.get()
        url = f"/api/calculator-leads/{lead.pk}/"
        self.assertEqual(self.client.patch(url, {"follow_up_at": "invalid"}).status_code, 400)
        self.assertEqual(self.client.patch(url, {"status": "invalid"}).status_code, 400)
        self.assertEqual(self.client.patch(url, {"follow_up_at": None}, format="json").status_code, 200)
        self.user.role = "manager"
        self.user.save()
        self.assertEqual(self.client.delete(url).status_code, 403)
        self.client.force_authenticate(None)
        self.assertEqual(self.client.post("/api/calculator-quotes/", {"quotes": [self.quote]}, format="json").status_code, 401)
