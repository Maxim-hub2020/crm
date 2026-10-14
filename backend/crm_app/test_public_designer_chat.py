from django.core.cache import cache
from django.test import override_settings
from rest_framework import status
from rest_framework.test import APITestCase
from unittest.mock import Mock, patch

from .models import CalculatorSettings, default_workspace


@override_settings(SECURE_SSL_REDIRECT=False)
class PublicDesignerChatTests(APITestCase):
    def setUp(self):
        cache.clear()
        catalog = {
            "constructions": [
                {"id": "niche", "title": "Дверь в нишу", "shortTitle": "Ниша", "sketch": "niche-door", "hardwareComponents": [{"hardwareItemId": "hinge-8", "quantity": 2, "glassThickness": 8}, {"hardwareItemId": "handle", "quantity": 1}]},
                {"id": "corner", "title": "Угловая распашная", "shortTitle": "Угловая", "sketch": "corner-door", "hardwareComponents": [{"hardwareItemId": "hinge-8", "quantity": 2, "glassThickness": 8}, {"hardwareItemId": "handle", "quantity": 1}]},
            ],
            "hardware": [{"id": "chrome", "label": "Глянцевый хром"}, {"id": "black", "label": "Чёрный матовый"}],
            "hardwareItems": [
                {"id": "hinge-8", "label": "Петля 8 мм", "sourceUrl": "https://example.com/8", "technicalData": {"drawingUrl": "https://example.com/8.pdf", "sourceStatus": "linked", "features": {"Толщина стекла": "8 мм, 10 мм"}, "review": {"status": "pending"}}},
                {"id": "handle", "label": "Ручка", "sourceUrl": "https://example.com/handle", "technicalData": {"features": {"Толщина стекла": "8 мм, 10 мм"}}},
            ],
        }
        CalculatorSettings.objects.update_or_create(workspace=default_workspace(), defaults={"shower_catalog": catalog, "mirror_catalog": {}})

    def _answer(self, response, value):
        return self.client.post("/api/public-production/chat/", {"message": str(value), "option_value": str(value), "state_token": response.data["state_token"]}, format="multipart")

    def _start(self, shape="l-shaped"):
        response = self.client.post("/api/public-production/chat/", {"option_value": shape}, format="multipart")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        return response

    def test_config_is_enabled_without_external_ai_key(self):
        response = self.client.get("/api/public-production/chat/")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertTrue(response.data["enabled"])
        self.assertEqual(response.data["mode"], "deterministic")

    def test_dialog_starts_with_two_visual_tray_shapes(self):
        response = self.client.post("/api/public-production/chat/", {}, format="multipart")
        self.assertEqual(response.data["question_key"], "tray_shape")
        self.assertEqual([row["value"] for row in response.data["options"]], ["wall-to-wall", "l-shaped"])
        self.assertTrue(all(row.get("image") for row in response.data["options"]))

    def test_shape_starts_simple_width_and_depth_dialog(self):
        response = self._start("wall-to-wall")
        self.assertEqual(response.data["question_key"], "overall_width")
        response = self._answer(response, "2000")
        self.assertEqual(response.data["question_key"], "overall_depth")

    def test_center_axis_and_nominal_infill_are_calculated(self):
        response = self._start()
        for answer in ["2000", "1000", "90", "center"]:
            response = self._answer(response, answer)
        layout = response.data["layout"]
        self.assertEqual(layout["axis_offset"], 45)
        self.assertTrue(any(row["label"] == "Фронтальный неподвижный добор" and row["nominal"] == "1300 мм" for row in layout["panels"]))
        self.assertTrue(any(row["label"] == "Боковое неподвижное стекло" and row["nominal"] == "1000 мм" for row in layout["panels"]))

    def test_tile_joint_requires_edge_and_offset_inside_tray(self):
        response = self._start()
        for answer in ["2000", "1000", "90", "tile-joint", "outer"]:
            response = self._answer(response, answer)
        response = self._answer(response, "95")
        self.assertEqual(response.data["question_key"], "joint_offset")
        self.assertIn("внутри порожка", response.data["message"])
        response = self._answer(response, "42")
        self.assertEqual(response.data["layout"]["axis_offset"], 42)

    def test_engine_selects_hardware_after_customer_preferences(self):
        response = self._start()
        for answer in ["2000", "1000", "90", "center", "out-left", "8", "clear", "black", "no"]:
            response = self._answer(response, answer)
        self.assertEqual([row["label"] for row in response.data["hardware"]], ["Петля 8 мм", "Ручка"])
        self.assertTrue(all("Чёрный матовый" in row["reason"] for row in response.data["hardware"]))
        self.assertFalse(response.data["documents_unlocked"])

    def test_invalid_measurement_keeps_current_question(self):
        response = self._answer(self._start(), "очень широко")
        self.assertEqual(response.data["question_key"], "overall_width")
        self.assertIn("одним числом", response.data["message"])

    @patch.dict("os.environ", {"OPENAI_DESIGNER_ENABLED": "true", "OPENAI_API_KEY": "test-key"})
    @patch("crm_app.public_ai_technologist.requests.post")
    def test_ai_technologist_uses_responses_api_with_public_mcp_only(self, mocked_post):
        mocked_post.return_value = Mock(
            status_code=200,
            json=lambda: {"id": "resp_test", "output": [{"type": "message", "content": [{"type": "output_text", "text": "Назовите ширину поддона в миллиметрах."}]}]},
            raise_for_status=lambda: None,
        )
        response = self._start()
        self.assertTrue(response.data["ai_connected"])
        self.assertEqual(response.data["message"], "Назовите ширину поддона в миллиметрах.")
        payload = mocked_post.call_args.kwargs["json"]
        self.assertEqual(payload["tools"][0]["type"], "mcp")
        self.assertEqual(payload["tools"][0]["allowed_tools"], ["public_shower_technologist_context"])

    def test_tampered_state_is_discarded(self):
        response = self.client.post("/api/public-production/chat/", {"message": "тест", "state_token": "tampered"}, format="multipart")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["question_key"], "tray_shape")
