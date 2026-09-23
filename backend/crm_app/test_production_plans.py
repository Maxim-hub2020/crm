from rest_framework import status
from rest_framework.test import APIClient, APITestCase

from .models import ProductionPlan, Project, User, Workspace


class TestProductionPlansApi(APITestCase):
    password = "StrongPass123!"

    def setUp(self):
        self.workspace = Workspace.objects.create(name="Цех", slug="production-plans")
        self.other_workspace = Workspace.objects.create(name="Другой цех", slug="other-production-plans")
        self.admin = User.objects.create_user(username="plan.admin", password=self.password, role=User.Role.ADMIN, workspace=self.workspace)
        self.manager = User.objects.create_user(username="plan.manager", password=self.password, workspace=self.workspace)
        self.other_admin = User.objects.create_user(username="other.admin", password=self.password, role=User.Role.ADMIN, workspace=self.other_workspace)
        self.project = Project.objects.create(workspace=self.workspace, manager=self.manager, title="Душевая", client_name="Клиент", client_phone="+7-900-000-00-00")

    def auth(self, user):
        client = APIClient()
        response = client.post("/api/auth/token/", {"username": user.username, "password": self.password}, format="json")
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {response.data['access']}")
        return client

    def test_creates_incrementing_revisions(self):
        client = self.auth(self.admin)
        payload = {"project": self.project.id, "product_type": "shower", "summary": "Замер", "specification": {"width_mm": 1000}}
        first = client.post("/api/production-plans/", payload, format="json")
        second = client.post("/api/production-plans/", payload, format="json")
        self.assertEqual(first.status_code, status.HTTP_201_CREATED)
        self.assertEqual(second.status_code, status.HTTP_201_CREATED, second.data)
        self.assertEqual(second.data["revision"], 2)

    def test_other_workspace_cannot_access_plan(self):
        plan = ProductionPlan.objects.create(workspace=self.workspace, project=self.project, product_type="mirror", created_by=self.admin)
        response = self.auth(self.other_admin).get(f"/api/production-plans/{plan.id}/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_approval_requires_ready_plan_without_questions_and_admin(self):
        plan = ProductionPlan.objects.create(
            workspace=self.workspace,
            project=self.project,
            product_type="shower",
            status=ProductionPlan.Status.READY_FOR_REVIEW,
            created_by=self.admin,
        )
        manager_response = self.auth(self.manager).post(f"/api/production-plans/{plan.id}/approve/", {"confirm": True}, format="json")
        self.assertEqual(manager_response.status_code, status.HTTP_403_FORBIDDEN)
        response = self.auth(self.admin).post(f"/api/production-plans/{plan.id}/approve/", {"confirm": True}, format="json")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["status"], ProductionPlan.Status.APPROVED)
        update_response = self.auth(self.admin).patch(
            f"/api/production-plans/{plan.id}/",
            {"summary": "Изменение после утверждения"},
            format="json",
        )
        self.assertEqual(update_response.status_code, status.HTTP_400_BAD_REQUEST)
        delete_response = self.auth(self.admin).delete(f"/api/production-plans/{plan.id}/")
        self.assertEqual(delete_response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_ready_status_rejected_while_questions_remain(self):
        response = self.auth(self.admin).post(
            "/api/production-plans/",
            {"project": self.project.id, "product_type": "mirror", "status": "ready_for_review", "blocking_questions": ["Какая толщина?"]},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
