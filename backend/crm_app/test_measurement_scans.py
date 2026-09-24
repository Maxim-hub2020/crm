from urllib.parse import parse_qs, urlparse

from rest_framework import status
from rest_framework.test import APIClient, APITestCase

from .models import MeasurementScanSession, Project, User, Workspace


class TestMeasurementScanSessions(APITestCase):
    password = "StrongPass123!"

    def setUp(self):
        self.workspace = Workspace.objects.create(name="LiDAR", slug="lidar-test")
        self.user = User.objects.create_user(
            username="lidar.manager",
            password=self.password,
            role=User.Role.MANAGER,
            workspace=self.workspace,
        )
        self.project = Project.objects.create(manager=self.user, title="Ванная", client_name="Клиент")
        self.client = APIClient()
        token_response = self.client.post(
            "/api/auth/token/",
            {"username": self.user.username, "password": self.password},
            format="json",
        )
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_response.data['access']}")

    def create_scan(self):
        response = self.client.post(
            "/api/measurement-scan-sessions/",
            {"project": self.project.id, "room_id": "room-bath", "room_name": "Ванная"},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        query = parse_qs(urlparse(response.data["launch_url"]).query)
        return response, query["token"][0]

    def test_create_complete_and_apply_scan(self):
        create_response, token = self.create_scan()
        session_id = create_response.data["id"]
        scan_result = {
            "wall": {
                "contour": [{"x": 0.05, "y": 0.1}, {"x": 0.95, "y": 0.1}, {"x": 0.95, "y": 0.9}, {"x": 0.05, "y": 0.9}],
                "confidence": 0.98,
            },
            "elements": [
                {"type": "socket_double", "x": 0.4, "y": 0.7, "width": 0.12, "height": 0.06, "confidence": 0.88},
                {"type": "power", "x": 0.7, "y": 0.3, "confidence": 0.71},
            ],
            "warnings": ["Проверить вывод питания"],
        }
        anonymous = APIClient()
        complete_response = anonymous.post(
            f"/api/measurement-scan-sessions/{session_id}/complete/",
            {"result": scan_result},
            format="json",
            HTTP_X_SCAN_TOKEN=token,
        )
        self.assertEqual(complete_response.status_code, status.HTTP_200_OK)
        self.assertEqual(complete_response.data["status"], MeasurementScanSession.Status.COMPLETED)

        retrieve_response = self.client.get(f"/api/measurement-scan-sessions/{session_id}/")
        self.assertEqual(retrieve_response.status_code, status.HTTP_200_OK)
        self.assertEqual(retrieve_response.data["result"]["elements"][0]["type"], "socket_double")

        applied_response = self.client.post(f"/api/measurement-scan-sessions/{session_id}/applied/", {}, format="json")
        self.assertEqual(applied_response.status_code, status.HTTP_200_OK)
        self.assertEqual(applied_response.data["status"], MeasurementScanSession.Status.APPLIED)

    def test_complete_rejects_wrong_token_and_invalid_coordinates(self):
        create_response, token = self.create_scan()
        session_id = create_response.data["id"]
        anonymous = APIClient()

        wrong_token_response = anonymous.post(
            f"/api/measurement-scan-sessions/{session_id}/complete/",
            {"result": {"wall": {"contour": []}, "elements": []}},
            format="json",
            HTTP_X_SCAN_TOKEN="wrong",
        )
        self.assertEqual(wrong_token_response.status_code, status.HTTP_403_FORBIDDEN)

        invalid_response = anonymous.post(
            f"/api/measurement-scan-sessions/{session_id}/complete/",
            {"result": {"wall": {"contour": [{"x": 2, "y": 0.5}]}, "elements": []}},
            format="json",
            HTTP_X_SCAN_TOKEN=token,
        )
        self.assertEqual(invalid_response.status_code, status.HTTP_400_BAD_REQUEST)
