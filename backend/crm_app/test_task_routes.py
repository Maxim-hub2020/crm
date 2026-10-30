from unittest.mock import patch

from rest_framework.test import APITestCase

from . import tests as api_tests
from .models import Task


class TestTaskRoutes(api_tests.AuthenticatedApiMixin, APITestCase):
    def setUp(self):
        self.manager = self.create_user("routes.manager")
        self.other_manager = self.create_user("routes.other")
        self.manager_task = Task.objects.create(
            title="Manager task", due_date="2026-05-25",
            assignee=self.manager, created_by=self.manager,
        )
        self.other_task = Task.objects.create(
            title="Other task", due_date="2026-05-26",
            assignee=self.other_manager, created_by=self.other_manager,
        )

    def test_location_and_schedule_round_trip_and_day_filter(self):
        client = self.auth_client_for(self.manager)
        response = client.post("/api/tasks/", {
            "title": "Монтаж", "scheduled_date": "2026-10-21",
            "due_date": "2026-10-23", "city": "Ростов-на-Дону",
            "district": "Западный", "address": "Адрес клиента, 1",
        }, format="json")
        self.assertEqual(response.status_code, 201)
        task_id = response.data["id"]
        response = client.get("/api/tasks/", {"date": "2026-10-21", "district": "Западный", "status": "open"})
        self.assertEqual([row["id"] for row in response.data], [task_id])
        self.assertEqual(response.data[0]["address"], "Адрес клиента, 1")
        self.assertEqual(client.get("/api/tasks/", {"date": "2026-10-23"}).data, [])
        response = client.patch(f"/api/tasks/{task_id}/", {"scheduled_date": "2026-10-22"}, format="json")
        self.assertEqual(response.data["due_date"], "2026-10-23")
        self.assertEqual(client.get("/api/tasks/", {"date": "2026-10-21"}).data, [])

    def test_day_filter_supports_legacy_and_preserves_permissions(self):
        client = self.auth_client_for(self.manager)
        response = client.get("/api/tasks/", {"date": "2026-05-25"})
        self.assertEqual([row["id"] for row in response.data], [self.manager_task.id])
        self.assertEqual(client.get("/api/tasks/", {"date": "2026-05-26"}).data, [])
        for invalid in ("bad-date", "2026-02-31"):
            self.assertEqual(client.get("/api/tasks/", {"date": invalid}).status_code, 400)

    @patch("crm_app.task_locations.suggest_dadata_address")
    def test_address_fills_city_and_business_zone(self, suggest_address):
        suggest_address.return_value = [{
            "value": "г Ростов-на-Дону, ул Еременко, д 50",
            "data": {
                "city": "Ростов-на-Дону",
                "city_district": "Советский район",
                "street": "Еременко",
            },
        }]
        client = self.auth_client_for(self.manager)

        response = client.post("/api/tasks/", {
            "title": "Выезд на объект",
            "address": "Еременко 50",
            "priority": "high",
        }, format="json")

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["city"], "Ростов-на-Дону")
        self.assertEqual(response.data["district"], "Западный")
        self.assertEqual(response.data["priority"], "high")

    @patch("crm_app.task_locations.suggest_dadata_address")
    def test_manual_city_and_district_are_preserved(self, suggest_address):
        client = self.auth_client_for(self.manager)

        response = client.post("/api/tasks/", {
            "title": "Закупка",
            "address": "Склад поставщика",
            "city": "Аксай",
            "district": "Промышленная зона",
        }, format="json")

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["city"], "Аксай")
        self.assertEqual(response.data["district"], "Промышленная зона")
        suggest_address.assert_not_called()

