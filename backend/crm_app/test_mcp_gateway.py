import base64
import hashlib
import json
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

from django.test import TestCase, override_settings

from .models import Client, Project, ProjectComment, ProjectCustomField, User, Workspace


@override_settings(ALLOWED_HOSTS=["testserver"])
class RemoteMcpTests(TestCase):
    def setUp(self):
        self.workspace = Workspace.objects.create(name="Цех", slug="mcp-test")
        self.user = User.objects.create_user(
            username="master", password="strong-test-password", role=User.Role.ADMIN, workspace=self.workspace,
        )
        self.client_record = Client.objects.create(workspace=self.workspace, name="Клиент", phone="+79990000000")
        self.project = Project.objects.create(
            workspace=self.workspace,
            manager=self.user,
            client=self.client_record,
            client_name="Клиент",
            client_phone="+79990000000",
            title="Зеркало",
        )

    def connect(self):
        redirect_uri = "https://chatgpt.com/connector/oauth/test-callback"
        registration = self.client.post(
            "/api/mcp/oauth/register/",
            data=json.dumps({"client_name": "ChatGPT", "redirect_uris": [redirect_uri], "token_endpoint_auth_method": "none"}),
            content_type="application/json",
        )
        self.assertEqual(registration.status_code, 201)
        client_id = registration.json()["client_id"]
        verifier = "v" * 64
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        params = {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": "crm.read crm.write crm.admin",
            "state": "state-1",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "resource": "http://testserver/api/mcp",
            "username": "master",
            "password": "strong-test-password",
            "approve": "yes",
        }
        authorized = self.client.post("/api/mcp/oauth/authorize/", params)
        self.assertEqual(authorized.status_code, 302)
        code = parse_qs(urlsplit(authorized["Location"]).query)["code"][0]
        token = self.client.post("/api/mcp/oauth/token/", {
            "grant_type": "authorization_code",
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "resource": "http://testserver/api/mcp",
            "code": code,
            "code_verifier": verifier,
        })
        self.assertEqual(token.status_code, 200, token.content)
        return token.json()["access_token"]

    def rpc(self, method, params=None, token=None, message_id=1):
        headers = {"HTTP_AUTHORIZATION": f"Bearer {token}"} if token else {}
        return self.client.post(
            "/api/mcp/",
            data=json.dumps({"jsonrpc": "2.0", "id": message_id, "method": method, "params": params or {}}),
            content_type="application/json",
            **headers,
        )

    def test_discovery_and_oauth_metadata(self):
        metadata = self.client.get("/.well-known/oauth-protected-resource")
        self.assertEqual(metadata.status_code, 200)
        self.assertEqual(metadata.json()["resource"], "http://testserver/api/mcp")
        tools = self.rpc("tools/list")
        self.assertEqual(tools.status_code, 200)
        tool_items = tools.json()["result"]["tools"]
        self.assertIn("crm_search", {item["name"] for item in tool_items})
        self.assertIn("crm_resolve_project", {item["name"] for item in tool_items})
        upload_tool = next(item for item in tool_items if item["name"] == "crm_upload_file")
        self.assertEqual(upload_tool["_meta"]["openai/fileParams"], ["file"])
        file_schema = upload_tool["inputSchema"]["$defs"]["OpenAIFile"]
        self.assertEqual(file_schema["required"], ["download_url", "file_id"])
        self.assertEqual(
            set(file_schema["properties"]),
            {"download_url", "file_id", "mime_type", "file_name"},
        )
        skills = self.rpc("skills/list")
        self.assertEqual(skills.status_code, 200)
        self.assertEqual(
            {item["frontmatter"]["name"] for item in skills.json()["result"]["skills"]},
            {"crm-operator", "production-technologist"},
        )
        production = next(
            item for item in skills.json()["result"]["skills"]
            if item["frontmatter"]["name"] == "production-technologist"
        )
        fetched = self.rpc("skills/get", {"uri": production["uri"]})
        self.assertEqual(fetched.json()["result"]["skill"], production)
        resource = self.rpc("resources/read", {"uri": production["uri"]})
        self.assertIn("# Технолог производства", resource.json()["result"]["contents"][0]["text"])

    def test_authenticated_read_write_and_delete_confirmation(self):
        token = self.connect()
        profile = self.rpc("tools/call", {"name": "crm_profile", "arguments": {}}, token)
        self.assertEqual(profile.json()["result"]["structuredContent"]["id"], f"crm-user-{self.user.id}")
        result = self.rpc("tools/call", {"name": "crm_get", "arguments": {"resource": "projects", "id": self.project.id}}, token)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["result"]["structuredContent"]["data"]["id"], self.project.id)

        created = self.rpc("tools/call", {"name": "crm_create", "arguments": {
            "resource": "project-comments", "data": {"project": self.project.id, "text": "Проверено через MCP"},
        }}, token)
        self.assertFalse(created.json()["result"].get("isError", False), created.content)
        comment_id = ProjectComment.objects.get().id

        rejected = self.rpc("tools/call", {"name": "crm_delete", "arguments": {
            "resource": "project-comments", "id": comment_id, "confirm": False,
        }}, token)
        self.assertTrue(rejected.json()["result"]["isError"])
        self.assertTrue(ProjectComment.objects.filter(pk=comment_id).exists())

        deleted = self.rpc("tools/call", {"name": "crm_delete", "arguments": {
            "resource": "project-comments", "id": comment_id, "confirm": True,
        }}, token)
        self.assertFalse(deleted.json()["result"].get("isError", False), deleted.content)
        self.assertFalse(ProjectComment.objects.filter(pk=comment_id).exists())

        finance_rejected = self.rpc("tools/call", {"name": "crm_create", "arguments": {
            "resource": "payments", "data": {"project": self.project.id, "amount": "1000.00"},
        }}, token)
        self.assertTrue(finance_rejected.json()["result"]["isError"])

    def test_project_resolver_never_treats_order_number_as_internal_id(self):
        Project.objects.create(
            id=44,
            workspace=self.workspace,
            manager=self.user,
            client=self.client_record,
            order_number=14,
            client_name="Заказ 14",
            client_phone="+79992222222",
            title="Проект с внутренним ID 44",
        )
        target = Project.objects.create(
            id=45,
            workspace=self.workspace,
            manager=self.user,
            client=self.client_record,
            order_number=44,
            client_name="Заказ 44",
            client_phone="+79991111111",
            title="Зеркало на Левобережной",
            object_address="Левобережная 12",
        )
        token = self.connect()

        by_number = self.rpc("tools/call", {
            "name": "crm_resolve_project", "arguments": {"query": "заказ номер 44"},
        }, token).json()["result"]["structuredContent"]
        self.assertEqual(by_number["match_status"], "resolved")
        self.assertEqual(by_number["projects"][0]["project_id"], target.id)
        self.assertEqual(by_number["projects"][0]["order_number"], 44)
        self.assertNotEqual(by_number["projects"][0]["project_id"], 44)
        self.assertEqual(by_number["project"]["id"], target.id)
        self.assertEqual(by_number["project"]["order_number"], 44)

        by_address = self.rpc("tools/call", {
            "name": "crm_resolve_project", "arguments": {"query": "Левобережная"},
        }, token).json()["result"]["structuredContent"]
        self.assertEqual(by_address["match_status"], "resolved")
        self.assertEqual(by_address["projects"][0]["project_id"], target.id)

        comment = self.rpc("tools/call", {"name": "crm_create", "arguments": {
            "resource": "project-comments",
            "project_query": "Левобережная",
            "data": {"text": "Быстрая запись без отдельного поиска"},
        }}, token).json()["result"]
        self.assertFalse(comment.get("isError", False), comment)
        self.assertTrue(ProjectComment.objects.filter(
            project=target,
            text="Быстрая запись без отдельного поиска",
        ).exists())

    @patch("crm_app.mcp_gateway.requests.get")
    def test_chat_file_is_downloaded_and_attached_to_measurement_field(self, get_mock):
        ProjectCustomField.objects.create(
            workspace=self.workspace,
            name="Замер",
            field_type=ProjectCustomField.FieldType.FILE,
        )
        download = Mock()
        download.url = "https://files.example.test/download/file_123"
        download.history = []
        download.headers = {"Content-Length": "11", "Content-Type": "image/jpeg"}
        download.iter_content.return_value = [b"photo-bytes"]
        download.raise_for_status.return_value = None
        get_mock.return_value = download

        token = self.connect()
        response = self.rpc("tools/call", {"name": "crm_upload_file", "arguments": {
            "project_query": str(self.project.order_number),
            "target": "project_field",
            "file": {
                "download_url": "https://files.example.test/download/file_123",
                "file_id": "file_123",
                "mime_type": "image/jpeg",
                "file_name": "замер.jpg",
            },
            "confirm": True,
        }}, token)

        payload = response.json()["result"]
        self.assertFalse(payload.get("isError", False), payload)
        self.assertEqual(payload["structuredContent"]["uploaded"][0]["name"], "замер.jpg")
        self.assertEqual(payload["structuredContent"]["uploaded"][0]["content_type"], "image/jpeg")
        get_mock.assert_called_once_with(
            "https://files.example.test/download/file_123",
            stream=True,
            timeout=(5, 30),
            allow_redirects=True,
        )
        download.close.assert_called_once()

    def test_tool_call_requires_oauth(self):
        response = self.rpc("tools/call", {"name": "crm_search", "arguments": {"query": "0022"}})
        self.assertEqual(response.status_code, 401)
        self.assertIn("resource_metadata", response["WWW-Authenticate"])
