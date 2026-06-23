import base64
import json
import os
import tempfile
from decimal import Decimal
from io import StringIO
from unittest.mock import patch
from asgiref.sync import async_to_sync
from django.core.management import call_command
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

from .ai_assistant import CRMAssistantService, GeminiClient, GeminiRequestError, humanize_gemini_error
from .live_assistant import AssistantLiveConsumer, _build_low_latency_system_instruction, _build_reference_cache, _has_live_assistant_access
from .models import Account, ChatIntegrationSettings, Client, ClientBonusTransaction, FinanceCategory, Payment, Project, ProjectComment, ProjectCustomField, ProjectStatus, SubscriptionInvoice, Task, User, Workspace
from .subscription import activate_subscription_invoice, ensure_subscription_defaults, issue_subscription_invoice


class AuthenticatedApiMixin:
    default_password = "StrongPass123!"

    def create_user(self, username, role=User.Role.MANAGER, **extra_fields):
        return User.objects.create_user(
            username=username,
            password=self.default_password,
            role=role,
            **extra_fields,
        )

    def auth_client_for(self, user, password=None):
        client = APIClient()
        response = client.post(
            "/api/auth/token/",
            {"username": user.username, "password": password or self.default_password},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {response.data['access']}")
        return client

    def activate_subscription(self, actor=None, plan_code=None):
        ensure_subscription_defaults()
        invoice = issue_subscription_invoice(actor=actor, plan_code=plan_code)
        return activate_subscription_invoice(invoice)


class TestHealthApi(APITestCase):
    @override_settings(SECURE_SSL_REDIRECT=True, SECURE_REDIRECT_EXEMPT=[r"^api/health/$"])
    def test_health_endpoint_does_not_redirect_when_ssl_redirect_is_enabled(self):
        response = self.client.get("/api/health/")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["status"], "ok")


class TestAuthApi(AuthenticatedApiMixin, APITestCase):
    def test_user_can_get_token_and_profile(self):
        user = self.create_user(
            "manager.one",
            first_name="Ivan",
            last_name="Petrov",
        )

        token_response = self.client.post(
            "/api/auth/token/",
            {"username": user.username, "password": self.default_password},
            format="json",
        )

        self.assertEqual(token_response.status_code, status.HTTP_200_OK)
        self.assertIn("access", token_response.data)

        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_response.data['access']}")
        me_response = self.client.get("/api/me/")

        self.assertEqual(me_response.status_code, status.HTTP_200_OK)
        self.assertEqual(me_response.data["username"], user.username)
        self.assertEqual(me_response.data["full_name"], "Ivan Petrov")
        self.assertEqual(me_response.data["role"], User.Role.MANAGER)

    def test_user_can_login_with_email(self):
        user = self.create_user(
            "manager.email",
            email="manager@example.com",
            first_name="Email",
            last_name="User",
        )

        token_response = self.client.post(
            "/api/auth/token/",
            {"username": user.email, "password": self.default_password},
            format="json",
        )

        self.assertEqual(token_response.status_code, status.HTTP_200_OK)
        self.assertIn("access", token_response.data)

    def test_token_refresh_endpoint_matches_frontend_path(self):
        user = self.create_user("manager.refresh")
        token_response = self.client.post(
            "/api/auth/token/",
            {"username": user.username, "password": self.default_password},
            format="json",
        )
        self.assertEqual(token_response.status_code, status.HTTP_200_OK)

        refresh_response = self.client.post(
            "/api/auth/token/refresh/",
            {"refresh": token_response.data["refresh"]},
            format="json",
        )

        self.assertEqual(refresh_response.status_code, status.HTTP_200_OK)
        self.assertIn("access", refresh_response.data)

    def test_superuser_profile_exposes_admin_access(self):
        user = User.objects.create_superuser(
            username="root.user",
            password=self.default_password,
            role=User.Role.MANAGER,
        )

        token_response = self.client.post(
            "/api/auth/token/",
            {"username": user.username, "password": self.default_password},
            format="json",
        )
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_response.data['access']}")

        me_response = self.client.get("/api/me/")

        self.assertEqual(me_response.status_code, status.HTTP_200_OK)
        self.assertTrue(me_response.data["is_admin"])
        self.assertTrue(me_response.data["is_superuser"])


class TestWorkspaceIsolation(AuthenticatedApiMixin, APITestCase):
    def setUp(self):
        self.workspace_a = Workspace.objects.create(name="Цех Ростов", slug="ceh-rostov")
        self.workspace_b = Workspace.objects.create(name="Другая компания", slug="other-company")
        self.admin_a = self.create_user("admin.a", role=User.Role.ADMIN, workspace=self.workspace_a)
        self.admin_b = self.create_user("admin.b", role=User.Role.ADMIN, workspace=self.workspace_b)
        self.manager_a = self.create_user("manager.a", workspace=self.workspace_a)
        self.manager_b = self.create_user("manager.b", workspace=self.workspace_b)

        ProjectStatus.objects.create(workspace=self.workspace_a, code="active", name="В работе", is_default=True)
        ProjectStatus.objects.create(workspace=self.workspace_b, code="active", name="В работе", is_default=True)
        Client.objects.create(workspace=self.workspace_a, name="Клиент A", phone="+70000000111")
        Client.objects.create(workspace=self.workspace_b, name="Клиент B", phone="+70000000222")
        Project.objects.create(workspace=self.workspace_a, manager=self.manager_a, client_name="Клиент A", client_phone="+70000000111")
        Project.objects.create(workspace=self.workspace_b, manager=self.manager_b, client_name="Клиент B", client_phone="+70000000222")

    def test_admin_sees_only_own_workspace_data(self):
        api_client = self.auth_client_for(self.admin_a)

        projects_response = api_client.get("/api/projects/")
        clients_response = api_client.get("/api/clients/")

        self.assertEqual(projects_response.status_code, status.HTTP_200_OK)
        self.assertEqual(clients_response.status_code, status.HTTP_200_OK)
        self.assertEqual([item["client_name"] for item in projects_response.data], ["Клиент A"])
        self.assertEqual([item["name"] for item in clients_response.data], ["Клиент A"])

    def test_chat_settings_are_per_workspace(self):
        api_a = self.auth_client_for(self.admin_a)
        api_b = self.auth_client_for(self.admin_b)

        response_a = api_a.patch("/api/chat-settings/", {"enabled": True, "base_url": "https://a.example.ru"}, format="json")
        response_b = api_b.patch("/api/chat-settings/", {"enabled": True, "base_url": "https://b.example.ru"}, format="json")
        read_a = api_a.get("/api/chat-settings/")
        read_b = api_b.get("/api/chat-settings/")

        self.assertEqual(response_a.status_code, status.HTTP_200_OK)
        self.assertEqual(response_b.status_code, status.HTTP_200_OK)
        self.assertEqual(read_a.data["app_url"], "https://a.example.ru/app")
        self.assertEqual(read_b.data["app_url"], "https://b.example.ru/app")


class TestDadataAddressApi(AuthenticatedApiMixin, APITestCase):
    def setUp(self):
        self.activate_subscription()
        self.user = self.create_user("address.user")

    @patch.dict(os.environ, {"DADATA_DEFAULT_REGION": "Ростовская область", "DADATA_DEFAULT_CITY": "Ростов-на-Дону"})
    def test_dadata_query_defaults_to_rostov_region(self):
        self.assertEqual(
            CRMAssistantService._dadata_query("Далмановский"),
            "Ростовская область, Далмановский",
        )

    @patch.dict(os.environ, {"DADATA_DEFAULT_REGION": "Ростовская область", "DADATA_DEFAULT_CITY": "Ростов-на-Дону"})
    def test_dadata_query_does_not_restrict_to_rostov_city(self):
        self.assertEqual(
            CRMAssistantService._dadata_query("Новочеркасск, Ленина 43"),
            "Ростовская область, Новочеркасск, Ленина 43",
        )

    @patch.dict(os.environ, {"DADATA_API_KEY": "test-token"})
    @patch("crm_app.views.CRMAssistantService._suggest_dadata_address")
    def test_address_suggestions_use_backend_dadata_proxy(self, mocked_suggest):
        mocked_suggest.return_value = [
            {
                "value": "Ростовская обл, г Ростов-на-Дону, ул Ленина, д 5",
                "unrestricted_value": "Ростовская обл, г Ростов-на-Дону, ул Ленина, д 5",
                "data": {"geo_lat": "47.222", "geo_lon": "39.72"},
            }
        ]
        api_client = self.auth_client_for(self.user)

        response = api_client.get("/api/address-suggestions/", {"q": "Ленина 5"})

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertTrue(response.data["configured"])
        self.assertEqual(response.data["default_region"], "Ростовская область")
        self.assertEqual(response.data["suggestions"][0]["lat"], "47.222")
        mocked_suggest.assert_called_once_with("Ленина 5", count=6)


