from django.core.cache import cache
from django.test import override_settings
from rest_framework import status
from rest_framework.test import APITestCase

from .models import CalculatorSettings, default_workspace


@override_settings(SECURE_SSL_REDIRECT=False)
class PublicDesignerChatTests(APITestCase):
    def setUp(self):
        cache.clear()
        catalog = {
            "constructions": [{
                "id": "6747", "title": "Перегородка", "shortTitle": "Перегородка", "sketch": "panel",
                "fields": [
                    {"key": "HEIGHT_0", "label": "Высота", "min": 1000, "max": 2500},
                    {"key": "WIDTH_0", "label": "Ширина", "min": 200, "max": 2500},
                ],
                "hardwareComponents": [
                    {"id": "hinge-6", "hardwareItemId": "hinge-6", "quantity": 2, "glassThickness": 6},
                    {"id": "hinge-8", "hardwareItemId": "hinge-8", "quantity": 2, "glassThickness": 8},
                    {"id": "handle", "hardwareItemId": "handle", "quantity": 1},
                ],
            }],
            "hardware": [{"id": "chrome", "label": "Глянцевый хром"}, {"id": "black", "label": "Чёрный матовый"}],
            "hardwareItems": [
                {"id": "hinge-6", "label": "Петля 6 мм", "sourceUrl": "https://example.com/6"},
                {"id": "hinge-8", "label": "Петля 8 мм", "sourceUrl": "https://example.com/8", "technicalData": {"drawingUrl": "https://example.com/8.pdf", "sourceStatus": "linked", "features": {"Толщина стекла": "8 мм, 10 мм"}, "review": {"status": "pending"}}},
                {"id": "handle", "label": "Ручка", "sourceUrl": "https://example.com/handle", "technicalData": {"features": {"Толщина стекла": "8 мм, 10 мм"}}},
            ],
        }
        CalculatorSettings.objects.update_or_create(
            workspace=default_workspace(), defaults={"shower_catalog": catalog, "mirror_catalog": {}}
        )

    def _answer(self, response, value):
        return self.client.post(
            "/api/public-production/chat/",
            {"message": str(value), "option_value": str(value), "state_token": response.data["state_token"]},
            format="multipart",
        )

    def test_config_is_enabled_without_external_ai_key(self):
        response = self.client.get("/api/public-production/chat/")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertTrue(response.data["enabled"])
        self.assertEqual(response.data["mode"], "deterministic")

    def test_selected_model_starts_dimension_dialog(self):
        response = self.client.post(
            "/api/public-production/chat/",
            {"message": "Начать проект", "selected_model": "6747"},
            format="multipart",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["question_key"], "HEIGHT_0")
        self.assertEqual(response.data["project_title"], "Перегородка")

    def test_engine_selects_hardware_by_construction_and_glass_thickness(self):
        response = self.client.post("/api/public-production/chat/", {"option_value": "6747"}, format="multipart")
        answers = ["2000", "900 905", "0 0", "0", "90", "center", "8", "clear", "black", "no", "yes"]
        for answer in answers:
            response = self._answer(response, answer)
            self.assertEqual(response.status_code, status.HTTP_200_OK)

        labels = [row["label"] for row in response.data["hardware"]]
        self.assertIn("Петля 8 мм", labels)
        self.assertIn("Ручка", labels)
        self.assertNotIn("Петля 6 мм", labels)
        self.assertTrue(all("Чёрный матовый" in row["reason"] for row in response.data["hardware"]))
        self.assertEqual(next(row for row in response.data["hardware"] if row["catalog_id"] == "hinge-8")["documentation_status"], "linked")
        self.assertFalse(response.data["critical_checks"]["hardware_docs"])
        self.assertFalse(response.data["documents_unlocked"])
        self.assertIn("Технические карты", response.data["missing"][0])

    def test_invalid_measurement_keeps_current_question(self):
        response = self.client.post("/api/public-production/chat/", {"option_value": "6747"}, format="multipart")
        response = self._answer(response, "слишком высоко")
        self.assertEqual(response.data["question_key"], "HEIGHT_0")
        self.assertIn("одним числом", response.data["message"])

    def test_documented_hardware_restricts_glass_thickness(self):
        response = self.client.post("/api/public-production/chat/", {"option_value": "6747"}, format="multipart")
        for answer in ["2000", "900 905", "0 0", "0", "90", "center"]:
            response = self._answer(response, answer)
        self.assertEqual(response.data["question_key"], "glass_thickness")
        self.assertEqual(response.data["options"], [{"value": "8", "label": "8 мм"}])

    def test_tampered_state_is_discarded(self):
        response = self.client.post(
            "/api/public-production/chat/", {"message": "тест", "state_token": "tampered"}, format="multipart"
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["question_key"], "construction")
