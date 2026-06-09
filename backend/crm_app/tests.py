import base64
import json
import os
from decimal import Decimal
from unittest.mock import patch
from asgiref.sync import async_to_sync
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

from .ai_assistant import CRMAssistantService, GeminiClient, GeminiRequestError, humanize_gemini_error
from .live_assistant import _build_low_latency_system_instruction, _build_reference_cache, _has_live_assistant_access
from .models import Account, Client, FinanceCategory, Payment, Project, ProjectComment, ProjectStatus, SubscriptionInvoice, Task, User
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
        self.assertEqual(created_client.phone, "+70000000077")
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
            phone="+70000000001",
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
        self.assertEqual(self.client_card.phone, "+70000000099")
        self.assertEqual(self.client_card.email, "updated@example.com")
        self.assertEqual(self.client_card.address, "Updated address")
        self.assertTrue(self.client_card.works_with_contract)


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
                    "paid_at": "2026-05-26T10:00:00",
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
        created_project = Project.objects.get(client_phone="+70000000011")
        self.assertEqual(created_project.title, "Зеркало в ванную")
        self.assertEqual(created_project.status, "design")

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