class TestProjectApi(AuthenticatedApiMixin, APITestCase):
    def setUp(self):
        self.activate_subscription()
        ProjectStatus.objects.get_or_create(
            code="active",
            defaults={"name": "В работе", "short_name": "Работа", "color": "sky", "sort_order": 10, "is_default": True},
        )
        self.manager = self.create_user("manager.one")
        self.other_manager = self.create_user("manager.two")
        self.admin = self.create_user("admin.user", role=User.Role.ADMIN)

        self.manager_project = Project.objects.create(
            manager=self.manager,
            client_name="Client One",
            client_phone="+70000000001",
        )
        self.other_project = Project.objects.create(
            manager=self.other_manager,
            client_name="Client Two",
            client_phone="+70000000002",
        )

    def test_manager_sees_only_own_projects(self):
        client = self.auth_client_for(self.manager)

        response = client.get("/api/projects/")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 1)
        self.assertEqual(response.data[0]["id"], self.manager_project.id)

    def test_admin_sees_all_projects(self):
        client = self.auth_client_for(self.admin)

        response = client.get("/api/projects/")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 2)

    def test_project_create_forces_current_user_as_manager(self):
        client = self.auth_client_for(self.manager)

        response = client.post(
            "/api/projects/",
            {
                "manager": self.other_manager.id,
                "title": "Kitchen Project",
                "client_name": "New Client",
                "client_phone": "+70000000003",
                "categories": "mirrors",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data["manager"], self.manager.id)

        created_project = Project.objects.get(id=response.data["id"])
        self.assertEqual(created_project.manager_id, self.manager.id)
        self.assertEqual(created_project.title, "Kitchen Project")
        self.assertEqual(response.data["title"], "Kitchen Project")
        self.assertEqual(response.data["order_number"], created_project.order_number)
        self.assertEqual(response.data["order_number_label"], f"{created_project.order_number:04d}")

    def test_project_create_without_trailing_slash_still_returns_json(self):
        client = self.auth_client_for(self.manager)

        response = client.post(
            "/api/projects",
            {
                "title": "No slash project",
                "client_name": "No Slash Client",
                "client_phone": "+70000000999",
                "categories": "mirrors",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.data["title"], "No slash project")

    @patch("crm_app.serializers.ensure_project_bonus_accrual", side_effect=RuntimeError("bonus subsystem unavailable"))
    def test_project_create_survives_bonus_accrual_failure(self, _mocked_accrual):
        client = self.auth_client_for(self.manager)

        response = client.post(
            "/api/projects/",
            {
                "title": "Bonus-safe project",
                "client_name": "Bonus Safe Client",
                "client_phone": "+70000000998",
                "total_amount": "120000",
                "categories": "mirrors",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data["title"], "Bonus-safe project")
        self.assertTrue(Project.objects.filter(title="Bonus-safe project").exists())

    def test_projects_receive_sequential_order_numbers(self):
        self.assertEqual(self.manager_project.order_number, 1)
        self.assertEqual(self.other_project.order_number, 2)

        created_project = Project.objects.create(
            manager=self.manager,
            client_name="Client Three",
            client_phone="+70000000003",
        )

        self.assertEqual(created_project.order_number, 3)

    def test_project_create_creates_or_reuses_client_card(self):
        client = self.auth_client_for(self.manager)

        response = client.post(
            "/api/projects/",
            {
                "client_name": "Contract Client",
                "client_phone": "+70000000077",
                "client_email": "client@example.com",
                "object_address": "Moscow",
                "object_lat": "55.755864",
                "object_lon": "37.617698",
                "apartment": "12",
                "entrance": "3",
                "floor": "7",
                "categories": "mirrors",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertTrue(response.data["client"])
        created_client = Client.objects.get(id=response.data["client"])
        self.assertEqual(created_client.name, "Contract Client")
        self.assertEqual(created_client.phone, "+7-000-000-00-77")
        self.assertEqual(response.data["object_address"], "Moscow")
        self.assertEqual(response.data["object_lat"], "55.755864")
        self.assertEqual(response.data["object_lon"], "37.617698")
        self.assertEqual(response.data["apartment"], "12")
        self.assertEqual(response.data["entrance"], "3")
        self.assertEqual(response.data["floor"], "7")

    def test_project_can_be_created_without_phone(self):
        client = self.auth_client_for(self.manager)

        response = client.post(
            "/api/projects/",
            {
                "client_name": "Client Without Phone",
                "categories": "mirrors",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data["client_phone"], "")

    def test_project_normalizes_client_phone(self):
        client = self.auth_client_for(self.manager)

        response = client.post(
            "/api/projects/",
            {
                "client_name": "Phone Client",
                "client_phone": "8 (900) 000-00-77",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data["client_phone"], "+7-900-000-00-77")
        self.assertTrue(Client.objects.filter(phone="+7-900-000-00-77").exists())

    def test_project_client_can_be_detached(self):
        client = self.auth_client_for(self.manager)
        client_card = Client.objects.create(
            workspace=self.manager.workspace,
            name="Linked Client",
            phone="+7-900-000-00-77",
        )
        project = Project.objects.create(
            manager=self.manager,
            client=client_card,
            title="Linked Project",
            client_name=client_card.name,
            client_phone=client_card.phone,
        )

        response = client.patch(
            f"/api/projects/{project.id}/",
            {
                "client": None,
                "client_name": "",
                "client_phone": "",
                "client_email": None,
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        project.refresh_from_db()
        self.assertIsNone(project.client)
        self.assertEqual(project.client_name, "")
        self.assertEqual(project.client_phone, "")
        self.assertTrue(Client.objects.filter(pk=client_card.pk).exists())

    def test_project_client_can_be_attached_after_detach(self):
        client = self.auth_client_for(self.manager)
        next_client = Client.objects.create(
            workspace=self.manager.workspace,
            name="Next Client",
            phone="+7-900-000-00-78",
            email="next@example.com",
        )
        project = Project.objects.create(
            manager=self.manager,
            title="Detached Project",
            client_name="",
            client_phone="",
        )

        response = client.patch(
            f"/api/projects/{project.id}/",
            {"client": next_client.id},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        project.refresh_from_db()
        self.assertEqual(project.client_id, next_client.id)
        self.assertEqual(project.client_name, "Next Client")
        self.assertEqual(project.client_phone, "+7-900-000-00-78")
        self.assertEqual(project.client_email, "next@example.com")

    def test_project_rejects_invalid_client_phone(self):
        client = self.auth_client_for(self.manager)

        response = client.post(
            "/api/projects/",
            {
                "client_name": "Bad Phone Client",
                "client_phone": "12345",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("client_phone", response.data)

    def test_project_custom_fields_are_saved_and_updated(self):
        client = self.auth_client_for(self.manager)
        custom_field = ProjectCustomField.objects.create(
            workspace=self.manager.workspace,
            name="Glass color",
            field_type=ProjectCustomField.FieldType.TEXT,
            sort_order=10,
        )

        create_response = client.post(
            "/api/projects/",
            {
                "client_name": "Custom Client",
                "client_phone": "+70000000088",
                "custom_fields": {str(custom_field.id): "bronze"},
            },
            format="json",
        )

        self.assertEqual(create_response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(create_response.data["custom_fields"], {str(custom_field.id): "bronze"})

        update_response = client.patch(
            f"/api/projects/{create_response.data['id']}/",
            {"custom_fields": {str(custom_field.id): "clear"}},
            format="json",
        )

        self.assertEqual(update_response.status_code, status.HTTP_200_OK)
        self.assertEqual(update_response.data["custom_fields"], {str(custom_field.id): "clear"})
        self.assertEqual(Project.objects.get(id=create_response.data["id"]).custom_fields, {str(custom_field.id): "clear"})

    def test_project_custom_field_file_can_be_uploaded(self):
        client = self.auth_client_for(self.manager)
        custom_field = ProjectCustomField.objects.create(
            workspace=self.manager.workspace,
            name="Photo",
            field_type=ProjectCustomField.FieldType.FILE,
            sort_order=20,
        )

        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            upload = SimpleUploadedFile("measurement.jpg", b"fake-image-bytes", content_type="image/jpeg")
            response = client.post(
                f"/api/projects/{self.manager_project.id}/custom-field-files/",
                {"field_id": str(custom_field.id), "file": upload},
                format="multipart",
            )

            self.assertEqual(response.status_code, status.HTTP_200_OK)
            self.assertEqual(response.data["field_id"], str(custom_field.id))
            self.assertEqual(response.data["value"][0]["name"], "measurement.jpg")
            self.assertEqual(response.data["value"][0]["content_type"], "image/jpeg")
            self.assertIn("/media/project_custom_fields/", response.data["value"][0]["url"])

            self.manager_project.refresh_from_db()
            stored_value = self.manager_project.custom_fields[str(custom_field.id)]
            self.assertEqual(stored_value[0]["name"], "measurement.jpg")
            self.assertTrue(os.path.exists(os.path.join(media_root, stored_value[0]["path"])))

    def test_project_custom_field_files_are_appended(self):
        client = self.auth_client_for(self.manager)
        custom_field = ProjectCustomField.objects.create(
            workspace=self.manager.workspace,
            name="Photos",
            field_type=ProjectCustomField.FieldType.FILE,
            sort_order=20,
        )

        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            first_upload = SimpleUploadedFile("measurement.jpg", b"fake-image-bytes", content_type="image/jpeg")
            first_response = client.post(
                f"/api/projects/{self.manager_project.id}/custom-field-files/",
                {"field_id": str(custom_field.id), "file": first_upload},
                format="multipart",
            )
            self.assertEqual(first_response.status_code, status.HTTP_200_OK)

            second_upload = SimpleUploadedFile("drawing.pdf", b"fake-pdf-bytes", content_type="application/pdf")
            second_response = client.post(
                f"/api/projects/{self.manager_project.id}/custom-field-files/",
                {"field_id": str(custom_field.id), "file": second_upload},
                format="multipart",
            )

            self.assertEqual(second_response.status_code, status.HTTP_200_OK)
            self.assertEqual([item["name"] for item in second_response.data["value"]], ["measurement.jpg", "drawing.pdf"])

            self.manager_project.refresh_from_db()
            stored_value = self.manager_project.custom_fields[str(custom_field.id)]
            self.assertEqual([item["name"] for item in stored_value], ["measurement.jpg", "drawing.pdf"])
            self.assertTrue(os.path.exists(os.path.join(media_root, stored_value[0]["path"])))
            self.assertTrue(os.path.exists(os.path.join(media_root, stored_value[1]["path"])))

    def test_project_custom_field_multiple_files_can_be_uploaded_at_once(self):
        client = self.auth_client_for(self.manager)
        custom_field = ProjectCustomField.objects.create(
            workspace=self.manager.workspace,
            name="Photos",
            field_type=ProjectCustomField.FieldType.FILE,
            sort_order=20,
        )

        with tempfile.TemporaryDirectory() as media_root, override_settings(MEDIA_ROOT=media_root):
            first_upload = SimpleUploadedFile("measurement.jpg", b"fake-image-bytes", content_type="image/jpeg")
            second_upload = SimpleUploadedFile("drawing.pdf", b"fake-pdf-bytes", content_type="application/pdf")
            response = client.post(
                f"/api/projects/{self.manager_project.id}/custom-field-files/",
                {"field_id": str(custom_field.id), "files": [first_upload, second_upload]},
                format="multipart",
            )

            self.assertEqual(response.status_code, status.HTTP_200_OK)
            self.assertEqual([item["name"] for item in response.data["value"]], ["measurement.jpg", "drawing.pdf"])

            self.manager_project.refresh_from_db()
            stored_value = self.manager_project.custom_fields[str(custom_field.id)]
            self.assertEqual([item["name"] for item in stored_value], ["measurement.jpg", "drawing.pdf"])
            self.assertTrue(os.path.exists(os.path.join(media_root, stored_value[0]["path"])))
            self.assertTrue(os.path.exists(os.path.join(media_root, stored_value[1]["path"])))

    def test_project_promo_code_debits_referrer_without_crediting_project_client(self):
        api_client = self.auth_client_for(self.manager)
        referrer = Client.objects.create(
            workspace=self.manager.workspace,
            name="Referrer",
            phone="+79000001234",
            bonus_balance=Decimal("20000.00"),
        )

        response = api_client.post(
            "/api/projects/",
            {
                "title": "Referral project",
                "client_name": "New Client",
                "client_phone": "+79000009999",
                "total_amount": "120000",
                "bonus_promo_code": "01234",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        referrer.refresh_from_db()
        project = Project.objects.get(id=response.data["id"])
        project.client.refresh_from_db()
        self.assertEqual(referrer.bonus_balance, Decimal("8000.00"))
        self.assertEqual(project.client.bonus_balance, Decimal("0.00"))
        self.assertEqual(project.bonus_promo_code, "01234")
        self.assertEqual(project.referred_by_client_id, referrer.id)
        self.assertEqual(project.referral_bonus_used, Decimal("12000.00"))
        self.assertEqual(ClientBonusTransaction.objects.filter(project=project, promo_code="01234").count(), 1)
        self.assertEqual(
            ClientBonusTransaction.objects.filter(project=project, type=ClientBonusTransaction.Type.PROMO_CREDIT).count(),
            0,
        )

    def test_bonus_promo_preview_returns_discount_before_project_creation(self):
        api_client = self.auth_client_for(self.manager)
        Client.objects.create(
            workspace=self.manager.workspace,
            name="Referrer",
            phone="+79000001234",
            bonus_balance=Decimal("20000.00"),
        )

        response = api_client.post(
            "/api/bonus-promo-preview/",
            {
                "bonus_promo_code": "01234",
                "total_amount": "120000",
                "client_phone": "+79000009999",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["redeem_amount"], "12000.00")
        self.assertEqual(response.data["discounted_total_amount"], "108000.00")
        self.assertEqual(response.data["referrer_name"], "Referrer")

    def test_bonus_promo_preview_rejects_code_without_bonus_balance(self):
        api_client = self.auth_client_for(self.manager)
        Client.objects.create(
            workspace=self.manager.workspace,
            name="Empty Referrer",
            phone="+79000004140",
            bonus_balance=Decimal("0.00"),
        )

        response = api_client.post(
            "/api/bonus-promo-preview/",
            {
                "bonus_promo_code": "04140",
                "total_amount": "120000",
                "client_phone": "+79000009999",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("bonus_promo_code", response.data)

    def test_project_delete_without_payments_reverses_promo_debit(self):
        api_client = self.auth_client_for(self.manager)
        referrer = Client.objects.create(
            workspace=self.manager.workspace,
            name="Referrer",
            phone="+79000001234",
            bonus_balance=Decimal("20000.00"),
        )
        create_response = api_client.post(
            "/api/projects/",
            {
                "title": "Referral project",
                "client_name": "New Client",
                "client_phone": "+79000009999",
                "total_amount": "120000",
                "bonus_promo_code": "01234",
            },
            format="json",
        )
        project_id = create_response.data["id"]
        referrer.refresh_from_db()
        self.assertEqual(referrer.bonus_balance, Decimal("8000.00"))

        response = api_client.delete(f"/api/projects/{project_id}/")

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        referrer.refresh_from_db()
        self.assertEqual(referrer.bonus_balance, Decimal("20000.00"))
        self.assertFalse(Project.objects.filter(id=project_id).exists())
        self.assertEqual(
            ClientBonusTransaction.objects.filter(client=referrer, promo_code="01234").count(),
            2,
        )
        self.assertTrue(
            ClientBonusTransaction.objects.filter(
                client=referrer,
                promo_code="01234",
                type=ClientBonusTransaction.Type.PROMO_REFUND,
                amount=Decimal("12000.00"),
            ).exists()
        )

    def test_project_delete_with_payments_is_blocked(self):
        api_client = self.auth_client_for(self.manager)
        project = Project.objects.create(
            manager=self.manager,
            client_name="Paid Project",
            client_phone="+79000009999",
            total_amount=Decimal("120000.00"),
        )
        Payment.objects.create(
            project=project,
            created_by=self.manager,
            amount=Decimal("10000.00"),
            type=Payment.Type.ADVANCE,
        )

        response = api_client.delete(f"/api/projects/{project.id}/")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertTrue(Project.objects.filter(id=project.id).exists())

    def test_project_delete_without_payments_reverses_accrued_bonus(self):
        api_client = self.auth_client_for(self.manager)
        project_client = Client.objects.create(
            workspace=self.manager.workspace,
            name="Bonus Client",
            phone="+79000000003",
            bonus_balance=Decimal("3000.00"),
        )
        project = Project.objects.create(
            manager=self.manager,
            client=project_client,
            client_name=project_client.name,
            client_phone=project_client.phone,
            total_amount=Decimal("100000.00"),
            bonus_accrued_amount=Decimal("3000.00"),
            bonus_accrued_at=timezone.now(),
        )

        response = api_client.delete(f"/api/projects/{project.id}/")

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        project_client.refresh_from_db()
        self.assertEqual(project_client.bonus_balance, Decimal("0.00"))
        self.assertTrue(
            ClientBonusTransaction.objects.filter(
                client=project_client,
                type=ClientBonusTransaction.Type.ACCRUAL_REVERSAL,
                amount=Decimal("-3000.00"),
            ).exists()
        )

    def test_project_create_rejects_promo_without_bonus_as_json_error(self):
        api_client = self.auth_client_for(self.manager)
        Client.objects.create(
            workspace=self.manager.workspace,
            name="Empty Referrer",
            phone="+79000004140",
            bonus_balance=Decimal("0.00"),
        )

        response = api_client.post(
            "/api/projects/",
            {
                "title": "Referral project",
                "client_name": "New Client",
                "client_phone": "+79000009999",
                "total_amount": "120000",
                "bonus_promo_code": "04140",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("bonus_promo_code", response.data)

    def test_project_rejects_unknown_status(self):
        client = self.auth_client_for(self.manager)

        response = client.post(
            "/api/projects/",
            {
                "client_name": "Invalid Status",
                "status": "missing-status",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("status", response.data)


class TestClientApi(AuthenticatedApiMixin, APITestCase):
    def setUp(self):
        self.activate_subscription()
        self.manager = self.create_user("manager.one")
        self.admin = self.create_user("admin.user", role=User.Role.ADMIN)
        self.client_card = Client.objects.create(
            name="Client One",
            phone="+7-000-000-00-01",
            email="one@example.com",
            address="Moscow",
        )

    def test_authenticated_user_can_search_clients(self):
        api_client = self.auth_client_for(self.manager)

        response = api_client.get("/api/clients/?q=000001")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 1)
        self.assertEqual(response.data[0]["id"], self.client_card.id)

    def test_client_contract_flag_is_stored_on_client_card(self):
        api_client = self.auth_client_for(self.manager)

        response = api_client.patch(
            f"/api/clients/{self.client_card.id}/",
            {"works_with_contract": True},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.client_card.refresh_from_db()
        self.assertTrue(self.client_card.works_with_contract)

    def test_client_card_can_be_updated(self):
        api_client = self.auth_client_for(self.manager)

        response = api_client.patch(
            f"/api/clients/{self.client_card.id}/",
            {
                "name": "Updated Client",
                "phone": "+70000000099",
                "email": "updated@example.com",
                "address": "Updated address",
                "works_with_contract": True,
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.client_card.refresh_from_db()
        self.assertEqual(self.client_card.name, "Updated Client")
        self.assertEqual(self.client_card.phone, "+7-000-000-00-99")
        self.assertEqual(self.client_card.email, "updated@example.com")
        self.assertEqual(self.client_card.address, "Updated address")
        self.assertTrue(self.client_card.works_with_contract)

    def test_client_phone_is_normalized(self):
        api_client = self.auth_client_for(self.manager)

        response = api_client.patch(
            f"/api/clients/{self.client_card.id}/",
            {"phone": "8 (900) 000-00-55"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.client_card.refresh_from_db()
        self.assertEqual(self.client_card.phone, "+7-900-000-00-55")

    def test_client_phone_with_duplicated_country_code_is_normalized(self):
        api_client = self.auth_client_for(self.manager)

        response = api_client.patch(
            f"/api/clients/{self.client_card.id}/",
            {"phone": "+7-+7 (900) 000-00-55"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.client_card.refresh_from_db()
        self.assertEqual(self.client_card.phone, "+7-900-000-00-55")

    def test_client_duplicate_phone_returns_field_error(self):
        api_client = self.auth_client_for(self.manager)
        other_client = Client.objects.create(
            workspace=self.client_card.workspace,
            name="Client Two",
            phone="+7-900-000-00-55",
        )

        response = api_client.patch(
            f"/api/clients/{self.client_card.id}/",
            {"phone": other_client.phone},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("phone", response.data)

    def test_client_search_matches_normalized_phone_digits(self):
        self.client_card.phone = "+7-900-123-45-67"
        self.client_card.save(update_fields=["phone"])
        api_client = self.auth_client_for(self.manager)

        for query in ("8900123", "+79001234567", "900-123"):
            response = api_client.get("/api/clients/", {"q": query})

            self.assertEqual(response.status_code, status.HTTP_200_OK)
            self.assertEqual(len(response.data), 1)
            self.assertEqual(response.data[0]["id"], self.client_card.id)

    def test_client_rejects_invalid_phone(self):
        api_client = self.auth_client_for(self.manager)

        response = api_client.patch(
            f"/api/clients/{self.client_card.id}/",
            {"phone": "12345"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("phone", response.data)

    def test_client_update_does_not_overwrite_project_object_address(self):
        project = Project.objects.create(
            manager=self.manager,
            client=self.client_card,
            title="Kitchen",
            client_name=self.client_card.name,
            client_phone=self.client_card.phone,
            object_address="Object address",
        )
        api_client = self.auth_client_for(self.manager)

        response = api_client.patch(
            f"/api/clients/{self.client_card.id}/",
            {
                "name": "Updated Client",
                "phone": "+70000000001",
                "address": "Client address",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        project.refresh_from_db()
        self.assertEqual(project.client_name, "Updated Client")
        self.assertEqual(project.object_address, "Object address")

    def test_client_delete_detaches_existing_projects(self):
        project = Project.objects.create(
            manager=self.manager,
            client=self.client_card,
            title="Kitchen",
            client_name=self.client_card.name,
            client_phone=self.client_card.phone,
        )
        api_client = self.auth_client_for(self.manager)

        response = api_client.delete(f"/api/clients/{self.client_card.id}/")

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        project.refresh_from_db()
        self.assertIsNone(project.client_id)
        self.assertEqual(project.client_name, "Client One")
        self.assertEqual(project.client_phone, "+7-000-000-00-01")


class TestChatSettingsApi(AuthenticatedApiMixin, APITestCase):
    def setUp(self):
        self.activate_subscription()
        self.admin = self.create_user("admin.user", role=User.Role.ADMIN)
        self.manager = self.create_user("manager.user")

    def test_admin_can_update_chat_settings_without_exposing_token(self):
        api_client = self.auth_client_for(self.admin)

        response = api_client.patch(
            "/api/chat-settings/",
            {
                "enabled": True,
                "base_url": "https://chats.cehcrm.ru/",
                "inbox_name": "Основные чаты",
                "account_id": "1",
                "api_access_token": "secret-token",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["base_url"], "https://chats.cehcrm.ru")
        self.assertEqual(response.data["app_url"], "https://chats.cehcrm.ru/app")
        self.assertTrue(response.data["has_api_access_token"])
        self.assertNotIn("api_access_token", response.data)
        self.assertEqual(ChatIntegrationSettings.objects.get(pk=1).api_access_token, "secret-token")

    def test_manager_can_read_but_not_update_chat_settings(self):
        ChatIntegrationSettings.objects.create(enabled=True, base_url="https://chats.cehcrm.ru")
        api_client = self.auth_client_for(self.manager)

        read_response = api_client.get("/api/chat-settings/")
        write_response = api_client.patch("/api/chat-settings/", {"enabled": False}, format="json")

        self.assertEqual(read_response.status_code, status.HTTP_200_OK)
        self.assertEqual(read_response.data["app_url"], "https://chats.cehcrm.ru/app")
        self.assertEqual(write_response.status_code, status.HTTP_403_FORBIDDEN)


class TestPaymentApi(AuthenticatedApiMixin, APITestCase):
    def setUp(self):
        self.activate_subscription()
        self.manager = self.create_user("manager.one")
        self.other_manager = self.create_user("manager.two")
        self.admin = self.create_user("admin.user", role=User.Role.ADMIN)

        self.manager_project = Project.objects.create(
            manager=self.manager,
            client_name="Client One",
            client_phone="+70000000001",
        )
        self.other_project = Project.objects.create(
            manager=self.other_manager,
            client_name="Client Two",
            client_phone="+70000000002",
        )
        self.income_category, _ = FinanceCategory.objects.get_or_create(
            name="Оплата клиента",
            type=FinanceCategory.Type.INCOME,
        )
        self.expense_category, _ = FinanceCategory.objects.get_or_create(
            name="Доставка",
            type=FinanceCategory.Type.EXPENSE,
        )
        self.account, _ = Account.objects.get_or_create(name="Основной счет")

        self.manager_payment = Payment.objects.create(
            project=self.manager_project,
            created_by=self.manager,
            category=self.income_category,
            account=self.account,
            amount="15000.00",
            type=Payment.Type.ADVANCE,
            method=Payment.Method.TRANSFER,
            comment="Own payment",
        )
        self.other_payment = Payment.objects.create(
            project=self.other_project,
            created_by=self.other_manager,
            amount="5000.00",
            type=Payment.Type.ADDITIONAL,
            method=Payment.Method.CARD,
            comment="Other payment",
        )

    def test_manager_sees_only_own_payments(self):
        client = self.auth_client_for(self.manager)

        response = client.get("/api/payments/")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 1)
        self.assertEqual(response.data[0]["id"], self.manager_payment.id)

    def test_admin_sees_all_payments(self):
        client = self.auth_client_for(self.admin)

        response = client.get("/api/payments/")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 2)

    def test_manager_can_create_payment_for_own_project(self):
        client = self.auth_client_for(self.manager)

        response = client.post(
            "/api/payments/",
            {
                "project": self.manager_project.id,
                "created_by": self.other_manager.id,
                "amount": "27500.00",
                "type": Payment.Type.ADVANCE,
                "method": Payment.Method.CASH,
                "category": self.income_category.id,
                "account": self.account.id,
                "comment": "New payment",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data["project"], self.manager_project.id)
        self.assertEqual(response.data["created_by"], self.manager.id)

        created_payment = Payment.objects.get(id=response.data["id"])
        self.assertEqual(created_payment.created_by_id, self.manager.id)
        self.assertEqual(created_payment.category_id, self.income_category.id)
        self.assertEqual(created_payment.account_id, self.account.id)
        self.assertEqual(response.data["category_name"], self.income_category.name)
        self.assertEqual(response.data["category_type"], FinanceCategory.Type.INCOME)
        self.assertEqual(response.data["account_name"], self.account.name)

    def test_bonus_is_accrued_once_after_advance_for_large_project(self):
        project_client = Client.objects.create(
            workspace=self.manager.workspace,
            name="Bonus Client",
            phone="+79000000003",
        )
        project = Project.objects.create(
            manager=self.manager,
            client=project_client,
            client_name=project_client.name,
            client_phone=project_client.phone,
            total_amount=Decimal("100000.00"),
        )
        advance_category, _ = FinanceCategory.objects.get_or_create(
            workspace=self.manager.workspace,
            name="Аванс",
            type=FinanceCategory.Type.INCOME,
        )
        client = self.auth_client_for(self.manager)

        response = client.post(
            "/api/payments/",
            {
                "project": project.id,
                "category": advance_category.id,
                "account": self.account.id,
                "amount": "30000",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        project.refresh_from_db()
        project_client.refresh_from_db()
        self.assertEqual(project.bonus_accrued_amount, Decimal("3000.00"))
        self.assertIsNotNone(project.bonus_accrued_at)
        self.assertEqual(project_client.bonus_balance, Decimal("3000.00"))

        second_response = client.post(
            "/api/payments/",
            {
                "project": project.id,
                "category": advance_category.id,
                "account": self.account.id,
                "amount": "10000",
            },
            format="json",
        )

        self.assertEqual(second_response.status_code, status.HTTP_201_CREATED)
        project_client.refresh_from_db()
        self.assertEqual(project_client.bonus_balance, Decimal("3000.00"))
        self.assertEqual(ClientBonusTransaction.objects.filter(project=project, type=ClientBonusTransaction.Type.ACCRUAL).count(), 1)

    def test_bonus_is_accrued_after_first_income_payment_for_large_project(self):
        project_client = Client.objects.create(
            workspace=self.manager.workspace,
            name="Income Bonus Client",
            phone="+79000000015",
        )
        project = Project.objects.create(
            manager=self.manager,
            client=project_client,
            client_name=project_client.name,
            client_phone=project_client.phone,
            total_amount=Decimal("69465.00"),
        )
        client = self.auth_client_for(self.manager)

        response = client.post(
            "/api/payments/",
            {
                "project": project.id,
                "category": self.income_category.id,
                "account": self.account.id,
                "amount": "30000",
                "comment": "",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        project.refresh_from_db()
        project_client.refresh_from_db()
        self.assertEqual(project.bonus_accrued_amount, Decimal("2083.95"))
        self.assertIsNotNone(project.bonus_accrued_at)
        self.assertEqual(project_client.bonus_balance, Decimal("2083.95"))

    def test_promo_project_accrues_three_percent_after_advance(self):
        referrer = Client.objects.create(
            workspace=self.manager.workspace,
            name="Referrer",
            phone="+79000001234",
            bonus_balance=Decimal("20000.00"),
        )
        advance_category, _ = FinanceCategory.objects.get_or_create(
            workspace=self.manager.workspace,
            name="Аванс",
            type=FinanceCategory.Type.INCOME,
        )
        api_client = self.auth_client_for(self.manager)

        project_response = api_client.post(
            "/api/projects/",
            {
                "title": "Referral project",
                "client_name": "New Client",
                "client_phone": "+79000009999",
                "total_amount": "120000",
                "bonus_promo_code": "01234",
            },
            format="json",
        )

        self.assertEqual(project_response.status_code, status.HTTP_201_CREATED)
        project = Project.objects.get(id=project_response.data["id"])
        project.client.refresh_from_db()
        referrer.refresh_from_db()
        self.assertEqual(referrer.bonus_balance, Decimal("8000.00"))
        self.assertEqual(project.client.bonus_balance, Decimal("0.00"))

        payment_response = api_client.post(
            "/api/payments/",
            {
                "project": project.id,
                "category": advance_category.id,
                "account": self.account.id,
                "amount": "30000",
            },
            format="json",
        )

        self.assertEqual(payment_response.status_code, status.HTTP_201_CREATED)
        project.refresh_from_db()
        project.client.refresh_from_db()
        referrer.refresh_from_db()
        self.assertEqual(referrer.bonus_balance, Decimal("8000.00"))
        self.assertEqual(project.client.bonus_balance, Decimal("3600.00"))
        self.assertEqual(project.referral_bonus_used, Decimal("12000.00"))
        self.assertEqual(project.bonus_accrued_amount, Decimal("3600.00"))
        self.assertEqual(ClientBonusTransaction.objects.filter(project=project, type=ClientBonusTransaction.Type.PROMO_CREDIT).count(), 0)
        self.assertEqual(ClientBonusTransaction.objects.filter(project=project, type=ClientBonusTransaction.Type.ACCRUAL).count(), 1)

    def test_bonus_accrual_is_recalculated_when_project_total_changes(self):
        project_client = Client.objects.create(
            workspace=self.manager.workspace,
            name="Recalculated Bonus Client",
            phone="+79000000016",
        )
        project = Project.objects.create(
            manager=self.manager,
            client=project_client,
            client_name=project_client.name,
            client_phone=project_client.phone,
            total_amount=Decimal("100000.00"),
        )
        api_client = self.auth_client_for(self.manager)

        payment_response = api_client.post(
            "/api/payments/",
            {
                "project": project.id,
                "category": self.income_category.id,
                "account": self.account.id,
                "amount": "30000",
            },
            format="json",
        )
        self.assertEqual(payment_response.status_code, status.HTTP_201_CREATED)
        project_client.refresh_from_db()
        self.assertEqual(project_client.bonus_balance, Decimal("3000.00"))

        project_response = api_client.patch(
            f"/api/projects/{project.id}/",
            {"total_amount": "120000.00"},
            format="json",
        )

        self.assertEqual(project_response.status_code, status.HTTP_200_OK)
        project.refresh_from_db()
        project_client.refresh_from_db()
        self.assertEqual(project.bonus_accrued_amount, Decimal("3600.00"))
        self.assertEqual(project_client.bonus_balance, Decimal("3600.00"))
        self.assertTrue(
            ClientBonusTransaction.objects.filter(
                project=project,
                client=project_client,
                type=ClientBonusTransaction.Type.ACCRUAL,
                amount=Decimal("600.00"),
            ).exists()
        )

    def test_bonus_accrual_is_reversed_when_advance_payment_is_deleted(self):
        project_client = Client.objects.create(
            workspace=self.manager.workspace,
            name="Deleted Advance Bonus Client",
            phone="+79000000017",
        )
        project = Project.objects.create(
            manager=self.manager,
            client=project_client,
            client_name=project_client.name,
            client_phone=project_client.phone,
            total_amount=Decimal("100000.00"),
        )
        api_client = self.auth_client_for(self.manager)
        payment_response = api_client.post(
            "/api/payments/",
            {
                "project": project.id,
                "category": self.income_category.id,
                "account": self.account.id,
                "amount": "30000",
            },
            format="json",
        )
        self.assertEqual(payment_response.status_code, status.HTTP_201_CREATED)

        delete_response = api_client.delete(f"/api/payments/{payment_response.data['id']}/")

        self.assertEqual(delete_response.status_code, status.HTTP_204_NO_CONTENT)
        project.refresh_from_db()
        project_client.refresh_from_db()
        self.assertEqual(project.bonus_accrued_amount, Decimal("0.00"))
        self.assertIsNone(project.bonus_accrued_at)
        self.assertEqual(project_client.bonus_balance, Decimal("0.00"))
        self.assertTrue(
            ClientBonusTransaction.objects.filter(
                project=project,
                client=project_client,
                type=ClientBonusTransaction.Type.ACCRUAL_REVERSAL,
                amount=Decimal("-3000.00"),
            ).exists()
        )

    def test_bonus_accrual_moves_when_project_client_changes(self):
        old_client = Client.objects.create(
            workspace=self.manager.workspace,
            name="Old Bonus Client",
            phone="+79000000018",
        )
        new_client = Client.objects.create(
            workspace=self.manager.workspace,
            name="New Bonus Client",
            phone="+79000000019",
        )
        project = Project.objects.create(
            manager=self.manager,
            client=old_client,
            client_name=old_client.name,
            client_phone=old_client.phone,
            total_amount=Decimal("100000.00"),
        )
        api_client = self.auth_client_for(self.manager)
        payment_response = api_client.post(
            "/api/payments/",
            {
                "project": project.id,
                "category": self.income_category.id,
                "account": self.account.id,
                "amount": "30000",
            },
            format="json",
        )
        self.assertEqual(payment_response.status_code, status.HTTP_201_CREATED)
        old_client.refresh_from_db()
        self.assertEqual(old_client.bonus_balance, Decimal("3000.00"))

        project_response = api_client.patch(
            f"/api/projects/{project.id}/",
            {
                "client": new_client.id,
                "client_name": new_client.name,
                "client_phone": new_client.phone,
            },
            format="json",
        )

        self.assertEqual(project_response.status_code, status.HTTP_200_OK)
        old_client.refresh_from_db()
        new_client.refresh_from_db()
        project.refresh_from_db()
        self.assertEqual(old_client.bonus_balance, Decimal("0.00"))
        self.assertEqual(new_client.bonus_balance, Decimal("3000.00"))
        self.assertEqual(project.client_id, new_client.id)
        self.assertEqual(project.bonus_accrued_amount, Decimal("3000.00"))

    def test_bonus_is_accrued_when_advance_category_has_wrong_type(self):
        project_client = Client.objects.create(
            workspace=self.manager.workspace,
            name="Wrong Type Bonus Client",
            phone="+79000000013",
        )
        project = Project.objects.create(
            manager=self.manager,
            client=project_client,
            client_name=project_client.name,
            client_phone=project_client.phone,
            total_amount=Decimal("100000.00"),
        )
        advance_category, _ = FinanceCategory.objects.get_or_create(
            workspace=self.manager.workspace,
            name="Аванс",
            type=FinanceCategory.Type.EXPENSE,
        )
        client = self.auth_client_for(self.manager)

        response = client.post(
            "/api/payments/",
            {
                "project": project.id,
                "category": advance_category.id,
                "account": self.account.id,
                "amount": "30000",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        project.refresh_from_db()
        project_client.refresh_from_db()
        self.assertEqual(project.bonus_accrued_amount, Decimal("3000.00"))
        self.assertEqual(project_client.bonus_balance, Decimal("3000.00"))

    def test_bonus_is_accrued_when_comment_marks_prepayment(self):
        project_client = Client.objects.create(
            workspace=self.manager.workspace,
            name="Comment Bonus Client",
            phone="+79000000014",
        )
        project = Project.objects.create(
            manager=self.manager,
            client=project_client,
            client_name=project_client.name,
            client_phone=project_client.phone,
            total_amount=Decimal("100000.00"),
        )
        client = self.auth_client_for(self.manager)

        response = client.post(
            "/api/payments/",
            {
                "project": project.id,
                "category": self.income_category.id,
                "account": self.account.id,
                "amount": "30000",
                "comment": "Предоплата по проекту",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        project.refresh_from_db()
        project_client.refresh_from_db()
        self.assertEqual(project.bonus_accrued_amount, Decimal("3000.00"))
        self.assertEqual(project_client.bonus_balance, Decimal("3000.00"))

    def test_bonus_is_accrued_for_project_at_new_threshold(self):
        project_client = Client.objects.create(
            workspace=self.manager.workspace,
            name="Threshold Bonus Client",
            phone="+79000000020",
        )
        project = Project.objects.create(
            manager=self.manager,
            client=project_client,
            client_name=project_client.name,
            client_phone=project_client.phone,
            total_amount=Decimal("30000.00"),
        )
        advance_category, _ = FinanceCategory.objects.get_or_create(
            workspace=self.manager.workspace,
            name="Аванс",
            type=FinanceCategory.Type.INCOME,
        )
        client = self.auth_client_for(self.manager)

        response = client.post(
            "/api/payments/",
            {
                "project": project.id,
                "category": advance_category.id,
                "account": self.account.id,
                "amount": "10000",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        project.refresh_from_db()
        project_client.refresh_from_db()
        self.assertEqual(project.bonus_accrued_amount, Decimal("900.00"))
        self.assertEqual(project_client.bonus_balance, Decimal("900.00"))

    def test_bonus_is_not_accrued_for_project_below_threshold(self):
        project_client = Client.objects.create(
            workspace=self.manager.workspace,
            name="Small Bonus Client",
            phone="+79000000004",
        )
        project = Project.objects.create(
            manager=self.manager,
            client=project_client,
            client_name=project_client.name,
            client_phone=project_client.phone,
            total_amount=Decimal("29999.99"),
        )
        advance_category, _ = FinanceCategory.objects.get_or_create(
            workspace=self.manager.workspace,
            name="Аванс",
            type=FinanceCategory.Type.INCOME,
        )
        client = self.auth_client_for(self.manager)

        response = client.post(
            "/api/payments/",
            {
                "project": project.id,
                "category": advance_category.id,
                "account": self.account.id,
                "amount": "10000",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        project.refresh_from_db()
        project_client.refresh_from_db()
        self.assertEqual(project.bonus_accrued_amount, Decimal("0.00"))
        self.assertEqual(project_client.bonus_balance, Decimal("0.00"))

    def test_bonus_backfill_reconciles_client_by_name(self):
        project_client = Client.objects.create(
            workspace=self.manager.workspace,
            name="Максим",
            phone="+79140707007",
        )
        project = Project.objects.create(
            manager=self.manager,
            client=project_client,
            client_name=project_client.name,
            client_phone=project_client.phone,
            total_amount=Decimal("36938.00"),
        )
        Payment.objects.create(
            project=project,
            created_by=self.manager,
            category=self.income_category,
            account=self.account,
            amount=Decimal("10000.00"),
            type=Payment.Type.ADVANCE,
            method=Payment.Method.TRANSFER,
        )

        output = StringIO()
        call_command("backfill_client_bonuses", client_name="Максим", stdout=output)

        project.refresh_from_db()
        project_client.refresh_from_db()
        self.assertIn("Checked 1 projects, changed bonuses for 1", output.getvalue())
        self.assertEqual(project.bonus_accrued_amount, Decimal("1108.14"))
        self.assertEqual(project_client.bonus_balance, Decimal("1108.14"))

    def test_manager_can_read_finance_settings(self):
        client = self.auth_client_for(self.manager)

        category_response = client.get("/api/finance-categories/")
        account_response = client.get("/api/accounts/")

        self.assertEqual(category_response.status_code, status.HTTP_200_OK)
        self.assertEqual(account_response.status_code, status.HTTP_200_OK)
        category_keys = {(item["name"], item["type"]) for item in category_response.data}
        account_names = {item["name"] for item in account_response.data}
        self.assertIn((self.income_category.name, self.income_category.type), category_keys)
        self.assertIn(self.account.name, account_names)

    def test_project_finance_analytics_confirms_profitable_closed_project(self):
        project = Project.objects.create(
            manager=self.manager,
            client_name="Analytics Client",
            client_phone="+79000002100",
            total_amount=Decimal("100000.00"),
        )
        categories = {
            "delivery": FinanceCategory.objects.get_or_create(
                workspace=self.manager.workspace,
                name="Доставка",
                type=FinanceCategory.Type.EXPENSE,
            )[0],
            "contractors": FinanceCategory.objects.get_or_create(
                workspace=self.manager.workspace,
                name="Оплата контрагентам",
                type=FinanceCategory.Type.EXPENSE,
            )[0],
            "calculations": FinanceCategory.objects.get_or_create(
                workspace=self.manager.workspace,
                name="Расчеты",
                type=FinanceCategory.Type.EXPENSE,
            )[0],
            "components": FinanceCategory.objects.get_or_create(
                workspace=self.manager.workspace,
                name="Комплектующие",
                type=FinanceCategory.Type.EXPENSE,
            )[0],
        }
        Payment.objects.create(
            project=project,
            created_by=self.manager,
            category=self.income_category,
            account=self.account,
            amount=Decimal("100000.00"),
            type=Payment.Type.ADVANCE,
        )
        for category_key, amount in (
            ("delivery", "5000.00"),
            ("contractors", "10000.00"),
            ("calculations", "2000.00"),
            ("components", "20000.00"),
        ):
            Payment.objects.create(
                project=project,
                created_by=self.manager,
                category=categories[category_key],
                account=self.account,
                amount=Decimal(amount),
                type=Payment.Type.CORRECTION,
            )

        client = self.auth_client_for(self.manager)
        response = client.get(f"/api/projects/{project.id}/finance-analytics/")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertTrue(response.data["paid_in_full"])
        self.assertTrue(response.data["should_review"])
        self.assertFalse(response.data["low_margin"])
        self.assertEqual(response.data["margin_percent"], "63.00")
        self.assertEqual(response.data["missing_required_expenses"], [])

    def test_project_finance_analytics_warns_about_missing_expenses_and_low_margin(self):
        project = Project.objects.create(
            manager=self.manager,
            client_name="Risk Client",
            client_phone="+79000002101",
            total_amount=Decimal("100000.00"),
        )
        component_category, _ = FinanceCategory.objects.get_or_create(
            workspace=self.manager.workspace,
            name="Комплектующие",
            type=FinanceCategory.Type.EXPENSE,
        )
        Payment.objects.create(
            project=project,
            created_by=self.manager,
            category=self.income_category,
            account=self.account,
            amount=Decimal("100000.00"),
            type=Payment.Type.ADVANCE,
        )
        Payment.objects.create(
            project=project,
            created_by=self.manager,
            category=component_category,
            account=self.account,
            amount=Decimal("80000.00"),
            type=Payment.Type.CORRECTION,
        )

        client = self.auth_client_for(self.manager)
        response = client.get(f"/api/projects/{project.id}/finance-analytics/")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertTrue(response.data["paid_in_full"])
        self.assertTrue(response.data["low_margin"])
        self.assertTrue(response.data["needs_attention"])
        self.assertEqual(response.data["margin_percent"], "20.00")
        self.assertIn("Доставка", response.data["missing_required_expenses"])
        self.assertIn("Контрагенты", response.data["missing_required_expenses"])
        self.assertIn("Расчеты", response.data["missing_required_expenses"])
        self.assertNotIn("Комплектующие", response.data["missing_required_expenses"])

    def test_finance_analytics_summary_counts_operations_and_risky_projects(self):
        project = Project.objects.create(
            manager=self.manager,
            client_name="Summary Client",
            client_phone="+79000002102",
            total_amount=Decimal("100000.00"),
        )
        component_category, _ = FinanceCategory.objects.get_or_create(
            workspace=self.manager.workspace,
            name="Комплектующие",
            type=FinanceCategory.Type.EXPENSE,
        )
        Payment.objects.create(
            project=project,
            created_by=self.manager,
            category=self.income_category,
            account=self.account,
            amount=Decimal("100000.00"),
            type=Payment.Type.ADVANCE,
        )
        Payment.objects.create(
            project=project,
            created_by=self.manager,
            category=component_category,
            account=self.account,
            amount=Decimal("80000.00"),
            type=Payment.Type.CORRECTION,
        )
        client = self.auth_client_for(self.manager)

        response = client.get("/api/finance-analytics/", {"project": project.id})

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["summary"]["income_total"], "100000.00")
        self.assertEqual(response.data["summary"]["expense_total"], "80000.00")
        self.assertEqual(response.data["summary"]["margin_percent"], "20.00")
        self.assertEqual(response.data["summary"]["at_risk_project_count"], 1)
        self.assertEqual(response.data["at_risk_projects"][0]["id"], project.id)

    @patch("crm_app.views.GeminiClient")
    def test_finance_analytics_ai_uses_gemini(self, mocked_client_class):
        project = Project.objects.create(
            manager=self.manager,
            client_name="AI Finance Client",
            client_phone="+79000002103",
            total_amount=Decimal("50000.00"),
        )
        Payment.objects.create(
            project=project,
            created_by=self.manager,
            category=self.income_category,
            account=self.account,
            amount=Decimal("50000.00"),
            type=Payment.Type.ADVANCE,
        )
        mocked_client = mocked_client_class.return_value
        mocked_client.fast_model = "gemini-fast"
        mocked_client.generate_content.return_value = {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {"text": "Маржа в норме, но проверьте расходники."},
                        ]
                    }
                }
            ]
        }
        mocked_client.extract_candidate_content.side_effect = GeminiClient.extract_candidate_content
        mocked_client.extract_text.side_effect = GeminiClient.extract_text
        client = self.auth_client_for(self.admin)

        response = client.post("/api/finance-analytics/ai/", {"project": project.id}, format="json")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertIn("Маржа", response.data["analysis"])
        mocked_client.generate_content.assert_called_once()

    def test_manager_can_update_own_payment(self):
        client = self.auth_client_for(self.manager)

        response = client.patch(
            f"/api/payments/{self.manager_payment.id}/",
            {
                "amount": "22000.00",
                "comment": "Updated payment",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.manager_payment.refresh_from_db()
        self.assertEqual(str(self.manager_payment.amount), "22000.00")
        self.assertEqual(self.manager_payment.comment, "Updated payment")

    def test_manager_can_delete_own_payment(self):
        client = self.auth_client_for(self.manager)

        response = client.delete(f"/api/payments/{self.manager_payment.id}/")

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Payment.objects.filter(id=self.manager_payment.id).exists())

    def test_manager_cannot_create_payment_for_foreign_project(self):
        client = self.auth_client_for(self.manager)

        response = client.post(
            "/api/payments/",
            {
                "project": self.other_project.id,
                "amount": "27500.00",
                "type": Payment.Type.ADVANCE,
                "method": Payment.Method.CASH,
                "comment": "Should be rejected",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("project", response.data)
        self.assertEqual(
            Payment.objects.filter(project=self.other_project, comment="Should be rejected").count(),
            0,
        )


class TestTaskApi(AuthenticatedApiMixin, APITestCase):
    def setUp(self):
        self.activate_subscription()
        self.manager = self.create_user("manager.one")
        self.other_manager = self.create_user("manager.two")
        self.admin = self.create_user("admin.user", role=User.Role.ADMIN)

        self.manager_project = Project.objects.create(
            title="Manager project",
            manager=self.manager,
            client_name="Client One",
            client_phone="+79000000001",
        )
        self.other_project = Project.objects.create(
            title="Other project",
            manager=self.other_manager,
            client_name="Client Two",
            client_phone="+79000000002",
        )

        self.manager_task = Task.objects.create(
            title="Manager task",
            due_date="2026-05-25",
            status=Task.Status.OPEN,
            assignee=self.manager,
            created_by=self.manager,
        )
        self.other_task = Task.objects.create(
            title="Other task",
            due_date="2026-05-26",
            status=Task.Status.OPEN,
            assignee=self.other_manager,
            created_by=self.other_manager,
        )

    def test_manager_sees_only_own_tasks(self):
        client = self.auth_client_for(self.manager)

        response = client.get("/api/tasks/")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 1)
        self.assertEqual(response.data[0]["id"], self.manager_task.id)

    def test_admin_sees_all_tasks(self):
        client = self.auth_client_for(self.admin)

        response = client.get("/api/tasks/")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 2)

    def test_manager_can_create_task_for_self(self):
        client = self.auth_client_for(self.manager)

        response = client.post(
            "/api/tasks/",
            {
                "title": "Call client",
                "notes": "Need to confirm measurements",
                "due_date": "2026-05-27",
                "priority": Task.Priority.HIGH,
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data["assignee"], self.manager.id)
        self.assertEqual(response.data["created_by"], self.manager.id)

    def test_manager_can_create_task_for_own_project(self):
        client = self.auth_client_for(self.manager)

        response = client.post(
            "/api/tasks/",
            {
                "title": "Project follow-up",
                "project": self.manager_project.id,
                "notes": "Call client after measurements",
                "due_date": "2026-05-28",
                "priority": Task.Priority.HIGH,
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data["project"], self.manager_project.id)
        self.assertEqual(response.data["project_title"], self.manager_project.title)
        self.assertEqual(Task.objects.get(id=response.data["id"]).project_id, self.manager_project.id)

    def test_manager_cannot_create_task_for_foreign_project(self):
        client = self.auth_client_for(self.manager)

        response = client.post(
            "/api/tasks/",
            {
                "title": "Forbidden project task",
                "project": self.other_project.id,
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("project", response.data)
        self.assertEqual(Task.objects.filter(title="Forbidden project task").count(), 0)

    def test_manager_cannot_assign_task_to_other_user(self):
        client = self.auth_client_for(self.manager)

        response = client.post(
            "/api/tasks/",
            {
                "title": "Forbidden assign",
                "assignee": self.other_manager.id,
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("assignee", response.data)

    def test_task_can_be_marked_done(self):
        client = self.auth_client_for(self.manager)

        response = client.patch(
            f"/api/tasks/{self.manager_task.id}/",
            {"status": Task.Status.DONE},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.manager_task.refresh_from_db()
        self.assertEqual(self.manager_task.status, Task.Status.DONE)


class TestAdminUsersApi(AuthenticatedApiMixin, APITestCase):
    def setUp(self):
        self.activate_subscription()
        self.admin = self.create_user("admin.user", role=User.Role.ADMIN)
        self.manager = self.create_user("manager.user")

    def test_admin_can_list_users(self):
        client = self.auth_client_for(self.admin)

        response = client.get("/api/users/")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 2)

    def test_manager_cannot_list_users(self):
        client = self.auth_client_for(self.manager)

        response = client.get("/api/users/")

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_admin_can_create_manager_user(self):
        client = self.auth_client_for(self.admin)

        response = client.post(
            "/api/users/",
            {
                "username": "new.manager",
                "password": "StrongPass123!",
                "role": User.Role.MANAGER,
                "first_name": "New",
                "last_name": "Manager",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data["username"], "new.manager")
        self.assertTrue(User.objects.filter(username="new.manager").exists())


class TestProjectCommentsApi(AuthenticatedApiMixin, APITestCase):
    def setUp(self):
        self.activate_subscription()
        self.manager = self.create_user("manager.one")
        self.other_manager = self.create_user("manager.two")
        self.admin = self.create_user("admin.user", role=User.Role.ADMIN)

        self.manager_project = Project.objects.create(
            manager=self.manager,
            client_name="Client One",
            client_phone="+70000000001",
        )
        self.other_project = Project.objects.create(
            manager=self.other_manager,
            client_name="Client Two",
            client_phone="+70000000002",
        )

        self.manager_comment = ProjectComment.objects.create(
            project=self.manager_project,
            author=self.manager,
            text="Own comment",
        )
        self.other_comment = ProjectComment.objects.create(
            project=self.other_project,
            author=self.other_manager,
            text="Other comment",
        )

    def test_manager_sees_only_own_comments(self):
        client = self.auth_client_for(self.manager)

        response = client.get("/api/project-comments/")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 1)
        self.assertEqual(response.data[0]["id"], self.manager_comment.id)

    def test_admin_sees_all_comments(self):
        client = self.auth_client_for(self.admin)

        response = client.get("/api/project-comments/")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 2)

    def test_manager_can_filter_comments_by_project(self):
        client = self.auth_client_for(self.manager)

        response = client.get(f"/api/project-comments/?project={self.manager_project.id}")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 1)
        self.assertEqual(response.data[0]["project"], self.manager_project.id)

    def test_manager_can_create_comment_for_own_project(self):
        client = self.auth_client_for(self.manager)

        response = client.post(
            "/api/project-comments/",
            {
                "project": self.manager_project.id,
                "text": "Fresh note",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data["author"], self.manager.id)
        self.assertEqual(response.data["author_name"], self.manager.username)

    def test_manager_cannot_create_comment_for_foreign_project(self):
        client = self.auth_client_for(self.manager)

        response = client.post(
            "/api/project-comments/",
            {
                "project": self.other_project.id,
                "text": "Should be rejected",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("project", response.data)
        self.assertFalse(ProjectComment.objects.filter(text="Should be rejected").exists())

    def test_manager_can_update_own_comment(self):
        client = self.auth_client_for(self.manager)

        response = client.patch(
            f"/api/project-comments/{self.manager_comment.id}/",
            {"text": "Updated comment"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["text"], "Updated comment")
        self.manager_comment.refresh_from_db()
        self.assertEqual(self.manager_comment.text, "Updated comment")

    def test_manager_cannot_update_foreign_comment(self):
        client = self.auth_client_for(self.manager)

        response = client.patch(
            f"/api/project-comments/{self.other_comment.id}/",
            {"text": "Should be rejected"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.other_comment.refresh_from_db()
        self.assertEqual(self.other_comment.text, "Other comment")

    def test_blank_comment_is_rejected(self):
        client = self.auth_client_for(self.manager)

        response = client.patch(
            f"/api/project-comments/{self.manager_comment.id}/",
            {"text": "   "},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("text", response.data)


class TestProjectStatusesApi(AuthenticatedApiMixin, APITestCase):
    def setUp(self):
        self.activate_subscription()
        self.active_status, _ = ProjectStatus.objects.get_or_create(
            code="active",
            defaults={"name": "В работе", "short_name": "Работа", "color": "sky", "sort_order": 10, "is_default": True},
        )
        self.closed_status, _ = ProjectStatus.objects.get_or_create(
            code="closed",
            defaults={"name": "Завершено", "short_name": "Готово", "color": "emerald", "sort_order": 20, "is_default": False},
        )
        self.manager = self.create_user("manager.one")
        self.admin = self.create_user("admin.user", role=User.Role.ADMIN)

    def test_authenticated_user_can_list_statuses(self):
        client = self.auth_client_for(self.manager)

        response = client.get("/api/project-statuses/")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertGreaterEqual(len(response.data), 2)
        codes = {item["code"] for item in response.data}
        self.assertIn("active", codes)
        self.assertIn("closed", codes)

    def test_admin_can_create_project_status(self):
        client = self.auth_client_for(self.admin)

        response = client.post(
            "/api/project-statuses/",
            {
                "code": "installation",
                "name": "Монтаж",
                "short_name": "Монтаж",
                "color": "amber",
                "sort_order": 30,
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data["code"], "installation")
        self.assertTrue(ProjectStatus.objects.filter(code="installation").exists())

    def test_manager_cannot_create_project_status(self):
        client = self.auth_client_for(self.manager)

        response = client.post(
            "/api/project-statuses/",
            {
                "code": "installation",
                "name": "Монтаж",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_cannot_delete_status_used_in_project(self):
        Project.objects.create(
            manager=self.admin,
            client_name="Busy Project",
            client_phone="+70000000009",
            status=self.active_status.code,
        )
        client = self.auth_client_for(self.admin)

        response = client.delete(f"/api/project-statuses/{self.active_status.id}/")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertTrue(ProjectStatus.objects.filter(id=self.active_status.id).exists())


class TestAssistantApi(AuthenticatedApiMixin, APITestCase):
    def make_function_call_response(self, name, args, call_id="call-1"):
        return {
            "candidates": [
                {
                    "content": {
                        "role": "model",
                        "parts": [
                            {
                                "functionCall": {
                                    "id": call_id,
                                    "name": name,
                                    "args": args,
                                }
                            }
                        ],
                    }
                }
            ]
        }

    def make_text_response(self, text):
        return {
            "candidates": [
                {
                    "content": {
                        "role": "model",
                        "parts": [{"text": text}],
                    }
                }
            ]
        }

    def make_empty_content_response(self, finish_reason="STOP"):
        return {
            "candidates": [
                {
                    "finishReason": finish_reason,
                }
            ]
        }

    def setUp(self):
        self.activate_subscription()
        self.admin = self.create_user("admin.user", role=User.Role.ADMIN)
        self.manager = self.create_user("manager.user")
        self.project_status = ProjectStatus.objects.create(
            code="design",
            name="Проектирование",
            short_name="Проект",
            color="violet",
            sort_order=10,
            is_default=True,
        )
        self.project = Project.objects.create(
            manager=self.admin,
            client_name="Тестовый клиент",
            client_phone="+70000000001",
            status=self.project_status.code,
        )

    def test_returns_service_unavailable_without_gemini_key(self):
        previous_key = os.environ.pop("GEMINI_API_KEY", None)
        previous_backend = os.environ.get("GEMINI_BACKEND")
        os.environ["GEMINI_BACKEND"] = "google_ai"
        client = self.auth_client_for(self.admin)

        try:
            response = client.post(
                "/api/assistant/chat/",
                {"message": "\u0420\u0430\u0441\u0441\u043a\u0430\u0436\u0438, \u043a\u0430\u043a \u043b\u0443\u0447\u0448\u0435 \u0432\u0435\u0441\u0442\u0438 CRM?"},
                format="json",
            )
        finally:
            if previous_key:
                os.environ["GEMINI_API_KEY"] = previous_key
            if previous_backend:
                os.environ["GEMINI_BACKEND"] = previous_backend
            else:
                os.environ.pop("GEMINI_BACKEND", None)

        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)

    @patch("crm_app.ai_assistant.GeminiClient.generate_content")
    def test_assistant_fast_lists_work_projects_without_gemini_roundtrip(self, mocked_generate_content):
        os.environ["GEMINI_BACKEND"] = "google_ai"
        os.environ["GEMINI_API_KEY"] = "test-key"
        client = self.auth_client_for(self.admin)

        response = client.post(
            "/api/assistant/chat/",
            {"message": "\u041a\u0430\u043a\u0438\u0435 \u043f\u0440\u043e\u0435\u043a\u0442\u044b \u0432 \u0440\u0430\u0431\u043e\u0442\u0435?"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["intent"], "list_projects_fast")
        self.assertIn(self.project.client_name, response.data["reply"])
        self.assertEqual(response.data["data"]["source"], "crm_fast_path")
        mocked_generate_content.assert_not_called()

    @patch("crm_app.ai_assistant.GeminiClient.generate_content")
    def test_assistant_fast_greeting_without_gemini_roundtrip(self, mocked_generate_content):
        os.environ["GEMINI_BACKEND"] = "google_ai"
        os.environ["GEMINI_API_KEY"] = "test-key"
        client = self.auth_client_for(self.admin)

        response = client.post(
            "/api/assistant/chat/",
            {"message": "\u041f\u0440\u0438\u0432\u0435\u0442"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["intent"], "greeting_fast")
        self.assertEqual(response.data["data"]["source"], "crm_fast_path")
        mocked_generate_content.assert_not_called()

    @patch("crm_app.ai_assistant.GeminiClient.generate_content")
    def test_assistant_clarifies_vague_financial_operation_without_gemini_roundtrip(self, mocked_generate_content):
        os.environ["GEMINI_BACKEND"] = "google_ai"
        os.environ["GEMINI_API_KEY"] = "test-key"
        client = self.auth_client_for(self.admin)

        response = client.post(
            "/api/assistant/chat/",
            {"message": "Создай финансовую операцию"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["intent"], "clarify_create_financial_operation_fast")
        self.assertTrue(response.data["needs_clarification"])
        self.assertIn("проект", response.data["reply"].lower())
        self.assertIn("сумма", response.data["reply"].lower())
        self.assertEqual(response.data["data"]["source"], "crm_fast_path")
        mocked_generate_content.assert_not_called()

    @patch("crm_app.ai_assistant.GeminiClient.generate_content")
    def test_assistant_clarifies_vague_project_creation_without_gemini_roundtrip(self, mocked_generate_content):
        os.environ["GEMINI_BACKEND"] = "google_ai"
        os.environ["GEMINI_API_KEY"] = "test-key"
        client = self.auth_client_for(self.admin)

        response = client.post(
            "/api/assistant/chat/",
            {"message": "Давай создадим проект"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["intent"], "clarify_create_project_fast")
        self.assertTrue(response.data["needs_clarification"])
        self.assertIn("клиент", response.data["reply"].lower())
        mocked_generate_content.assert_not_called()

    @patch("crm_app.ai_assistant.GeminiClient.generate_content")
    def test_assistant_can_create_task(self, mocked_generate_content):
        os.environ["GEMINI_BACKEND"] = "google_ai"
        os.environ["GEMINI_API_KEY"] = "test-key"
        mocked_generate_content.side_effect = [
            self.make_function_call_response(
                "create_task",
                {
                    "title": "Позвонить клиенту",
                    "notes": "Уточнить дату замера",
                    "due_date": "2026-05-26",
                    "assignee_name": "manager.user",
                },
            ),
            self.make_text_response("Создал задачу «Позвонить клиенту» и назначил её на manager.user."),
        ]
        client = self.auth_client_for(self.admin)

        response = client.post(
            "/api/assistant/chat/",
            {"message": "Поставь задачу менеджеру manager.user позвонить клиенту завтра"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["intent"], "create_task")
        self.assertTrue(Task.objects.filter(title="Позвонить клиенту", assignee=self.manager).exists())
        self.assertEqual(response.data["data"]["tool_calls"][0]["name"], "create_task")
        self.assertEqual(response.data["reply"], "Готово, задача создана.")

    @patch("crm_app.ai_assistant.GeminiClient.generate_content")
    def test_assistant_does_not_fake_task_creation_without_tool_call(self, mocked_generate_content):
        os.environ["GEMINI_BACKEND"] = "google_ai"
        os.environ["GEMINI_API_KEY"] = "test-key"
        mocked_generate_content.side_effect = [
            self.make_text_response("Да, хорошо, сейчас создам задачу."),
            self.make_function_call_response(
                "create_task",
                {
                    "title": "Проверить договор",
                    "notes": "Создано после принудительного tool-call.",
                    "assignee_name": "manager.user",
                },
            ),
        ]
        client = self.auth_client_for(self.admin)

        response = client.post(
            "/api/assistant/chat/",
            {"message": "Поставь задачу менеджеру manager.user проверить договор"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["reply"], "Готово, задача создана.")
        self.assertEqual(response.data["intent"], "create_task")
        self.assertTrue(Task.objects.filter(title="Проверить договор", assignee=self.manager).exists())
        self.assertEqual(mocked_generate_content.call_count, 2)

    @patch("crm_app.ai_assistant.GeminiClient.generate_content")
    def test_assistant_can_create_financial_operation(self, mocked_generate_content):
        os.environ["GEMINI_BACKEND"] = "google_ai"
        os.environ["GEMINI_API_KEY"] = "test-key"
        mocked_generate_content.side_effect = [
            self.make_function_call_response(
                "create_financial_operation",
                {
                    "project_id": self.project.id,
                    "amount": 25000,
                    "payment_type": "advance",
                    "payment_method": "transfer",
                    "comment": "Аванс по проекту",
                },
            ),
            self.make_text_response("Добавил финансовую операцию 25 000 ₽ по проекту."),
        ]
        client = self.auth_client_for(self.admin)

        response = client.post(
            "/api/assistant/chat/",
            {"message": "Добавь аванс 25000 по тестовому клиенту"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["intent"], "create_financial_operation")
        self.assertTrue(
            Payment.objects.filter(
                project=self.project,
                amount="25000.00",
                type=Payment.Type.ADVANCE,
                method=Payment.Method.TRANSFER,
                comment="Аванс по проекту",
            ).exists()
        )
        self.assertEqual(response.data["data"]["tool_calls"][0]["name"], "create_financial_operation")

    @patch("crm_app.ai_assistant.GeminiClient.generate_content")
    def test_assistant_retries_empty_gemini_content(self, mocked_generate_content):
        os.environ["GEMINI_BACKEND"] = "google_ai"
        os.environ["GEMINI_API_KEY"] = "test-key"
        mocked_generate_content.side_effect = [
            self.make_empty_content_response(),
            self.make_text_response("По проекту всё в работе."),
        ]
        client = self.auth_client_for(self.admin)

        response = client.post(
            "/api/assistant/chat/",
            {"message": "Расскажи кратко по текущему проекту"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["reply"], "По проекту всё в работе.")
        self.assertEqual(mocked_generate_content.call_count, 2)

    @patch("crm_app.ai_assistant.GeminiClient.generate_content")
    def test_assistant_returns_safe_reply_when_empty_gemini_content_repeats(self, mocked_generate_content):
        os.environ["GEMINI_BACKEND"] = "google_ai"
        os.environ["GEMINI_API_KEY"] = "test-key"
        mocked_generate_content.side_effect = [
            self.make_empty_content_response(),
            self.make_empty_content_response(),
        ]
        client = self.auth_client_for(self.admin)

        response = client.post(
            "/api/assistant/chat/",
            {"message": "Поменяй статус тестового клиента на монтаж"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertIn("Уточните", response.data["reply"])
        self.assertEqual(mocked_generate_content.call_count, 2)

    @patch("crm_app.ai_assistant.GeminiClient.generate_content")
    def test_assistant_can_analyze_project_and_create_tasks(self, mocked_generate_content):
        os.environ["GEMINI_BACKEND"] = "google_ai"
        os.environ["GEMINI_API_KEY"] = "test-key"
        mocked_generate_content.side_effect = [
            self.make_function_call_response(
                "create_project_tasks_from_analysis",
                {
                    "project_id": self.project.id,
                    "assignee_name": "manager.user",
                    "tasks": [
                        {
                            "title": "Уточнить готовность замера",
                            "notes": "Gemini выделил это как ближайший шаг по проекту.",
                            "due_date": "2026-05-27",
                            "priority": "high",
                        },
                        {
                            "title": "Подготовить КП",
                            "notes": "После уточнения данных подготовить предложение.",
                            "due_date": "2026-05-28",
                            "priority": "medium",
                        },
                    ],
                },
            ),
            self.make_text_response("Проанализировал проект и создал 2 задачи."),
        ]
        client = self.auth_client_for(self.admin)

        response = client.post(
            "/api/assistant/chat/",
            {"message": "Проанализируй проект Тестовый клиент и сам создай по нему задачи"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["intent"], "create_project_tasks_from_analysis")
        self.assertEqual(Task.objects.filter(assignee=self.manager).count(), 2)
        self.assertTrue(Task.objects.filter(title="Уточнить готовность замера").exists())
        self.assertEqual(Task.objects.filter(project=self.project).count(), 2)
        self.assertIn(f"#{self.project.id}", Task.objects.get(title="Подготовить КП").notes)

    @patch("crm_app.ai_assistant.GeminiClient.generate_content")
    def test_assistant_can_list_projects(self, mocked_generate_content):
        os.environ["GEMINI_BACKEND"] = "google_ai"
        os.environ["GEMINI_API_KEY"] = "test-key"
        mocked_generate_content.side_effect = [
            self.make_function_call_response(
                "list_projects",
                {
                    "status_name": "Проектирование",
                    "include_payments": True,
                    "include_comments": True,
                },
            ),
            self.make_text_response("Сейчас на проектировании 1 проект: Тестовый клиент."),
        ]
        client = self.auth_client_for(self.admin)

        response = client.post(
            "/api/assistant/chat/",
            {"message": "Какие проекты сейчас на проектировании?"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["intent"], "list_projects")
        self.assertIn("Тестовый клиент", response.data["reply"])
        self.assertEqual(response.data["data"]["tool_calls"][0]["result"]["count"], 1)

    @patch("crm_app.ai_assistant.GeminiClient.generate_speech")
    @patch("crm_app.ai_assistant.GeminiClient.transcribe_audio")
    @patch("crm_app.ai_assistant.GeminiClient.generate_content")
    def test_voice_endpoint_uses_gemini_voice_pipeline(
        self,
        mocked_generate_content,
        mocked_transcribe_audio,
        mocked_generate_speech,
    ):
        os.environ["GEMINI_BACKEND"] = "google_ai"
        os.environ["GEMINI_API_KEY"] = "test-key"
        mocked_transcribe_audio.return_value = "Какие проекты сейчас на проектировании?"
        mocked_generate_content.side_effect = [
            self.make_function_call_response(
                "list_projects",
                {
                    "status_name": "Проектирование",
                    "include_payments": True,
                    "include_comments": True,
                },
            ),
            self.make_text_response("Сейчас на проектировании 1 проект: Тестовый клиент."),
        ]
        mocked_generate_speech.return_value = {
            "audio_bytes": b"RIFFdemo",
            "mime_type": "audio/wav",
            "voice_name": "Kore",
        }

        client = self.auth_client_for(self.admin)
        response = client.post(
            "/api/assistant/voice/",
            {
                "audio": SimpleUploadedFile("voice-command.wav", b"fake-wav-data", content_type="audio/wav"),
                "history": "[]",
            },
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["transcript"], "Какие проекты сейчас на проектировании?")
        self.assertEqual(response.data["audio_mime_type"], "audio/wav")
        self.assertEqual(response.data["voice_name"], "Kore")
        self.assertTrue(response.data["audio_base64"])

    @patch("crm_app.ai_assistant.GeminiClient.generate_speech")
    @patch("crm_app.ai_assistant.GeminiClient.transcribe_audio")
    @patch("crm_app.ai_assistant.GeminiClient.generate_content")
    def test_voice_endpoint_keeps_text_reply_when_tts_fails(
        self,
        mocked_generate_content,
        mocked_transcribe_audio,
        mocked_generate_speech,
    ):
        os.environ["GEMINI_BACKEND"] = "google_ai"
        os.environ["GEMINI_API_KEY"] = "test-key"
        mocked_transcribe_audio.return_value = "Привет"
        mocked_generate_content.return_value = self.make_text_response("Приветствую, я слушаю вас.")
        mocked_generate_speech.side_effect = GeminiRequestError("Gemini TTS test error")

        client = self.auth_client_for(self.admin)
        response = client.post(
            "/api/assistant/voice/",
            {
                "audio": SimpleUploadedFile("voice-command.wav", b"fake-wav-data", content_type="audio/wav"),
                "history": "[]",
            },
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["reply"], "Здравствуйте. Слушаю вас.")
        self.assertEqual(response.data["audio_base64"], "")
        self.assertIn("Gemini TTS test error", response.data["speech_error"])

    @patch("crm_app.ai_assistant.GeminiClient.generate_speech")
    @patch("crm_app.ai_assistant.GeminiClient.transcribe_audio")
    @patch("crm_app.ai_assistant.GeminiClient.generate_content")
    def test_voice_endpoint_can_skip_audio_generation(
        self,
        mocked_generate_content,
        mocked_transcribe_audio,
        mocked_generate_speech,
    ):
        os.environ["GEMINI_BACKEND"] = "google_ai"
        os.environ["GEMINI_API_KEY"] = "test-key"
        mocked_transcribe_audio.return_value = "Привет"
        mocked_generate_content.return_value = self.make_text_response("Здравствуйте. Слушаю вас.")

        client = self.auth_client_for(self.admin)
        response = client.post(
            "/api/assistant/voice/",
            {
                "audio": SimpleUploadedFile("voice-command.wav", b"fake-wav-data", content_type="audio/wav"),
                "history": "[]",
                "include_audio": "0",
            },
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["reply"], "Здравствуйте. Слушаю вас.")
        self.assertEqual(response.data["audio_base64"], "")
        self.assertEqual(response.data["speech_error"], "")
        mocked_generate_speech.assert_not_called()


class TestLowLatencyAssistant(AuthenticatedApiMixin, APITestCase):
    def setUp(self):
        self.user = self.create_user("voice.manager")
        ProjectStatus.objects.create(
            code="design",
            name="Проектирование",
            short_name="Проект",
            color="violet",
            sort_order=10,
            is_default=True,
        )
        FinanceCategory.objects.get_or_create(name="Аванс", type=FinanceCategory.Type.INCOME)
        FinanceCategory.objects.get_or_create(name="Доставка", type=FinanceCategory.Type.EXPENSE)

    def test_live_consumer_does_not_duplicate_audio_from_same_message(self):
        class FakeInlineData:
            data = b"inline-audio"
            mime_type = "audio/pcm;rate=24000"

        class FakePart:
            inline_data = FakeInlineData()
            text = None

        class FakeModelTurn:
            parts = [FakePart()]

        class FakeServerContent:
            model_turn = FakeModelTurn()
            input_transcription = None
            output_transcription = None
            interrupted = False
            turn_complete = False

        class FakeMessage:
            server_content = FakeServerContent()
            data = b"top-level-audio"
            text = None
            tool_call = None

        class FakeSession:
            async def receive(self):
                yield FakeMessage()

        consumer = AssistantLiveConsumer()
        consumer.turn_metrics = consumer._new_turn_metrics()
        sent_events = []

        async def fake_send(bytes_data=None, text_data=None):
            if text_data:
                sent_events.append(json.loads(text_data))

        consumer.send = fake_send

        async_to_sync(consumer._receive_from_gemini)(FakeSession(), None, None)

        audio_events = [event for event in sent_events if event["type"] == "assistant_audio"]
        self.assertEqual(len(audio_events), 1)
        self.assertEqual(audio_events[0]["format"], "pcm16")
        self.assertEqual(audio_events[0]["sampleRate"], 24000)
        self.assertEqual(base64.b64decode(audio_events[0]["data"]), b"inline-audio")

    def test_live_consumer_forwards_top_level_audio_as_pcm_event(self):
        class FakeMessage:
            setup_complete = None
            server_content = None
            data = b"top-level-audio"
            text = None
            tool_call = None
            tool_call_cancellation = None
            go_away = None
            session_resumption_update = None

        class FakeSession:
            async def receive(self):
                yield FakeMessage()

        consumer = AssistantLiveConsumer()
        consumer.turn_metrics = consumer._new_turn_metrics()
        sent_events = []

        async def fake_send(bytes_data=None, text_data=None):
            if text_data:
                sent_events.append(json.loads(text_data))

        consumer.send = fake_send

        async_to_sync(consumer._receive_from_gemini)(FakeSession(), None, None)

        audio_events = [event for event in sent_events if event["type"] == "assistant_audio"]
        self.assertEqual(len(audio_events), 1)
        self.assertEqual(audio_events[0]["format"], "pcm16")
        self.assertEqual(audio_events[0]["sampleRate"], 24000)
        self.assertEqual(base64.b64decode(audio_events[0]["data"]), b"top-level-audio")

    def test_live_context_keeps_last_project_from_tool_result(self):
        consumer = AssistantLiveConsumer()
        consumer.live_context = []
        event = {
            "name": "create_deal",
            "result": {
                "ok": True,
                "project": {
                    "project_id": 42,
                    "title": "Зеркало в ванную",
                },
            },
        }

        consumer._append_live_context("assistant", consumer._tool_context_text(event, "Готово."))

        self.assertIn("last_project_id=42", consumer.live_context[-1]["text"])
        self.assertIn("last_project_title=Зеркало в ванную", consumer.live_context[-1]["text"])

    def test_live_text_only_turn_sends_tts_fallback_audio(self):
        class FakeOutputTranscription:
            text = "Готово, создал задачу."

        class FakeServerContent:
            model_turn = None
            input_transcription = None
            output_transcription = FakeOutputTranscription()
            interrupted = False
            turn_complete = True

        async def fake_generate_speech_event(_user, text):
            return {
                "type": "assistant_audio",
                "audio_base64": "bXAz",
                "audio_mime_type": "audio/mpeg",
                "text": text,
            }

        consumer = AssistantLiveConsumer()
        consumer.user = self.user
        consumer.turn_metrics = consumer._new_turn_metrics()
        sent_events = []

        async def fake_send(bytes_data=None, text_data=None):
            if text_data:
                sent_events.append(json.loads(text_data))

        consumer.send = fake_send

        with patch("crm_app.live_assistant._generate_speech_event", new=fake_generate_speech_event):
            async_to_sync(consumer._handle_server_content)(FakeServerContent())

        event_types = [event["type"] for event in sent_events]
        self.assertIn("assistant_audio", event_types)
        self.assertLess(event_types.index("assistant_audio"), event_types.index("turn_complete"))

    def test_live_tool_call_with_reply_waits_for_gemini_model_audio(self):
        class FakeFunctionCall:
            id = "call-1"
            name = "create_task"
            args = {"title": "Позвонить клиенту"}

        class FakeToolCall:
            function_calls = [FakeFunctionCall()]

        class FakeSession:
            def __init__(self):
                self.function_responses = []

            async def send_tool_response(self, function_responses):
                self.function_responses = function_responses

        class FakeTypes:
            class FunctionResponse:
                def __init__(self, **kwargs):
                    self.kwargs = kwargs

        consumer = AssistantLiveConsumer()
        consumer.user = self.user
        consumer.live_context = []
        consumer.turn_metrics = consumer._new_turn_metrics()
        consumer.pending_voice_fallback_text = ""
        consumer.suppress_next_tool_model_turn = False
        sent_events = []

        async def fake_send(bytes_data=None, text_data=None):
            if text_data:
                sent_events.append(json.loads(text_data))

        consumer.send = fake_send
        service = CRMAssistantService(self.user, init_gemini_client=False, init_memory=False)
        session = FakeSession()

        async_to_sync(consumer._handle_tool_call)(session, FakeTypes, service, FakeToolCall())

        event_types = [event["type"] for event in sent_events]
        self.assertEqual(event_types[:3], ["tool_running", "tool_call", "tool_response_sent"])
        self.assertNotIn("assistant_audio", event_types)
        self.assertNotIn("turn_complete", event_types)
        self.assertTrue(session.function_responses)
        response_kwargs = session.function_responses[0].kwargs
        self.assertEqual(response_kwargs["id"], "call-1")
        self.assertEqual(response_kwargs["name"], "create_task")
        self.assertTrue(response_kwargs["response"]["ok"])
        self.assertNotIn("output", response_kwargs["response"])
        self.assertNotIn("scheduling", response_kwargs)
        self.assertFalse(consumer.suppress_next_tool_model_turn)
        self.assertEqual(consumer.live_state, "waiting_for_model_response")
        self.assertTrue(Task.objects.filter(title="Позвонить клиенту", assignee=self.user).exists())

    def test_live_tool_handler_error_returns_function_response_without_crash(self):
        class FakeFunctionCall:
            id = "call-error"
            name = "create_task"
            args = {"title": "Сломанная задача"}

        class FakeToolCall:
            function_calls = [FakeFunctionCall()]

        class FakeSession:
            def __init__(self):
                self.function_responses = []

            async def send_tool_response(self, function_responses):
                self.function_responses = function_responses

        class FakeTypes:
            class FunctionResponse:
                def __init__(self, **kwargs):
                    self.kwargs = kwargs

        async def fake_execute_assistant_tool(_service, _tool_name, _arguments):
            raise RuntimeError("tool boom")

        consumer = AssistantLiveConsumer()
        consumer.user = self.user
        consumer.live_context = []
        consumer.turn_metrics = consumer._new_turn_metrics()
        consumer.pending_voice_fallback_text = ""
        consumer.suppress_next_tool_model_turn = False
        sent_events = []

        async def fake_send(bytes_data=None, text_data=None):
            if text_data:
                sent_events.append(json.loads(text_data))

        consumer.send = fake_send
        service = CRMAssistantService(self.user, init_gemini_client=False, init_memory=False)
        session = FakeSession()

        with patch("crm_app.live_assistant._execute_assistant_tool", new=fake_execute_assistant_tool):
            async_to_sync(consumer._handle_tool_call)(session, FakeTypes, service, FakeToolCall())

        event_types = [event["type"] for event in sent_events]
        self.assertIn("tool_response_sent", event_types)
        self.assertTrue(session.function_responses)
        response_kwargs = session.function_responses[0].kwargs
        self.assertEqual(response_kwargs["id"], "call-error")
        self.assertEqual(response_kwargs["name"], "create_task")
        self.assertFalse(response_kwargs["response"]["ok"])
        self.assertIn("tool boom", response_kwargs["response"]["error"])

    def test_live_tool_call_cancellation_is_not_disconnect(self):
        class FakeCancellation:
            ids = ["call-1"]
            reason = "cancelled by model"

        class FakeMessage:
            setup_complete = None
            server_content = None
            data = None
            text = None
            tool_call = None
            tool_call_cancellation = FakeCancellation()
            go_away = None
            session_resumption_update = None

        class FakeSession:
            async def receive(self):
                yield FakeMessage()

        consumer = AssistantLiveConsumer()
        consumer.turn_metrics = consumer._new_turn_metrics()
        sent_events = []

        async def fake_send(bytes_data=None, text_data=None):
            if text_data:
                sent_events.append(json.loads(text_data))

        consumer.send = fake_send

        async_to_sync(consumer._receive_from_gemini)(FakeSession(), None, None)

        self.assertEqual(sent_events[-1]["type"], "tool_call_cancellation")
        self.assertEqual(sent_events[-1]["payload"]["ids"], ["call-1"])

    def test_live_tool_declarations_are_limited_to_low_latency_functions(self):
        service = CRMAssistantService(self.user, init_gemini_client=False, init_memory=False)

        tool_names = {tool["name"] for tool in service._low_latency_tool_declarations()}

        self.assertEqual(
            tool_names,
            {
                "create_client",
                "find_client",
                "create_deal",
                "update_deal",
                "create_task",
                "create_financial_operation",
                "add_comment",
                "get_today_tasks",
                "enqueue_long_operation",
            },
        )
        self.assertNotIn("list_projects", tool_names)
        self.assertNotIn("get_crm_overview", tool_names)

    def test_deal_aliases_reuse_project_tools(self):
        service = CRMAssistantService(self.user, init_gemini_client=False, init_memory=False)

        result = service._execute_tool(
            "create_deal",
            {
                "deal_name": "Зеркало в ванную",
                "client_name": "Иван",
                "client_phone": "+70000000011",
                "status_name": "Проектирование",
            },
        )

        self.assertTrue(result["ok"])
        created_project = Project.objects.get(client_phone="+7-000-000-00-11")
        self.assertEqual(created_project.title, "Зеркало в ванную")
        self.assertEqual(created_project.status, "design")

    def test_ambiguous_project_query_speaks_project_names(self):
        Project.objects.create(
            manager=self.user,
            title="Кухня",
            client_name="Иван",
            client_phone="+70000000021",
            status="design",
        )
        Project.objects.create(
            manager=self.user,
            title="Шолохова кухня",
            client_name="Петров",
            client_phone="+70000000022",
            status="design",
        )
        service = CRMAssistantService(self.user, init_gemini_client=False, init_memory=False)

        result = service._execute_tool(
            "create_financial_operation",
            {
                "project_query": "кухня",
                "amount": 30000,
                "operation_kind": FinanceCategory.Type.INCOME,
                "category_name": "Аванс",
            },
        )

        self.assertFalse(result["ok"])
        self.assertTrue(result["needs_clarification"])
        self.assertIn("Кухня", result["summary"])
        self.assertIn("Шолохова кухня", result["summary"])
        self.assertIn("Какой именно выбрать", result["summary"])

    def test_low_latency_instruction_uses_compact_context(self):
        service = CRMAssistantService(self.user, init_gemini_client=False, init_memory=False)
        reference_cache = async_to_sync(_build_reference_cache)()

        instruction = async_to_sync(_build_low_latency_system_instruction)(
            service,
            self.user,
            "/projects",
            [{"role": "user", "text": "Какие задачи сегодня?"}],
            reference_cache,
        )

        self.assertIn("LOW_LATENCY_CONTEXT", instruction)
        self.assertIn("/projects", instruction)
        self.assertIn("create_deal", instruction)
        self.assertIn("command_synonyms", instruction)
        self.assertIn("create_financial_operation", instruction)
        self.assertIn("без телефона", instruction)
        self.assertNotIn("КЭШ-СНИМОК CRM", instruction)

    def test_command_synonyms_cover_available_tools(self):
        service = CRMAssistantService(self.user, init_gemini_client=False, init_memory=False)
        tool_names = {tool["name"] for tool in service._tool_declarations()}
        tool_names.update(service.LOW_LATENCY_TOOL_NAMES)

        missing = [
            name
            for name in sorted(tool_names)
            if not service._command_synonyms_for(name).get("verbs")
            or not service._command_synonyms_for(name).get("objects")
        ]

        self.assertEqual(missing, [])

    def test_fast_clarification_understands_operation_synonyms(self):
        service = CRMAssistantService(self.user, init_gemini_client=False, init_memory=False)
        cases = {
            "заведи сделку": "clarify_create_project_fast",
            "поставь напоминание": "clarify_create_task_fast",
            "зафиксируй аванс": "clarify_create_financial_operation_fast",
            "оставь заметку": "clarify_add_comment_fast",
            "сформируй кп": "clarify_long_operation_fast",
        }

        for phrase, expected_intent in cases.items():
            with self.subTest(phrase=phrase):
                result = service._fast_mutation_clarification(phrase)

                self.assertIsNotNone(result)
                self.assertEqual(result["intent"], expected_intent)
                self.assertTrue(result["needs_clarification"])

    def test_fast_finance_clarification_keeps_inferred_advance_details(self):
        service = CRMAssistantService(self.user, init_gemini_client=False, init_memory=False)

        result = service._fast_mutation_clarification("создай аванс 30 000")

        self.assertIsNotNone(result)
        self.assertEqual(result["intent"], "clarify_create_financial_operation_fast")
        self.assertIn("по какому проекту", result["reply"])
        self.assertNotIn("доход или расход", result["reply"])
        self.assertNotIn("какая сумма", result["reply"])
        self.assertEqual(result["data"]["operation_kind"], FinanceCategory.Type.INCOME)
        self.assertEqual(result["data"]["category_name"], "Аванс")
        self.assertEqual(result["data"]["amount"], "30000")

    def test_project_title_hint_clarifies_only_missing_client(self):
        service = CRMAssistantService(self.user, init_gemini_client=False, init_memory=False)

        result = service._fast_mutation_clarification("создай проект зеркало в ванную")

        self.assertIsNotNone(result)
        self.assertEqual(result["intent"], "clarify_create_project_fast")
        self.assertEqual(result["data"]["project_title"], "зеркало в ванную")
        self.assertIn("Проект назову", result["reply"])
        self.assertIn("Кто клиент", result["reply"])
        self.assertNotIn("Как назвать проект", result["reply"])
        self.assertIn("бюджет", result["reply"].lower())

    def test_create_project_title_only_asks_for_client_not_title(self):
        service = CRMAssistantService(self.user, init_gemini_client=False, init_memory=False)

        result = service._execute_tool("create_project", {"title": "Зеркало в ванную"})

        self.assertFalse(result["ok"])
        self.assertTrue(result["needs_clarification"])
        self.assertIn("Зеркало в ванную", result["summary"])
        self.assertIn("Кто клиент", result["summary"])
        self.assertNotIn("Как назвать проект", result["summary"])

    def test_create_project_asks_optional_details_before_creation(self):
        service = CRMAssistantService(self.user, init_gemini_client=False, init_memory=False)

        result = service._execute_tool(
            "create_project",
            {"title": "Зеркало в ванную", "client_name": "Иван"},
        )

        self.assertFalse(result["ok"])
        self.assertTrue(result["needs_clarification"])
        self.assertIn("бюджет", result["summary"].lower())
        self.assertIn("адрес", result["summary"].lower())
        self.assertFalse(Project.objects.filter(title="Зеркало в ванную", client_name="Иван").exists())

    def test_create_project_can_skip_optional_details(self):
        service = CRMAssistantService(self.user, init_gemini_client=False, init_memory=False)

        result = service._execute_tool(
            "create_project",
            {
                "title": "Зеркало в ванную",
                "client_name": "Иван",
                "skip_optional_details": True,
            },
        )

        self.assertTrue(result["ok"])
        created_project = Project.objects.get(title="Зеркало в ванную", client_name="Иван")
        self.assertIsNone(created_project.total_amount)
        self.assertEqual(created_project.object_address, None)

    def test_create_deal_without_budget_and_phone_aliases_do_not_block_creation(self):
        service = CRMAssistantService(self.user, init_gemini_client=False, init_memory=False)

        result = service._execute_tool(
            "create_deal",
            {
                "title": "Зеркало в ванную",
                "client_name": "Иван",
                "without_budget": True,
                "without_phone": True,
            },
        )

        self.assertTrue(result["ok"])
        created_project = Project.objects.get(title="Зеркало в ванную", client_name="Иван")
        self.assertEqual(created_project.client_phone, "")
        self.assertEqual(created_project.client.phone, "")
        self.assertIsNone(created_project.total_amount)

    def test_create_project_with_budget_does_not_ask_optional_details(self):
        service = CRMAssistantService(self.user, init_gemini_client=False, init_memory=False)

        result = service._execute_tool(
            "create_project",
            {
                "title": "Зеркало в ванную",
                "client_name": "Иван",
                "total_amount": 120000,
            },
        )

        self.assertTrue(result["ok"])
        created_project = Project.objects.get(title="Зеркало в ванную", client_name="Иван")
        self.assertEqual(created_project.total_amount, Decimal("120000"))

    @patch.dict(os.environ, {"DADATA_API_KEY": "", "VITE_DADATA_API_KEY": ""})
    def test_create_project_rejects_sparse_ai_address_without_dadata(self):
        service = CRMAssistantService(self.user, init_gemini_client=False, init_memory=False)

        result = service._execute_tool(
            "create_project",
            {
                "title": "Зеркало",
                "client_name": "Иван",
                "object_address": "Далмановский",
                "skip_optional_details": True,
            },
        )

        self.assertFalse(result["ok"])
        self.assertTrue(result["needs_clarification"])
        self.assertIn("Адрес выглядит неполным", result["summary"])
        self.assertFalse(Project.objects.filter(title="Зеркало", client_name="Иван").exists())

    @patch.object(
        CRMAssistantService,
        "_suggest_dadata_address",
        return_value=[
            {
                "value": "г Москва, ул Ленина, д 5",
                "data": {"geo_lat": "55.755864", "geo_lon": "37.617698"},
            }
        ],
    )
    def test_create_project_normalizes_ai_address_with_dadata(self, _mocked_suggest):
        service = CRMAssistantService(self.user, init_gemini_client=False, init_memory=False)

        result = service._execute_tool(
            "create_project",
            {
                "title": "Зеркало",
                "client_name": "Иван",
                "object_address": "Ленина 5",
                "skip_optional_details": True,
            },
        )

        self.assertTrue(result["ok"])
        created_project = Project.objects.get(title="Зеркало", client_name="Иван")
        self.assertEqual(created_project.object_address, "г Москва, ул Ленина, д 5")
        self.assertEqual(created_project.object_lat, "55.755864")
        self.assertEqual(created_project.object_lon, "37.617698")

    def test_finance_operation_infers_income_advance_from_raw_text(self):
        project = Project.objects.create(
            manager=self.user,
            title="Зеркало",
            client_name="Иван",
            client_phone="+70000000022",
            status="design",
        )
        service = CRMAssistantService(self.user, init_gemini_client=False, init_memory=False)

        result = service._execute_tool(
            "create_financial_operation",
            {
                "project_id": project.id,
                "raw_text": "создай аванс 30 000",
            },
        )

        self.assertTrue(result["ok"])
        payment = Payment.objects.get(project=project)
        self.assertEqual(payment.amount, Decimal("30000"))
        self.assertEqual(payment.type, Payment.Type.ADVANCE)
        self.assertEqual(payment.category.name, "Аванс")
        self.assertEqual(payment.category.type, FinanceCategory.Type.INCOME)

    def test_finance_operation_infers_expense_category_from_raw_text(self):
        project = Project.objects.create(
            manager=self.user,
            title="Зеркало",
            client_name="Иван",
            client_phone="+70000000023",
            status="design",
        )
        service = CRMAssistantService(self.user, init_gemini_client=False, init_memory=False)

        result = service._execute_tool(
            "create_financial_operation",
            {
                "project_id": project.id,
                "raw_text": "проведи доставку 5000",
            },
        )

        self.assertTrue(result["ok"])
        payment = Payment.objects.get(project=project)
        self.assertEqual(payment.amount, Decimal("5000"))
        self.assertEqual(payment.type, Payment.Type.CORRECTION)
        self.assertEqual(payment.category.name, "Доставка")
        self.assertEqual(payment.category.type, FinanceCategory.Type.EXPENSE)

    def test_finance_operation_with_advance_text_asks_only_for_project(self):
        service = CRMAssistantService(self.user, init_gemini_client=False, init_memory=False)

        result = service._execute_tool(
            "create_financial_operation",
            {
                "raw_text": "создай аванс 30 000",
            },
        )

        self.assertFalse(result["ok"])
        self.assertTrue(result["needs_clarification"])
        self.assertIn("проект", result["summary"])
        self.assertNotIn("доход или расход", result["summary"])
        self.assertNotIn("сумму", result["summary"])

    def test_synonym_commands_enable_tool_calling(self):
        service = CRMAssistantService(self.user, init_gemini_client=False, init_memory=False)
        phrases = [
            "перекинь проект в монтаж",
            "отметь задачу выполненной",
            "проведи расход по проекту",
            "прочитай комментарии по проекту",
        ]

        for phrase in phrases:
            with self.subTest(phrase=phrase):
                self.assertTrue(service._should_enable_tools(phrase))

    @patch("crm_app.tasks.run_long_assistant_operation")
    def test_long_operation_is_queued(self, mocked_task):
        class FakeAsyncResult:
            id = "task-123"

        mocked_task.delay.return_value = FakeAsyncResult()
        service = CRMAssistantService(self.user, init_gemini_client=False, init_memory=False)

        result = service._execute_tool(
            "enqueue_long_operation",
            {"operation": "generate_report", "prompt": "Отчет за неделю"},
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["task_id"], "task-123")
        mocked_task.delay.assert_called_once()


class TestGeminiErrors(APITestCase):
    @patch.object(GeminiClient, "_vertex_access_token")
    @patch("crm_app.ai_assistant.urllib_request.urlopen")
    def test_vertex_tts_uses_cloud_text_to_speech(self, mocked_urlopen, mocked_access_token):
        previous = {
            name: os.environ.get(name)
            for name in (
                "GEMINI_BACKEND",
                "VERTEX_AI_PROJECT_ID",
                "GEMINI_TTS_PROVIDER",
                "GEMINI_TTS_CLOUD_VOICE",
                "GEMINI_TTS_AUDIO_ENCODING",
            )
        }
        os.environ["GEMINI_BACKEND"] = "vertex_ai"
        os.environ["VERTEX_AI_PROJECT_ID"] = "test-project"
        os.environ["GEMINI_TTS_PROVIDER"] = "cloud_tts"
        os.environ["GEMINI_TTS_CLOUD_VOICE"] = "ru-RU-Chirp3-HD-Aoede"
        os.environ["GEMINI_TTS_AUDIO_ENCODING"] = "MP3"
        mocked_access_token.return_value = "test-token"

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps({"audioContent": base64.b64encode(b"mp3-demo").decode("ascii")}).encode("utf-8")

        mocked_urlopen.return_value = FakeResponse()

        try:
            client = GeminiClient()
            speech = client.generate_speech("Привет")
        finally:
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

        request = mocked_urlopen.call_args.args[0]
        payload = json.loads(request.data.decode("utf-8"))
        self.assertIn("texttospeech.googleapis.com/v1/text:synthesize", request.full_url)
        self.assertEqual(payload["voice"]["name"], "ru-RU-Chirp3-HD-Aoede")
        self.assertEqual(payload["audioConfig"]["audioEncoding"], "MP3")
        self.assertEqual(speech["mime_type"], "audio/mpeg")
        self.assertEqual(speech["audio_bytes"], b"mp3-demo")

    def test_location_error_points_to_vertex_ai(self):
        message = humanize_gemini_error(
            '{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}',
            backend="google_ai",
        )

        self.assertIn("Vertex AI", message)
        self.assertIn("GEMINI_BACKEND=vertex_ai", message)


class TestBillingApi(AuthenticatedApiMixin, APITestCase):
    def setUp(self):
        self.admin = self.create_user("admin.user", role=User.Role.ADMIN)
        self.manager = self.create_user("manager.user")

    def test_summary_bootstraps_default_plan(self):
        client = self.auth_client_for(self.admin)

        response = client.get("/api/billing/summary/")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["plan"]["price_rub"], "1500.00")
        self.assertEqual(
            {plan["code"]: plan["price_rub"] for plan in response.data["plans"]},
            {
                "crm-basic-monthly": "1000.00",
                "crm-ai-monthly": "1500.00",
            },
        )
        self.assertEqual(response.data["trial"]["project_limit"], 10)
        self.assertEqual(response.data["trial"]["project_creations_count"], 0)
        self.assertFalse(response.data["subscription"]["is_active_now"])

    def test_admin_profile_reports_subscription_access(self):
        client = self.auth_client_for(self.admin)

        response = client.get("/api/me/")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertTrue(response.data["is_admin"])
        self.assertTrue(response.data["subscription_active"])

    def test_admin_can_use_live_assistant_without_active_subscription(self):
        self.assertTrue(async_to_sync(_has_live_assistant_access)(self.admin))
        self.assertFalse(async_to_sync(_has_live_assistant_access)(self.manager))

    def test_inactive_subscription_allows_trial_business_api(self):
        client = self.auth_client_for(self.manager)

        response = client.get("/api/projects/")

        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_trial_limit_blocks_eleventh_project_even_after_delete(self):
        ProjectStatus.objects.get_or_create(
            code="active",
            defaults={"name": "Active", "short_name": "Active", "color": "sky", "sort_order": 10, "is_default": True},
        )
        client = self.auth_client_for(self.manager)
        created_project_ids = []

        for index in range(9):
            response = client.post(
                "/api/projects/",
                {
                    "title": f"Trial project {index + 1}",
                    "client_name": f"Client {index + 1}",
                },
                format="json",
            )
            self.assertEqual(response.status_code, status.HTTP_201_CREATED)
            created_project_ids.append(response.data["id"])

        delete_response = client.delete(f"/api/projects/{created_project_ids[0]}/")
        self.assertEqual(delete_response.status_code, status.HTTP_204_NO_CONTENT)

        tenth_response = client.post(
            "/api/projects/",
            {
                "title": "Trial project 10",
                "client_name": "Last Trial Client",
            },
            format="json",
        )
        self.assertEqual(tenth_response.status_code, status.HTTP_201_CREATED)

        blocked_response = client.post(
            "/api/projects/",
            {
                "title": "Trial project 11",
                "client_name": "Blocked Client",
            },
            format="json",
        )

        self.assertEqual(blocked_response.status_code, status.HTTP_403_FORBIDDEN)

    def test_admin_can_use_business_api_without_active_subscription(self):
        client = self.auth_client_for(self.admin)

        response = client.get("/api/projects/")

        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_basic_subscription_does_not_enable_assistant(self):
        self.activate_subscription(actor=self.admin, plan_code="crm-basic-monthly")
        client = self.auth_client_for(self.manager)

        response = client.post("/api/assistant/chat/", {"message": "Какие есть проекты?"}, format="json")

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertFalse(async_to_sync(_has_live_assistant_access)(self.manager))

    def test_admin_can_create_and_activate_invoice(self):
        client = self.auth_client_for(self.admin)

        invoice_response = client.post("/api/billing/invoices/", {}, format="json")
        self.assertEqual(invoice_response.status_code, status.HTTP_201_CREATED)
        invoice_id = invoice_response.data["invoice_id"]

        activate_response = client.post(
            "/api/billing/activate/",
            {"invoice_id": invoice_id},
            format="json",
        )

        self.assertEqual(activate_response.status_code, status.HTTP_200_OK)
        self.assertTrue(activate_response.data["summary"]["subscription"]["is_active_now"])
        self.assertEqual(
            SubscriptionInvoice.objects.get(id=invoice_id).status,
            SubscriptionInvoice.Status.PAID,
        )
