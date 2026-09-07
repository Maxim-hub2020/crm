from decimal import Decimal

from rest_framework.test import APITestCase

from .models import CalculatorQuote, Client, Project, ProjectStatus, User, Workspace
from .views import build_project_document_values


class ProjectDocumentTests(APITestCase):
    def setUp(self):
        self.workspace = Workspace.objects.create(name="Documents", slug="documents")
        self.user = User.objects.create_user(username="documents-admin", role="admin", workspace=self.workspace)
        ProjectStatus.objects.create(workspace=self.workspace, code="active", name="В работе", is_default=True)
        self.client_card = Client.objects.create(
            workspace=self.workspace,
            name="Иван",
            phone="+7-900-000-00-00",
            works_with_contract=True,
        )
        self.project = Project.objects.create(
            workspace=self.workspace,
            manager=self.user,
            client=self.client_card,
            client_name=self.client_card.name,
            client_phone=self.client_card.phone,
            order_number=12,
            title="Душевая",
            total_amount=Decimal("81000"),
            status="active",
        )
        self.client.force_authenticate(self.user)

    def test_document_requires_contract_full_name(self):
        response = self.client.get(f"/api/projects/{self.project.pk}/documents/contract/")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data["missing_fields"], ["contract_full_name"])

    def test_document_values_include_linked_quote_items(self):
        self.client_card.contract_full_name = "Иванов Иван Иванович"
        self.client_card.save(update_fields=["contract_full_name", "updated_at"])
        CalculatorQuote.objects.create(
            workspace=self.workspace,
            quote_id="quote-12",
            number="1027",
            project=self.project,
            payload={
                "items": [
                    {
                        "id": "one",
                        "constructionTitle": "Стеклянная душевая",
                        "quantity": 2,
                        "result": {"total": 40000},
                    }
                ]
            },
        )

        values = build_project_document_values(self.project)

        self.assertEqual(values["CLIENT_FULL_NAME"], "Иванов Иван Иванович")
        self.assertEqual(values["PROJECT_NUMBER"], "0012")
        self.assertEqual(values["QUOTE_NUMBER"], "1027")
        self.assertIn("Стеклянная душевая — 2 шт. — 80 000 руб.", values["QUOTE_ITEMS"])
        self.assertEqual(values["DEAL_VALUE"], "81 000 руб.")

    def test_document_values_fall_back_to_project_without_quote(self):
        self.client_card.contract_full_name = "Иванов Иван Иванович"
        self.client_card.save(update_fields=["contract_full_name", "updated_at"])

        values = build_project_document_values(self.project)

        self.assertEqual(values["QUOTE_NUMBER"], "")
        self.assertIn("Душевая — 1 шт. — 81 000 руб.", values["QUOTE_ITEMS"])
