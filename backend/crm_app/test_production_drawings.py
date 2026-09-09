import json
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

from .models import User, Workspace
from .production_drawings import normalize_production_plan


class TestProductionDrawingAnalysis(APITestCase):
    password = "StrongPass123!"

    def setUp(self):
        workspace = Workspace.objects.create(name="Цех", slug="production-drawing-test")
        self.admin = User.objects.create_user(
            username="production.admin",
            password=self.password,
            role=User.Role.ADMIN,
            workspace=workspace,
        )
        self.manager = User.objects.create_user(
            username="production.manager",
            password=self.password,
            role=User.Role.MANAGER,
            workspace=workspace,
        )

    def auth_client(self, user):
        client = APIClient()
        response = client.post(
            "/api/auth/token/",
            {"username": user.username, "password": self.password},
            format="json",
        )
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {response.data['access']}")
        return client

    @patch("crm_app.views.analyze_production_plan")
    def test_admin_can_analyze_plan_image(self, analyze_mock):
        analyze_mock.return_value = {
            "summary": "Г-образная конфигурация",
            "confidence": 0.91,
            "panels": [],
            "operations": [],
            "recognizedDimensions": [],
            "warnings": ["Проверить зазоры"],
            "needsReview": True,
        }
        image = SimpleUploadedFile("plan.jpg", b"jpeg-image", content_type="image/jpeg")
        response = self.auth_client(self.admin).post(
            "/api/calculator-production/analyze/",
            {"image": image, "context": json.dumps({"construction": "Г-образная"})},
            format="multipart",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertTrue(response.data["needsReview"])
        analyze_mock.assert_called_once()

    def test_manager_cannot_analyze_plan_image(self):
        image = SimpleUploadedFile("plan.jpg", b"jpeg-image", content_type="image/jpeg")
        response = self.auth_client(self.manager).post(
            "/api/calculator-production/analyze/",
            {"image": image, "context": "{}"},
            format="multipart",
        )
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_rejects_unsupported_file_type(self):
        image = SimpleUploadedFile("plan.pdf", b"pdf", content_type="application/pdf")
        response = self.auth_client(self.admin).post(
            "/api/calculator-production/analyze/",
            {"image": image, "context": "{}"},
            format="multipart",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_normalization_never_marks_analysis_as_ready(self):
        result = normalize_production_plan(
            {
                "summary": "Проверено моделью",
                "confidence": 5,
                "panels": [{"label": "Дверь", "shape": "rectangle", "widthMm": 700, "heightMm": 2000}],
                "operations": [{"kind": "hole", "label": "Ручка", "confirmedFromSource": False}],
                "recognizedDimensions": [],
                "warnings": [],
                "needsReview": False,
            }
        )
        self.assertTrue(result["needsReview"])
        self.assertEqual(result["confidence"], 1)
        self.assertEqual(result["panels"][0]["quantity"], 1)
