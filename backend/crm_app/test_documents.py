from decimal import Decimal
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

from django.core.files import File
from pypdf import PdfReader
from rest_framework.test import APITestCase

from .models import CalculatorQuote, Client, Project, ProjectStatus, User, Workspace
from .views import build_project_document_values, render_pdf_template


class ProjectDocumentTests(APITestCase):
    def setUp(self):
        self.workspace = Workspace.objects.create(name="Documents", slug="documents")
        self.user = User.objects.create_user(username="documents-admin", role="admin", workspace=self.workspace)
        ProjectStatus.objects.create(workspace=self.workspace, code="active", name="В работе", is_default=True)
        self.client_card = Client.objects.create(
            workspace=self.workspace,
            name="Иван",
            phone="+7-900-000-00-00",
            address="г Ростов-на-Дону, ул Клиентская, д 5",
            apartment="7",
            floor="2",
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
            object_address="г Ростов-на-Дону, ул Объектная, д 12",
            entrance="3",
            apartment="15",
            floor="8",
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
                "result": {"total": 80500},
                "items": [
                    {
                        "id": "one",
                        "constructionTitle": "Стеклянная душевая",
                        "quantity": 2,
                        "result": {"total": 40000},
                        "details": [
                            {"label": "Стекло", "value": "прозрачное 8 мм"},
                            {"label": "Размер", "value": "1200 × 2000 мм"},
                        ],
                    }
                ]
            },
        )

        values = build_project_document_values(self.project)

        self.assertEqual(values["CLIENT_FULL_NAME"], "Иванов Иван Иванович")
        self.assertEqual(values["CLIENT_FULL_NAME_2"], "Иванов Иван Иванович")
        self.assertEqual(values["PROJECT_NUMBER"], "0012")
        self.assertEqual(values["QUOTE_NUMBER"], "1027")
        self.assertIn("Стеклянная душевая (Стекло: прозрачное 8 мм; Размер: 1200 × 2000 мм) – 2 шт. – 80 000 руб.", values["QUOTE_ITEMS"])
        self.assertEqual(values["DEAL_VALUE"], "80 500 руб.")
        self.assertEqual(values["_QUOTE_ROWS"][0]["amount"], "80 000 руб.")
        self.assertEqual(values["_QUOTE_ROWS"][1]["description"], "Доставка")
        self.assertEqual(values["_QUOTE_ROWS"][1]["amount"], "500 руб.")
        self.assertEqual(
            sum((row["amount_value"] for row in values["_QUOTE_ROWS"]), Decimal("0")),
            Decimal("80500"),
        )
        self.assertEqual(values["CLIENT_ADDRESS"], "г Ростов-на-Дону, ул Клиентская, д 5, этаж 2, кв. 7")
        self.assertEqual(values["PROJECT_ADDRESS"], "г Ростов-на-Дону, ул Объектная, д 12, подъезд 3, этаж 8, кв. 15")
        self.assertEqual(values["OBJECT_ADDRESS"], values["PROJECT_ADDRESS"])

    def test_document_values_fall_back_to_project_without_quote(self):
        self.client_card.contract_full_name = "Иванов Иван Иванович"
        self.client_card.save(update_fields=["contract_full_name", "updated_at"])

        values = build_project_document_values(self.project)

        self.assertEqual(values["QUOTE_NUMBER"], "")
        self.assertIn("Душевая – 1 шт. – 81 000 руб.", values["QUOTE_ITEMS"])

    def test_contract_template_renders_with_cyrillic_fields(self):
        self.client_card.contract_full_name = "Иванов Иван Иванович"
        self.client_card.save(update_fields=["contract_full_name", "updated_at"])
        template_path = Path(__file__).resolve().parents[2] / "output" / "pdf" / "Шаблон договора CRM.pdf"

        source_reader = PdfReader(str(template_path))
        source_fields = source_reader.get_fields() or {}

        with template_path.open("rb") as template_stream:
            template = SimpleNamespace(file=File(template_stream, name=template_path.name))
            rendered = render_pdf_template(template, self.project)

        reader = PdfReader(BytesIO(rendered))
        fields = reader.get_fields() or {}
        self.assertEqual(len(reader.pages), 4)
        self.assertTrue(source_fields)
        self.assertFalse(fields)
        self.assertNotIn("/AcroForm", reader.trailer["/Root"])
        self.assertFalse(any(page.get("/Annots") for page in reader.pages))
        rendered_text = "\n".join(page.extract_text() or "" for page in reader.pages)
        self.assertIn("Иванов Иван Иванович", rendered_text)
        self.assertIn("0012", rendered_text)
