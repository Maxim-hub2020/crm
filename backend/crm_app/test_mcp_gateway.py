import base64
import hashlib
import json
from decimal import Decimal
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from .models import Account, CalculatorQuote, CalculatorSettings, Client, FinanceCategory, Payment, Project, ProjectComment, ProjectCustomField, User, Workspace


@override_settings(ALLOWED_HOSTS=["testserver"], SECURE_SSL_REDIRECT=False)
class RemoteMcpTests(TestCase):
    def setUp(self):
        self.workspace = Workspace.objects.create(name="Цех", slug="mcp-test")
        self.user = User.objects.create_user(
            username="master", password="strong-test-password", role=User.Role.ADMIN, workspace=self.workspace,
        )
        self.client_record = Client.objects.create(workspace=self.workspace, name="Клиент", phone="+79990000000")
        self.project = Project.objects.create(
            workspace=self.workspace,
            manager=self.user,
            client=self.client_record,
            client_name="Клиент",
            client_phone="+79990000000",
            title="Зеркало",
        )

    def connect(self):
        redirect_uri = "https://chatgpt.com/connector/oauth/test-callback"
        registration = self.client.post(
            "/api/mcp/oauth/register/",
            data=json.dumps({"client_name": "ChatGPT", "redirect_uris": [redirect_uri], "token_endpoint_auth_method": "none"}),
            content_type="application/json",
        )
        self.assertEqual(registration.status_code, 201)
        client_id = registration.json()["client_id"]
        verifier = "v" * 64
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        params = {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "crm.read crm.write crm.admin",
            "state": "state-1",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "resource": "http://testserver/api/mcp",
            "username": "master",
            "password": "strong-test-password",
            "approve": "yes",
        }
        authorized = self.client.post("/api/mcp/oauth/authorize/", params)
        self.assertEqual(authorized.status_code, 302)
        code = parse_qs(urlsplit(authorized["Location"]).query)["code"][0]
        token = self.client.post("/api/mcp/oauth/token/", {
            "grant_type": "authorization_code",
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "resource": "http://testserver/api/mcp",
            "code": code,
            "code_verifier": verifier,
        })
        self.assertEqual(token.status_code, 200, token.content)
        return token.json()["access_token"]

    def rpc(self, method, params=None, token=None, message_id=1):
        headers = {"HTTP_AUTHORIZATION": f"Bearer {token}"} if token else {}
        return self.client.post(
            "/api/mcp/",
            data=json.dumps({"jsonrpc": "2.0", "id": message_id, "method": method, "params": params or {}}),
            content_type="application/json",
            **headers,
        )

    def test_discovery_and_oauth_metadata(self):
        metadata = self.client.get("/.well-known/oauth-protected-resource")
        self.assertEqual(metadata.status_code, 200)
        self.assertEqual(metadata.json()["resource"], "http://testserver/api/mcp")
        tools = self.rpc("tools/list")
        self.assertEqual(tools.status_code, 200)
        tool_items = tools.json()["result"]["tools"]
        self.assertIn("crm_search", {item["name"] for item in tool_items})
        self.assertIn("crm_resolve_project", {item["name"] for item in tool_items})
        self.assertIn("crm_finance_overview", {item["name"] for item in tool_items})
        self.assertIn("crm_adjust_balance", {item["name"] for item in tool_items})
        self.assertIn("crm_calculator_catalog", {item["name"] for item in tool_items})
        self.assertIn("crm_calculate_product", {item["name"] for item in tool_items})
        self.assertIn("crm_save_calculator_quote", {item["name"] for item in tool_items})
        self.assertIn("public_shower_technologist_context", {item["name"] for item in tool_items})
        public_context = self.rpc("tools/call", {"name": "public_shower_technologist_context", "arguments": {}})
        self.assertEqual(public_context.status_code, 200)
        public_payload = public_context.json()["result"]["structuredContent"]
        self.assertEqual(public_payload["scope"], "public_shower_design_only")
        self.assertIn("# Технолог производства", public_payload["rules"])
        upload_tool = next(item for item in tool_items if item["name"] == "crm_upload_file")
        self.assertEqual(upload_tool["_meta"]["openai/fileParams"], ["file"])
        file_schema = upload_tool["inputSchema"]["$defs"]["OpenAIFile"]
        self.assertEqual(file_schema["required"], ["download_url", "file_id"])
        self.assertEqual(
            set(file_schema["properties"]),
            {"download_url", "file_id", "mime_type", "file_name"},
        )
        skills = self.rpc("skills/list")
        self.assertEqual(skills.status_code, 200)
        self.assertEqual(
            {item["frontmatter"]["name"] for item in skills.json()["result"]["skills"]},
            {"crm-operator", "production-technologist"},
        )
        production = next(
            item for item in skills.json()["result"]["skills"]
            if item["frontmatter"]["name"] == "production-technologist"
        )
        fetched = self.rpc("skills/get", {"uri": production["uri"]})
        self.assertEqual(fetched.json()["result"]["skill"], production)
        resource = self.rpc("resources/read", {"uri": production["uri"]})
        self.assertIn("# Технолог производства", resource.json()["result"]["contents"][0]["text"])

    def test_calculator_tools_use_connected_workspace_catalog(self):
        CalculatorSettings.objects.create(
            workspace=self.workspace,
            shower_catalog={
                "constructions": [{
                    "id": "partition",
                    "title": "Душевая перегородка",
                    "installationPrice": 5000,
                    "hardwareComponents": [
                        {"hardwareItemId": "hinge", "quantity": 2, "glassThickness": 8},
                        {"hardwareItemId": "handle", "quantity": 1},
                    ],
                    "fields": [
                        {"key": "HEIGHT_0", "label": "Высота", "defaultValue": 2000},
                        {"key": "WIDTH_0", "label": "Ширина", "defaultValue": 1000},
                    ],
                }],
                "glass": [{"id": "clear", "label": "Бесцветное 8 мм", "price": 6200, "thickness": 8}],
                "hardware": [{"id": "chrome", "label": "Хром", "price": 0}],
                "hardwareClass": [{"id": "standard", "label": "Стандарт", "price": 0}],
                "hardwareItems": [
                    {"id": "hinge", "label": "Петля 8 мм", "price": 1200},
                    {"id": "handle", "label": "Ручка", "price": 600},
                ],
                "services": {"deliveryBase": 1500, "deliveryKmRate": 50},
            },
            mirror_catalog={
                "materials": [{"id": "silver", "label": "Серебро", "price": 2250}],
                "services": [],
                "settings": {"materialMarkupPercent": 30, "serviceMarkupPercent": 0},
            },
        )
        token = self.connect()

        catalog_response = self.rpc("tools/call", {
            "name": "crm_calculator_catalog",
            "arguments": {},
        }, token).json()["result"]
        self.assertFalse(catalog_response.get("isError", False), catalog_response)
        catalog = catalog_response["structuredContent"]
        self.assertEqual(catalog["shower"]["constructions"][0]["id"], "partition")
        self.assertNotIn("price", catalog["shower"]["glass"][0])

        calculation_response = self.rpc("tools/call", {
            "name": "crm_calculate_product",
            "arguments": {
                "product": "shower",
                "configuration": {
                    "constructionId": "partition",
                    "dimensions": {"HEIGHT_0": 2000, "WIDTH_0": 1000},
                    "glassId": "clear",
                    "hardwareId": "chrome",
                    "hardwareClassId": "standard",
                    "installation": True,
                },
                "delivery": {"enabled": True, "zone": "outside", "km": 10},
            },
        }, token).json()["result"]
        self.assertFalse(calculation_response.get("isError", False), calculation_response)
        calculation = calculation_response["structuredContent"]
        self.assertEqual(calculation["item_amount"], 20400)
        self.assertEqual(calculation["delivery_amount"], 2000)
        self.assertEqual(calculation["amount"], 22400)
        self.assertEqual(calculation["selection"]["construction"], "Душевая перегородка")

        save_arguments = {
            "project_query": "Зеркало",
            "product": "shower",
            "configuration": {
                "constructionId": "partition",
                "dimensions": {"HEIGHT_0": 2000, "WIDTH_0": 1000},
                "glassId": "clear",
                "hardwareId": "chrome",
                "hardwareClassId": "standard",
                "installation": True,
            },
            "delivery": {"enabled": True, "zone": "outside", "km": 10},
        }
        rejected_save = self.rpc("tools/call", {
            "name": "crm_save_calculator_quote",
            "arguments": save_arguments,
        }, token).json()["result"]
        self.assertTrue(rejected_save["isError"])
        self.assertFalse(CalculatorQuote.objects.exists())

        saved_quote = self.rpc("tools/call", {
            "name": "crm_save_calculator_quote",
            "arguments": {**save_arguments, "confirm": True},
        }, token).json()["result"]
        self.assertFalse(saved_quote.get("isError", False), saved_quote)
        self.assertEqual(saved_quote["structuredContent"]["amount"], 22400)
        self.assertEqual(CalculatorQuote.objects.filter(project=self.project).count(), 1)
        self.project.refresh_from_db()
        self.assertEqual(self.project.total_amount, Decimal("22400.00"))

        repeated_save = self.rpc("tools/call", {
            "name": "crm_save_calculator_quote",
            "arguments": {**save_arguments, "confirm": True},
        }, token).json()["result"]
        self.assertFalse(repeated_save.get("isError", False), repeated_save)
        self.assertEqual(CalculatorQuote.objects.filter(project=self.project).count(), 1)

    def test_authenticated_read_write_and_delete_confirmation(self):
        token = self.connect()
        profile = self.rpc("tools/call", {"name": "crm_profile", "arguments": {}}, token)
        self.assertEqual(profile.json()["result"]["structuredContent"]["id"], f"crm-user-{self.user.id}")
        result = self.rpc("tools/call", {"name": "crm_get", "arguments": {"resource": "projects", "id": self.project.id}}, token)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["result"]["structuredContent"]["data"]["id"], self.project.id)

        created = self.rpc("tools/call", {"name": "crm_create", "arguments": {
            "resource": "project-comments", "data": {"project": self.project.id, "text": "Проверено через MCP"},
        }}, token)
        self.assertFalse(created.json()["result"].get("isError", False), created.content)
        comment_id = ProjectComment.objects.get().id

        rejected = self.rpc("tools/call", {"name": "crm_delete", "arguments": {
            "resource": "project-comments", "id": comment_id, "confirm": False,
        }}, token)
        self.assertTrue(rejected.json()["result"]["isError"])
        self.assertTrue(ProjectComment.objects.filter(pk=comment_id).exists())

        deleted = self.rpc("tools/call", {"name": "crm_delete", "arguments": {
            "resource": "project-comments", "id": comment_id, "confirm": True,
        }}, token)
        self.assertFalse(deleted.json()["result"].get("isError", False), deleted.content)
        self.assertFalse(ProjectComment.objects.filter(pk=comment_id).exists())

        finance_rejected = self.rpc("tools/call", {"name": "crm_create", "arguments": {
            "resource": "payments", "data": {"project": self.project.id, "amount": "1000.00"},
        }}, token)
        self.assertTrue(finance_rejected.json()["result"]["isError"])

    def test_validation_error_is_retryable_and_does_not_report_blocked_access(self):
        account = Account.objects.create(workspace=self.workspace, name="Наличные")
        token = self.connect()

        response = self.rpc("tools/call", {"name": "crm_create", "arguments": {
            "resource": "payments",
            "confirm": True,
            "data": {"category": 999999, "account": account.id, "amount": "1000.00"},
        }}, token)

        result = response.json()["result"]
        self.assertTrue(result["isError"])
        error = result["structuredContent"]
        self.assertEqual(error["error_type"], "invalid_input")
        self.assertTrue(error["retryable"])
        self.assertTrue(error["connection_active"])
        self.assertIn("category", str(error["details"]))

    def test_project_resolver_never_treats_order_number_as_internal_id(self):
        Project.objects.create(
            id=44,
            workspace=self.workspace,
            manager=self.user,
            client=self.client_record,
            order_number=14,
            client_name="Заказ 14",
            client_phone="+79992222222",
            title="Проект с внутренним ID 44",
        )
        target = Project.objects.create(
            id=45,
            workspace=self.workspace,
            manager=self.user,
            client=self.client_record,
            order_number=44,
            client_name="Заказ 44",
            client_phone="+79991111111",
            title="Зеркало на Левобережной",
            object_address="Левобережная 12",
        )
        token = self.connect()

        by_number = self.rpc("tools/call", {
            "name": "crm_resolve_project", "arguments": {"query": "заказ номер 44"},
        }, token).json()["result"]["structuredContent"]
        self.assertEqual(by_number["match_status"], "resolved")
        self.assertEqual(by_number["projects"][0]["project_id"], target.id)
        self.assertEqual(by_number["projects"][0]["order_number"], 44)
        self.assertNotEqual(by_number["projects"][0]["project_id"], 44)
        self.assertEqual(by_number["project"]["id"], target.id)
        self.assertEqual(by_number["project"]["order_number"], 44)

        by_address = self.rpc("tools/call", {
            "name": "crm_resolve_project", "arguments": {"query": "Левобережная"},
        }, token).json()["result"]["structuredContent"]
        self.assertEqual(by_address["match_status"], "resolved")
        self.assertEqual(by_address["projects"][0]["project_id"], target.id)

        comment = self.rpc("tools/call", {"name": "crm_create", "arguments": {
            "resource": "project-comments",
            "project_query": "Левобережная",
            "data": {"text": "Быстрая запись без отдельного поиска"},
        }}, token).json()["result"]
        self.assertFalse(comment.get("isError", False), comment)
        self.assertTrue(ProjectComment.objects.filter(
            project=target,
            text="Быстрая запись без отдельного поиска",
        ).exists())

    def test_general_income_and_expense_can_be_created_without_project(self):
        expense_category = FinanceCategory.objects.create(
            workspace=self.workspace,
            name="Личные траты",
            type=FinanceCategory.Type.EXPENSE,
            affects_margin=False,
        )
        income_category = FinanceCategory.objects.create(
            workspace=self.workspace,
            name="Прочий доход",
            type=FinanceCategory.Type.INCOME,
        )
        account = Account.objects.create(workspace=self.workspace, name="Касса")
        token = self.connect()
        results = []

        for category, amount, comment in [
            (expense_category, "1000.00", "Личные траты без проекта"),
            (income_category, "2500.00", "Доход без проекта"),
        ]:
            response = self.rpc("tools/call", {"name": "crm_create", "arguments": {
                "resource": "payments",
                "confirm": True,
                "data": {
                    "category": category.id,
                    "account": account.id,
                    "amount": amount,
                    "comment": comment,
                },
            }}, token)
            payload = response.json()["result"]
            self.assertFalse(payload.get("isError", False), payload)
            results.append(payload["structuredContent"])

        for result in results:
            self.assertTrue(result["operation_committed"])
            self.assertTrue(result["do_not_retry"])
            self.assertEqual(result["payment"], result["data"])
            self.assertIsNotNone(result["payment"]["id"])
            self.assertIn("успешно сохранена", result["message"])

        payments = Payment.objects.filter(created_by=self.user).order_by("amount")
        self.assertEqual(payments.count(), 2)
        self.assertTrue(all(payment.project_id is None for payment in payments))
        self.assertEqual(
            {payment.type for payment in payments},
            {Payment.Type.CORRECTION, Payment.Type.ADVANCE},
        )

        api_client = APIClient()
        api_client.force_authenticate(self.user)
        analytics = api_client.get("/api/finance-analytics/")
        self.assertEqual(analytics.status_code, 200)
        self.assertEqual(analytics.json()["summary"]["income_total"], "2500.00")
        self.assertEqual(analytics.json()["summary"]["expense_total"], "1000.00")
        self.assertEqual(analytics.json()["summary"]["margin_expense_total"], "0.00")
        self.assertEqual(analytics.json()["summary"]["excluded_from_margin_total"], "1000.00")
        self.assertEqual(analytics.json()["summary"]["margin_amount"], "2500.00")
        self.assertEqual(analytics.json()["summary"]["margin_percent"], "100.00")

        forecast = api_client.get("/api/cash-forecast/")
        self.assertEqual(forecast.status_code, 200)
        self.assertEqual(forecast.json()["current_balance"], "1500.00")

    def test_personal_expense_category_is_excluded_from_margin_by_default(self):
        api_client = APIClient()
        api_client.force_authenticate(self.user)

        response = api_client.post(
            "/api/finance-categories/",
            {"name": "Личные траты", "type": FinanceCategory.Type.EXPENSE},
            format="json",
        )

        self.assertEqual(response.status_code, 201, response.data)
        self.assertFalse(response.data["affects_margin"])
        self.assertFalse(FinanceCategory.objects.get(pk=response.data["id"]).affects_margin)

    def test_personal_income_category_is_excluded_from_margin_by_default(self):
        api_client = APIClient()
        api_client.force_authenticate(self.user)

        response = api_client.post(
            "/api/finance-categories/",
            {"name": "Личные доходы", "type": FinanceCategory.Type.INCOME},
            format="json",
        )

        self.assertEqual(response.status_code, 201, response.data)
        self.assertFalse(response.data["affects_margin"])
        self.assertFalse(FinanceCategory.objects.get(pk=response.data["id"]).affects_margin)

    def test_mcp_payment_requires_explicit_account(self):
        category = FinanceCategory.objects.create(
            workspace=self.workspace,
            name="Продажи",
            type=FinanceCategory.Type.INCOME,
        )
        Account.objects.create(workspace=self.workspace, name="Наличные")
        Account.objects.create(workspace=self.workspace, name="Безнал")
        token = self.connect()

        response = self.rpc("tools/call", {"name": "crm_create", "arguments": {
            "resource": "payments",
            "confirm": True,
            "data": {"category": category.id, "amount": "1000.00", "comment": "Без счета"},
        }}, token)

        payload = response.json()["result"]
        self.assertTrue(payload["isError"])
        self.assertIn("уточните у пользователя счет", payload["content"][0]["text"])
        self.assertFalse(Payment.objects.exists())

    def test_mcp_payment_resolves_exact_category_and_account_names(self):
        delivery = FinanceCategory.objects.create(
            workspace=self.workspace,
            name="Доставка",
            type=FinanceCategory.Type.EXPENSE,
        )
        cashless = Account.objects.create(workspace=self.workspace, name="Безнал")
        token = self.connect()

        response = self.rpc("tools/call", {"name": "crm_create", "arguments": {
            "resource": "payments",
            "project_query": "Зеркало",
            "confirm": True,
            "data": {
                "category_name": "  доставка ",
                "account_name": "безнал",
                "category_type": "expense",
                "amount": "1600.00",
                "comment": "Доставка",
            },
        }}, token)

        payload = response.json()["result"]
        self.assertFalse(payload.get("isError", False), payload)
        payment = Payment.objects.get()
        self.assertEqual(payment.category_id, delivery.id)
        self.assertEqual(payment.account_id, cashless.id)
        self.assertEqual(payment.project_id, self.project.id)
        self.assertTrue(payload["structuredContent"]["operation_committed"])

    def test_mcp_payment_unknown_category_returns_exact_options(self):
        FinanceCategory.objects.create(
            workspace=self.workspace,
            name="Доставка",
            type=FinanceCategory.Type.EXPENSE,
        )
        Account.objects.create(workspace=self.workspace, name="Безнал")
        token = self.connect()

        response = self.rpc("tools/call", {"name": "crm_create", "arguments": {
            "resource": "payments",
            "confirm": True,
            "data": {
                "category_name": "Логистика",
                "account_name": "Безнал",
                "amount": "1600.00",
            },
        }}, token)

        payload = response.json()["result"]
        self.assertTrue(payload["isError"])
        error = payload["structuredContent"]
        self.assertEqual(error["error_type"], "invalid_input")
        self.assertTrue(error["retryable"])
        self.assertIn("Доставка", str(error["details"]))
        self.assertFalse(Payment.objects.exists())

    def test_mcp_can_transfer_money_between_accounts(self):
        cashless = Account.objects.create(workspace=self.workspace, name="Безнал")
        cash = Account.objects.create(workspace=self.workspace, name="Наличные")
        token = self.connect()

        response = self.rpc("tools/call", {"name": "crm_transfer_money", "arguments": {
            "source_account_id": cashless.id,
            "destination_account_id": cash.id,
            "amount": 5000,
            "comment": "Снятие наличных",
            "confirm": True,
        }}, token)

        payload = response.json()["result"]
        self.assertFalse(payload.get("isError", False), payload)
        transfer = Payment.objects.get(operation_kind=Payment.OperationKind.ACCOUNT_TRANSFER)
        self.assertEqual(transfer.account_id, cashless.id)
        self.assertEqual(transfer.destination_account_id, cash.id)
        self.assertEqual(transfer.amount, Decimal("5000.00"))
        self.assertIsNone(transfer.project_id)
        self.assertIsNone(transfer.category_id)

    def test_finance_overview_keeps_personal_expenses_out_of_margin(self):
        personal_category = FinanceCategory.objects.create(
            workspace=self.workspace,
            name="Личные траты",
            type=FinanceCategory.Type.EXPENSE,
            affects_margin=False,
        )
        income_category = FinanceCategory.objects.create(
            workspace=self.workspace,
            name="Продажи",
            type=FinanceCategory.Type.INCOME,
        )
        personal_income_category = FinanceCategory.objects.create(
            workspace=self.workspace,
            name="Личные доходы",
            type=FinanceCategory.Type.INCOME,
            affects_margin=False,
        )
        account = Account.objects.create(workspace=self.workspace, name="Касса")
        Payment.objects.create(
            created_by=self.user,
            category=income_category,
            account=account,
            amount="2500.00",
            type=Payment.Type.ADVANCE,
        )
        Payment.objects.create(
            created_by=self.user,
            category=personal_income_category,
            account=account,
            amount="600.00",
            type=Payment.Type.ADVANCE,
        )
        Payment.objects.create(
            created_by=self.user,
            category=personal_category,
            account=account,
            amount="1000.00",
            type=Payment.Type.CORRECTION,
        )
        token = self.connect()

        response = self.rpc("tools/call", {
            "name": "crm_finance_overview",
            "arguments": {},
        }, token)
        payload = response.json()["result"]
        self.assertFalse(payload.get("isError", False), payload)
        overview = payload["structuredContent"]
        summary = overview["analytics"]["summary"]
        self.assertEqual(summary["income_total"], "3100.00")
        self.assertEqual(summary["margin_income_total"], "2500.00")
        self.assertEqual(summary["excluded_income_from_margin_total"], "600.00")
        self.assertEqual(summary["expense_total"], "1000.00")
        self.assertEqual(summary["margin_expense_total"], "0.00")
        self.assertEqual(summary["excluded_from_margin_total"], "1000.00")
        self.assertEqual(summary["margin_amount"], "2500.00")
        self.assertEqual(summary["margin_percent"], "100.00")
        self.assertEqual(overview["cash_forecast"]["current_balance"], "2100.00")
        self.assertIn("период аналитики не обрезает", overview["cash_scope"])

    def test_balance_adjustment_changes_cash_but_not_income_or_expense_analytics(self):
        income_category = FinanceCategory.objects.create(
            workspace=self.workspace,
            name="Продажи",
            type=FinanceCategory.Type.INCOME,
        )
        account = Account.objects.create(workspace=self.workspace, name="Касса")
        Payment.objects.create(
            project=None,
            created_by=self.user,
            category=income_category,
            account=account,
            amount="1000.00",
            type=Payment.Type.ADVANCE,
            comment="Обычный доход",
        )
        token = self.connect()

        response = self.rpc("tools/call", {"name": "crm_adjust_balance", "arguments": {
            "account_id": account.id,
            "direction": "decrease",
            "amount": 200,
            "comment": "Контрольная сверка",
            "confirm": True,
        }}, token)
        payload = response.json()["result"]
        self.assertFalse(payload.get("isError", False), payload)

        adjustment = Payment.objects.get(operation_kind=Payment.OperationKind.BALANCE_ADJUSTMENT)
        self.assertIsNone(adjustment.project_id)
        self.assertIsNone(adjustment.category_id)
        self.assertEqual(adjustment.adjustment_direction, Payment.AdjustmentDirection.DECREASE)

        api_client = APIClient()
        api_client.force_authenticate(self.user)
        analytics = api_client.get("/api/finance-analytics/")
        self.assertEqual(analytics.status_code, 200)
        self.assertEqual(analytics.json()["summary"]["income_total"], "1000.00")
        self.assertEqual(analytics.json()["summary"]["expense_total"], "0.00")

        forecast = api_client.get("/api/cash-forecast/")
        self.assertEqual(forecast.status_code, 200)
        self.assertEqual(forecast.json()["current_balance"], "800.00")

    @patch("crm_app.views.sync_project_measurement_files_to_yandex", side_effect=RuntimeError("test sync failure"))
    @patch("crm_app.mcp_gateway.requests.get")
    def test_chat_file_is_downloaded_and_attached_to_measurement_field(self, get_mock, sync_mock):
        Project.objects.filter(pk=self.project.pk).update(custom_fields="legacy-value")
        self.project.refresh_from_db()
        ProjectCustomField.objects.create(
            workspace=self.workspace,
            name="Замер",
            field_type=ProjectCustomField.FieldType.FILE,
        )
        download = Mock()
        download.url = "https://files.example.test/download/file_123"
        download.history = []
        download.headers = {"Content-Length": "11", "Content-Type": "image/jpeg"}
        download.iter_content.return_value = [b"photo-bytes"]
        download.raise_for_status.return_value = None
        get_mock.return_value = download

        token = self.connect()
        response = self.rpc("tools/call", {"name": "crm_upload_file", "arguments": {
            "project_query": str(self.project.order_number),
            "target": "project_field",
            "file": {
                "download_url": "https://files.example.test/download/file_123",
                "file_id": "file_123",
                "mime_type": "image/jpeg",
                "file_name": "замер.jpg",
            },
            "confirm": True,
        }}, token)

        payload = response.json()["result"]
        self.assertFalse(payload.get("isError", False), payload)
        self.assertEqual(payload["structuredContent"]["uploaded"][0]["name"], "замер.jpg")
        self.assertEqual(payload["structuredContent"]["uploaded"][0]["content_type"], "image/jpeg")
        self.assertTrue(payload["structuredContent"]["uploaded"][0]["url"].startswith("https://testserver/"))
        self.assertFalse(payload["structuredContent"]["yandex_disk"]["ok"])
        sync_mock.assert_called_once()
        get_mock.assert_called_once_with(
            "https://files.example.test/download/file_123",
            stream=True,
            timeout=(5, 30),
            allow_redirects=True,
        )
        download.close.assert_called_once()

    def test_tool_call_requires_oauth(self):
        response = self.rpc("tools/call", {"name": "crm_search", "arguments": {"query": "0022"}})
        self.assertEqual(response.status_code, 401)
        self.assertIn("resource_metadata", response["WWW-Authenticate"])
