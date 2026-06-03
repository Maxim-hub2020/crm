import os
from unittest.mock import patch
from django.core.files.uploadedfile import SimpleUploadedFile
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

from .ai_assistant import humanize_gemini_error
from .models import Payment, Project, ProjectComment, ProjectStatus, SubscriptionInvoice, Task, User
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

    def activate_subscription(self, actor=None):
        ensure_subscription_defaults()
        invoice = issue_subscription_invoice(actor=actor)
        return activate_subscription_invoice(invoice)


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

        self.manager_payment = Payment.objects.create(
            project=self.manager_project,
            created_by=self.manager,
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
                "comment": "New payment",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data["project"], self.manager_project.id)
        self.assertEqual(response.data["created_by"], self.manager.id)

        created_payment = Payment.objects.get(id=response.data["id"])
        self.assertEqual(created_payment.created_by_id, self.manager.id)

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

class TestGeminiErrors(APITestCase):
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
        self.assertFalse(response.data["subscription"]["is_active_now"])

    def test_inactive_subscription_blocks_business_api(self):
        client = self.auth_client_for(self.manager)

        response = client.get("/api/projects/")

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertIn("Подписка", str(response.data))

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
