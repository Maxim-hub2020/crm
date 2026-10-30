from rest_framework.test import APITestCase

from . import tests as api_tests
from .models import Task


class TaskSubtaskApiTests(api_tests.AuthenticatedApiMixin, APITestCase):
    def setUp(self):
        self.manager = self.create_user("subtasks.manager")
        self.other_manager = self.create_user("subtasks.other")
        self.client = self.auth_client_for(self.manager)
        self.parent = Task.objects.create(
            title="Монтаж зеркал", assignee=self.manager, created_by=self.manager,
            scheduled_date="2026-10-21", city="Ростов-на-Дону", address="20-я линия, 16/25",
        )

    def test_subtasks_are_independent_records_with_parent_and_location(self):
        response = self.client.post("/api/tasks/", {
            "title": "Найти ХДФ 3 мм", "parent_task": self.parent.id,
            "scheduled_date": "2026-10-20", "city": "Аксай",
        }, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        child_id = response.data["id"]
        self.assertEqual(response.data["parent_task"], self.parent.id)
        self.assertEqual(response.data["parent_title"], "Монтаж зеркал")
        self.assertEqual(response.data["city"], "Аксай")
        self.assertEqual(response.data["address"], "")
        parent = self.client.get(f"/api/tasks/{self.parent.id}/").data
        self.assertEqual(parent["subtasks"], [{"id": child_id, "title": "Найти ХДФ 3 мм", "status": "open"}])
        filtered = self.client.get("/api/tasks/", {"parent_task": self.parent.id}).data
        self.assertEqual([row["id"] for row in filtered], [child_id])

        self.assertEqual(self.client.patch(f"/api/tasks/{self.parent.id}/", {"status": "done"}, format="json").status_code, 400)
        self.assertEqual(self.client.patch(f"/api/tasks/{child_id}/", {"status": "done"}, format="json").status_code, 200)
        self.assertEqual(self.client.patch(f"/api/tasks/{self.parent.id}/", {"status": "done"}, format="json").status_code, 200)
        self.assertEqual(self.client.patch(f"/api/tasks/{child_id}/", {"status": "open"}, format="json").status_code, 400)

    def test_rejects_inaccessible_parent_and_cycles(self):
        other = Task.objects.create(title="Чужая задача", assignee=self.other_manager, created_by=self.other_manager)
        response = self.client.post("/api/tasks/", {"title": "Подзадача", "parent_task": other.id}, format="json")
        self.assertEqual(response.status_code, 400)
        response = self.client.post("/api/tasks/", {"title": "Подготовка", "parent_task": self.parent.id}, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        child_id = response.data["id"]
        self.assertEqual(self.client.patch(f"/api/tasks/{self.parent.id}/", {"parent_task": child_id}, format="json").status_code, 400)
        self.assertEqual(self.client.patch(f"/api/tasks/{child_id}/", {"parent_task": child_id}, format="json").status_code, 400)
        self.assertEqual(self.client.get("/api/tasks/", {"parent_task": self.parent.id}).data[0]["id"], child_id)

    def test_deleting_parent_keeps_child(self):
        child = Task.objects.create(title="Подготовка", parent_task=self.parent, assignee=self.manager, created_by=self.manager)
        self.assertEqual(self.client.delete(f"/api/tasks/{self.parent.id}/").status_code, 204)
        child.refresh_from_db()
        self.assertIsNone(child.parent_task_id)
