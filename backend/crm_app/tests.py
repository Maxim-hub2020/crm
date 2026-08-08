import json
import os
import tempfile
from decimal import Decimal
from io import StringIO
from urllib.parse import parse_qs, urlparse
from unittest.mock import patch
from django.core.management import call_command
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

from .dadata import dadata_query
from .gemini_client import GeminiClient
from .models import Account, CalculatorQuote, CalculatorSettings, ChatIntegrationSettings, Client, ClientBonusTransaction, FinanceCategory, Payment, Project, ProjectComment, ProjectCustomField, ProjectStatus, Task, User, Workspace, YandexDiskSettings


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

    def test_calculator_settings_are_per_workspace(self):
        api_a = self.auth_client_for(self.admin_a)
        api_b = self.auth_client_for(self.admin_b)

        response_a = api_a.patch(
            "/api/calculator-settings/",
            {"shower_catalog": {"services": {"productMarkupPercent": 15}}},
            format="json",
        )
        response_b = api_b.patch(
            "/api/calculator-settings/",
            {"shower_catalog": {"services": {"productMarkupPercent": 25}}},
            format="json",
        )
        read_a = api_a.get("/api/calculator-settings/")
        read_b = api_b.get("/api/calculator-settings/")

        self.assertEqual(response_a.status_code, status.HTTP_200_OK)
        self.assertEqual(response_b.status_code, status.HTTP_200_OK)
        self.assertEqual(read_a.data["shower_catalog"]["services"]["productMarkupPercent"], 15)
        self.assertEqual(read_b.data["shower_catalog"]["services"]["productMarkupPercent"], 25)
        self.assertEqual(CalculatorSettings.objects.count(), 2)

    def test_manager_cannot_change_calculator_settings(self):
        api_client = self.auth_client_for(self.manager_a)

        response = api_client.patch(
            "/api/calculator-settings/",
            {"shower_catalog": {"services": {"productMarkupPercent": 99}}},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_calculator_quotes_are_merged_and_isolated_by_workspace(self):
        api_a = self.auth_client_for(self.admin_a)
        api_b = self.auth_client_for(self.admin_b)
        quote_a1 = {
            "id": "quote-a-1",
            "number": "1001",
            "createdAt": "2026-08-01T10:00:00Z",
            "items": [],
        }
        quote_a2 = {
            "id": "quote-a-2",
            "number": "1002",
            "createdAt": "2026-08-02T10:00:00Z",
            "items": [],
        }
        quote_b = {
            "id": "quote-b-1",
            "number": "2001",
            "createdAt": "2026-08-03T10:00:00Z",
            "items": [],
        }

        first_sync = api_a.post("/api/calculator-quotes/", {"quotes": [quote_a1]}, format="json")
        second_sync = api_a.post("/api/calculator-quotes/", {"quotes": [quote_a2]}, format="json")
        api_b.post("/api/calculator-quotes/", {"quotes": [quote_b]}, format="json")
        read_a = api_a.get("/api/calculator-quotes/")
        read_b = api_b.get("/api/calculator-quotes/")

        self.assertEqual(first_sync.status_code, status.HTTP_200_OK)
        self.assertEqual(second_sync.status_code, status.HTTP_200_OK)
        self.assertEqual([item["id"] for item in read_a.data["quotes"]], ["quote-a-2", "quote-a-1"])
        self.assertEqual([item["id"] for item in read_b.data["quotes"]], ["quote-b-1"])
        self.assertEqual(CalculatorQuote.objects.count(), 3)

        delete_response = api_a.delete("/api/calculator-quotes/quote-a-1/")
        self.assertEqual(delete_response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(
            [item["id"] for item in api_a.get("/api/calculator-quotes/").data["quotes"]],
            ["quote-a-2"],
        )

    def test_manager_cannot_change_calculator_quotes(self):
        api_client = self.auth_client_for(self.manager_a)
        response = api_client.post(
            "/api/calculator-quotes/",
            {"quotes": [{"id": "manager-quote", "number": "3001"}]},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)


class TestDadataAddressApi(AuthenticatedApiMixin, APITestCase):
    def setUp(self):
        self.user = self.create_user("address.user")

    @patch.dict(os.environ, {"DADATA_DEFAULT_REGION": "Ростовская область", "DADATA_DEFAULT_CITY": "Ростов-на-Дону"})
    def test_dadata_query_defaults_to_rostov_region(self):
        self.assertEqual(
            dadata_query("Далмановский"),
            "Ростовская область, Далмановский",
        )

    @patch.dict(os.environ, {"DADATA_DEFAULT_REGION": "Ростовская область", "DADATA_DEFAULT_CITY": "Ростов-на-Дону"})
    def test_dadata_query_does_not_restrict_to_rostov_city(self):
        self.assertEqual(
            dadata_query("Новочеркасск, Ленина 43"),
            "Ростовская область, Новочеркасск, Ленина 43",
        )

    @patch.dict(os.environ, {"DADATA_API_KEY": "test-token"})
    @patch("crm_app.views.suggest_dadata_address")
    def test_address_suggestions_use_backend_dadata_proxy(self, mocked_suggest):
        mocked_suggest.return_value = [
            {
                "value": "Ростовская обл, г Ростов-на-Дону, ул Ленина, д 5",
                "unrestricted_value": "Ростовская обл, г Ростов-на-Дону, ул Ленина, д 5",
                "data": {"geo_lat": "47.222", "geo_lon": "39.72", "flat": "12", "floor": "7"},
            }
        ]
        api_client = self.auth_client_for(self.user)

        response = api_client.get("/api/address-suggestions/", {"q": "Ленина 5"})

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertTrue(response.data["configured"])
        self.assertEqual(response.data["default_region"], "Ростовская область")
        self.assertEqual(response.data["suggestions"][0]["lat"], "47.222")
        self.assertEqual(response.data["suggestions"][0]["apartment"], "12")
        self.assertEqual(response.data["suggestions"][0]["floor"], "7")
        mocked_suggest.assert_called_once_with("Ленина 5", count=6)


class TestProjectApi(AuthenticatedApiMixin, APITestCase):
    def setUp(self):
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
                "address_lat": "47.222",
                "address_lon": "39.72",
                "apartment": "12",
                "floor": "7",
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
        self.assertEqual(self.client_card.address_lat, "47.222")
        self.assertEqual(self.client_card.address_lon, "39.72")
        self.assertEqual(self.client_card.apartment, "12")
        self.assertEqual(self.client_card.floor, "7")
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

    def test_global_search_matches_normalized_client_and_project_phone_digits(self):
        self.client_card.phone = "+7-900-123-45-67"
        self.client_card.save(update_fields=["phone"])
        project = Project.objects.create(
            manager=self.manager,
            client=self.client_card,
            title="Searchable Project",
            client_name=self.client_card.name,
            client_phone=self.client_card.phone,
        )
        api_client = self.auth_client_for(self.manager)

        response = api_client.get("/api/global-search/", {"q": "8900123"})

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        result_keys = {(row["type"], row["id"]) for row in response.data["results"]}
        self.assertIn(("client", self.client_card.id), result_keys)
        self.assertIn(("project", project.id), result_keys)

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

    def configure_finance_review_statuses(self):
        ProjectStatus.objects.update_or_create(
            workspace=self.manager.workspace,
            code="design",
            defaults={"name": "Проектирование", "sort_order": 10, "is_default": True},
        )
        ProjectStatus.objects.update_or_create(
            workspace=self.manager.workspace,
            code="montage",
            defaults={"name": "Монтаж", "sort_order": 20, "is_default": False},
        )
        ProjectStatus.objects.update_or_create(
            workspace=self.manager.workspace,
            code="closed",
            defaults={"name": "Завершено", "sort_order": 30, "is_default": False},
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
        self.configure_finance_review_statuses()
        project = Project.objects.create(
            manager=self.manager,
            client_name="Analytics Client",
            client_phone="+79000002100",
            total_amount=Decimal("100000.00"),
            status="closed",
        )
        categories = {
            "delivery": FinanceCategory.objects.get_or_create(
                workspace=self.manager.workspace,
                name="Доставка",
                type=FinanceCategory.Type.EXPENSE,
            )[0],
            "montage": FinanceCategory.objects.get_or_create(
                workspace=self.manager.workspace,
                name="Монтаж",
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
            ("montage", "7000.00"),
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
        self.assertEqual(response.data["margin_percent"], "56.00")
        self.assertEqual(response.data["missing_required_expenses"], [])

    def test_project_finance_analytics_warns_about_missing_expenses_and_low_margin(self):
        self.configure_finance_review_statuses()
        project = Project.objects.create(
            manager=self.manager,
            client_name="Risk Client",
            client_phone="+79000002101",
            total_amount=Decimal("100000.00"),
            status="montage",
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
        self.configure_finance_review_statuses()
        project = Project.objects.create(
            manager=self.manager,
            client_name="Summary Client",
            client_phone="+79000002102",
            total_amount=Decimal("100000.00"),
            status="montage",
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

    def test_finance_analytics_predicts_remaining_expenses_for_selected_project(self):
        self.configure_finance_review_statuses()
        previous_project = Project.objects.create(
            manager=self.manager,
            title="Кухня массив",
            client_name="Previous Client",
            client_phone="+79000002112",
            total_amount=Decimal("100000.00"),
            status="closed",
        )
        Payment.objects.create(
            project=previous_project,
            created_by=self.manager,
            category=self.expense_category,
            account=self.account,
            amount=Decimal("40000.00"),
            type=Payment.Type.CORRECTION,
        )
        target_project = Project.objects.create(
            manager=self.manager,
            title="Кухня массив новая",
            client_name="Target Client",
            client_phone="+79000002113",
            total_amount=Decimal("50000.00"),
            status="design",
        )
        Payment.objects.create(
            project=target_project,
            created_by=self.manager,
            category=self.expense_category,
            account=self.account,
            amount=Decimal("5000.00"),
            type=Payment.Type.CORRECTION,
        )
        client = self.auth_client_for(self.manager)

        response = client.get("/api/finance-analytics/", {"project": target_project.id})

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        prediction = response.data["expense_prediction"]
        self.assertEqual(prediction["estimated_expense_total"], "27000.00")
        self.assertEqual(prediction["current_expense_total"], "5000.00")
        self.assertEqual(prediction["estimated_remaining_expense"], "22000.00")
        self.assertEqual(prediction["basis_project_count"], 1)
        self.assertEqual(prediction["learning_scope"], "similar_completed_projects")
        self.assertIn("Монтаж", [item["label"] for item in prediction["required_expense_forecast"]])
        self.assertEqual(response.data["summary"]["at_risk_project_count"], 0)
        self.assertEqual(response.data["at_risk_projects"], [])

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

    @patch("crm_app.views.GeminiClient")
    def test_cash_forecast_ai_falls_back_when_gemini_truncates_text(self, mocked_client_class):
        project = Project.objects.create(
            manager=self.manager,
            title="Новочек",
            client_name="Cash Client",
            client_phone="+79000002104",
            total_amount=Decimal("69465.00"),
        )
        Payment.objects.create(
            project=project,
            created_by=self.manager,
            category=self.income_category,
            account=self.account,
            amount=Decimal("40000.00"),
            type=Payment.Type.ADVANCE,
        )
        mocked_client = mocked_client_class.return_value
        mocked_client.fast_model = "gemini-fast"
        mocked_client.generate_content.return_value = {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {"text": "1. Текущий баланс составляет 14"},
                        ]
                    }
                }
            ]
        }
        mocked_client.extract_candidate_content.side_effect = GeminiClient.extract_candidate_content
        mocked_client.extract_text.side_effect = GeminiClient.extract_text
        client = self.auth_client_for(self.admin)

        response = client.post("/api/cash-forecast/ai/", {"project": project.id}, format="json")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertIn("40 000", response.data["analysis"])
        self.assertIn("29 465", response.data["analysis"])
        self.assertIn("0003", response.data["analysis"])
        self.assertNotIn("14", response.data["analysis"])
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

    def test_manager_can_update_existing_past_payment_without_changing_date(self):
        self.manager_payment.paid_at = timezone.now() - timezone.timedelta(days=1)
        self.manager_payment.save(update_fields=["paid_at"])
        client = self.auth_client_for(self.manager)
        original_date = timezone.localtime(self.manager_payment.paid_at).date().isoformat()

        response = client.patch(
            f"/api/payments/{self.manager_payment.id}/",
            {
                "amount": "23000.00",
                "paid_at": f"{original_date}T12:00:00",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.manager_payment.refresh_from_db()
        self.assertEqual(str(self.manager_payment.amount), "23000.00")
        self.assertEqual(timezone.localtime(self.manager_payment.paid_at).date().isoformat(), original_date)

    def test_manager_cannot_move_payment_to_another_past_date(self):
        self.manager_payment.paid_at = timezone.now() - timezone.timedelta(days=1)
        self.manager_payment.save(update_fields=["paid_at"])
        client = self.auth_client_for(self.manager)
        another_past_date = (timezone.localdate() - timezone.timedelta(days=2)).isoformat()

        response = client.patch(
            f"/api/payments/{self.manager_payment.id}/",
            {"paid_at": f"{another_past_date}T12:00:00"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("paid_at", response.data)

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


class TestYandexDiskArchiveApi(AuthenticatedApiMixin, APITestCase):
    def setUp(self):
        self.active_status, _ = ProjectStatus.objects.get_or_create(
            code="active",
            defaults={"name": "В работе", "short_name": "Работа", "color": "sky", "sort_order": 10, "is_default": True},
        )
        self.closed_status, _ = ProjectStatus.objects.get_or_create(
            code="closed",
            defaults={"name": "Завершено", "short_name": "Готово", "color": "emerald", "sort_order": 20, "is_default": False},
        )
        self.admin = self.create_user("admin.yandex.archive", role=User.Role.ADMIN)
        YandexDiskSettings.objects.update_or_create(
            workspace=self.admin.workspace,
            defaults={
                "enabled": True,
                "auto_create_project_folders": True,
                "base_path": "/CRM/Проекты",
                "archive_path": "/CRM/Архив",
                "oauth_token": "test-token",
            },
        )

    def test_project_folder_moves_to_archive_when_project_status_becomes_closed(self):
        project = Project.objects.create(
            manager=self.admin,
            title="Душевая",
            client_name="Антон",
            client_phone="+7-900-000-00-01",
            status=self.active_status.code,
        )
        project.yandex_disk_path = "disk:/CRM/Проекты/№0001 · Душевая"
        project.yandex_disk_web_url = "https://disk.yandex.ru/client/disk/CRM/Проекты/old"
        project.save(update_fields=["yandex_disk_path", "yandex_disk_web_url", "updated_at"])
        client = self.auth_client_for(self.admin)

        with patch("crm_app.yandex_disk.ensure_folder_tree") as ensure_folder_tree, patch("crm_app.yandex_disk.move_resource") as move_resource:
            response = client.patch(
                f"/api/projects/{project.id}/",
                {"status": self.closed_status.code},
                format="json",
            )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        project.refresh_from_db()
        expected_path = "disk:/CRM/Архив/№0001 · Душевая"
        ensure_folder_tree.assert_called_once_with("test-token", "disk:/CRM/Архив")
        move_resource.assert_called_once_with("test-token", "disk:/CRM/Проекты/№0001 · Душевая", expected_path)
        self.assertEqual(project.yandex_disk_path, expected_path)
        self.assertIn("/CRM/%D0%90%D1%80%D1%85%D0%B8%D0%B2/", project.yandex_disk_web_url)
        self.assertIsNotNone(project.yandex_disk_archived_at)
        self.assertEqual(project.yandex_disk_error, "")


class TestYandexDiskOAuthApi(AuthenticatedApiMixin, APITestCase):
    def setUp(self):
        self.admin = self.create_user("admin.yandex.oauth", role=User.Role.ADMIN)

    @patch.dict(
        os.environ,
        {
            "YANDEX_DISK_CLIENT_ID": "test-client-id",
            "YANDEX_DISK_CLIENT_SECRET": "test-client-secret",
            "YANDEX_DISK_REDIRECT_URI": "https://cehcrm.ru/api/yandex-disk/oauth/callback/",
            "CRM_FRONTEND_URL": "https://cehcrm.ru",
        },
    )
    def test_admin_can_connect_yandex_disk_via_oauth_callback(self):
        client = self.auth_client_for(self.admin)
        start_response = client.post("/api/yandex-disk/oauth/start/", {}, format="json")

        self.assertEqual(start_response.status_code, status.HTTP_200_OK)
        auth_url = start_response.data["authorization_url"]
        parsed = urlparse(auth_url)
        query = parse_qs(parsed.query)
        self.assertEqual(parsed.netloc, "oauth.yandex.ru")
        self.assertEqual(query["client_id"], ["test-client-id"])
        self.assertEqual(query["redirect_uri"], ["https://cehcrm.ru/api/yandex-disk/oauth/callback/"])

        class FakeResponse:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self):
                return json.dumps({"access_token": "saved-yandex-token", "token_type": "bearer"}).encode("utf-8")

        with patch("crm_app.yandex_disk.urllib_request.urlopen", return_value=FakeResponse()):
            callback_response = self.client.get(
                "/api/yandex-disk/oauth/callback/",
                {"code": "oauth-code", "state": query["state"][0]},
            )

        self.assertEqual(callback_response.status_code, 302)
        self.assertEqual(callback_response["Location"], "https://cehcrm.ru/settings?yandex_disk=connected")
        settings = YandexDiskSettings.objects.get(workspace=self.admin.workspace)
        self.assertTrue(settings.enabled)
        self.assertEqual(settings.oauth_token, "saved-yandex-token")

    @patch.dict(
        os.environ,
        {
            "YANDEX_DISK_CLIENT_ID": "test-client-id",
            "YANDEX_DISK_CLIENT_SECRET": "test-client-secret",
        },
    )
    def test_admin_can_connect_yandex_disk_with_manual_verification_code(self):
        client = self.auth_client_for(self.admin)

        class FakeResponse:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self):
                return json.dumps({"access_token": "manual-yandex-token", "token_type": "bearer"}).encode("utf-8")

        with patch("crm_app.yandex_disk.urllib_request.urlopen", return_value=FakeResponse()):
            response = client.post("/api/yandex-disk/oauth/complete/", {"code": "manual-code"}, format="json")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertTrue(response.data["has_oauth_token"])
        settings = YandexDiskSettings.objects.get(workspace=self.admin.workspace)
        self.assertTrue(settings.enabled)
        self.assertEqual(settings.oauth_token, "manual-yandex-token")
