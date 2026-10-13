import json
from unittest.mock import Mock, patch

from django.test import override_settings
from rest_framework import status
from rest_framework.test import APITestCase


class PublicDesignerChatTests(APITestCase):
    def test_config_reports_disabled_without_key(self):
        with override_settings(OPENAI_API_KEY=""):
            response = self.client.get("/api/public-production/chat/")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertFalse(response.data["enabled"])

    @override_settings(OPENAI_API_KEY="test-key", OPENAI_CHATBOT_MODEL="gpt-test", CHATBOT_MCP_TOKEN="token", CHATBOT_MCP_URL="https://example.com/mcp")
    @patch("crm_app.public_designer_chat.requests.post")
    def test_chat_returns_structured_design_turn_and_restricts_mcp_tools(self, post):
        result = {
            "message": "Уточните ширину сверху и снизу.", "stage": "geometry", "progress": 30,
            "facts": [], "missing": ["Ширина сверху", "Ширина снизу"],
            "critical_checks": {"geometry": False, "levels": False, "opening": False, "glass": False, "hardware_docs": False, "client_confirmation": False},
            "hardware": [], "ready_for_final": False, "documents_unlocked": False,
        }
        mocked = Mock()
        mocked.raise_for_status.return_value = None
        mocked.json.return_value = {"id": "resp_123", "output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(result)}]}]}
        post.return_value = mocked

        response = self.client.post("/api/public-production/chat/", {"message": "Хочу угловую душевую"}, format="multipart")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["stage"], "geometry")
        self.assertTrue(response.data["mcp_connected"])
        sent = post.call_args.kwargs["json"]
        self.assertEqual(sent["tools"][0]["allowed_tools"], ["crm_calculator_catalog", "crm_calculate_product"])
        self.assertFalse(response.data["documents_unlocked"])

    @override_settings(OPENAI_API_KEY="test-key", CHATBOT_MCP_TOKEN="")
    def test_empty_turn_is_rejected(self):
        response = self.client.post("/api/public-production/chat/", {}, format="multipart")
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
