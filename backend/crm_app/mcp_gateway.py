import base64
import hashlib
import json
from pathlib import Path

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from rest_framework.test import APIRequestFactory, force_authenticate

from .mcp_oauth import authenticate_mcp_request, canonical_resource


SKILL_ROOT = Path(__file__).resolve().parent / "mcp_skills"

RESOURCE_VIEWSETS = {
    "clients": "ClientViewSet",
    "projects": "ProjectViewSet",
    "payments": "PaymentViewSet",
    "project-comments": "ProjectCommentViewSet",
    "production-plans": "ProductionPlanViewSet",
    "measurement-sheets": "MeasurementSheetViewSet",
    "measurement-scans": "MeasurementScanSessionViewSet",
    "project-statuses": "ProjectStatusViewSet",
    "finance-categories": "FinanceCategoryViewSet",
    "accounts": "AccountViewSet",
    "project-custom-fields": "ProjectCustomFieldViewSet",
    "document-templates": "DocumentTemplateViewSet",
    "tasks": "TaskViewSet",
    "task-templates": "TaskTemplateViewSet",
    "audit-logs": "AuditLogViewSet",
    "users": "UserViewSet",
}


def _resource_enum():
    return sorted(RESOURCE_VIEWSETS)


OAUTH_SCHEME = {"type": "oauth2", "scopes": ["crm.read", "crm.write", "crm.admin"]}

TOOLS = [
    {
        "name": "crm_profile",
        "title": "Профиль CRM",
        "description": "Показать пользователя и рабочее пространство CRM, с которыми связано текущее подключение.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "outputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "minLength": 1},
                "name": {"type": "string"},
                "email": {"type": "string"},
                "nickname": {"type": "string"},
            },
            "required": ["id"],
            "additionalProperties": False,
        },
        "securitySchemes": [OAUTH_SCHEME],
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
        "_meta": {"openai/profile": True},
    },
    {
        "name": "crm_list",
        "title": "Список объектов CRM",
        "description": "Показать объекты CRM с фильтрами и правами текущего пользователя.",
        "inputSchema": {"type": "object", "properties": {
            "resource": {"type": "string", "enum": _resource_enum()},
            "filters": {"type": "object", "additionalProperties": True},
        }, "required": ["resource"], "additionalProperties": False},
        "securitySchemes": [OAUTH_SCHEME],
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "crm_get",
        "title": "Карточка объекта CRM",
        "description": "Получить одну карточку CRM по типу и идентификатору.",
        "inputSchema": {"type": "object", "properties": {
            "resource": {"type": "string", "enum": _resource_enum()},
            "id": {"type": "integer", "minimum": 1},
        }, "required": ["resource", "id"], "additionalProperties": False},
        "securitySchemes": [OAUTH_SCHEME],
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "crm_create",
        "title": "Создать объект CRM",
        "description": "Создать проект, клиента, задачу, платёж, комментарий, замер или другой разрешённый объект CRM.",
        "inputSchema": {"type": "object", "properties": {
            "resource": {"type": "string", "enum": _resource_enum()},
            "data": {"type": "object", "additionalProperties": True},
            "confirm": {"type": "boolean", "description": "True только после явного подтверждения пользователя для финансовых и административных операций."},
        }, "required": ["resource", "data"], "additionalProperties": False},
        "securitySchemes": [OAUTH_SCHEME],
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "crm_update",
        "title": "Изменить объект CRM",
        "description": "Частично изменить существующий объект CRM. Перед финансовым или административным изменением подтвердить итог с пользователем.",
        "inputSchema": {"type": "object", "properties": {
            "resource": {"type": "string", "enum": _resource_enum()},
            "id": {"type": "integer", "minimum": 1},
            "data": {"type": "object", "additionalProperties": True},
            "confirm": {"type": "boolean", "description": "True только после явного подтверждения пользователя для финансовых и административных изменений."},
        }, "required": ["resource", "id", "data"], "additionalProperties": False},
        "securitySchemes": [OAUTH_SCHEME],
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "crm_delete",
        "title": "Удалить объект CRM",
        "description": "Удалить объект CRM. Всегда требует явного подтверждения пользователя и confirm=true.",
        "inputSchema": {"type": "object", "properties": {
            "resource": {"type": "string", "enum": _resource_enum()},
            "id": {"type": "integer", "minimum": 1},
            "confirm": {"type": "boolean", "const": True},
        }, "required": ["resource", "id", "confirm"], "additionalProperties": False},
        "securitySchemes": [OAUTH_SCHEME],
        "annotations": {"readOnlyHint": False, "destructiveHint": True, "openWorldHint": False},
    },
    {
        "name": "crm_search",
        "title": "Поиск по CRM",
        "description": "Найти проект, клиента, адрес, телефон или номер заказа по всей CRM.",
        "inputSchema": {"type": "object", "properties": {"query": {"type": "string", "minLength": 1}}, "required": ["query"], "additionalProperties": False},
        "securitySchemes": [OAUTH_SCHEME],
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "crm_action",
        "title": "Специальное действие CRM",
        "description": "Выполнить специальное действие: получить активность/проверки проекта, создать папку Яндекс.Диска, изменить публичную ссылку или утвердить производственный план.",
        "inputSchema": {"type": "object", "properties": {
            "action": {"type": "string", "enum": ["project_activity", "project_status_checks", "create_yandex_folder", "set_yandex_public_link", "approve_production_plan"]},
            "id": {"type": "integer", "minimum": 1},
            "data": {"type": "object", "additionalProperties": True},
            "confirm": {"type": "boolean"},
        }, "required": ["action", "id"], "additionalProperties": False},
        "securitySchemes": [OAUTH_SCHEME],
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": True},
    },
    {
        "name": "crm_upload_file",
        "title": "Загрузить файл в CRM",
        "description": "Прикрепить небольшой файл к полю проекта или опубликовать финальный PDF/DXF в папку «Чертежи» на Яндекс.Диске. Содержимое передаётся base64; максимум 8 МБ.",
        "inputSchema": {"type": "object", "properties": {
            "project_id": {"type": "integer", "minimum": 1},
            "target": {"type": "string", "enum": ["project_field", "drawings"]},
            "field_id": {"type": "integer", "minimum": 1},
            "filename": {"type": "string", "minLength": 1},
            "content_base64": {"type": "string", "minLength": 1},
            "confirm": {"type": "boolean", "const": True},
        }, "required": ["project_id", "target", "filename", "content_base64", "confirm"], "additionalProperties": False},
        "securitySchemes": [OAUTH_SCHEME],
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": True},
    },
]

for _tool in TOOLS:
    _tool.setdefault("outputSchema", {"type": "object", "additionalProperties": True})


def _rpc_result(message_id, result):
    return JsonResponse({"jsonrpc": "2.0", "id": message_id, "result": result})


def _rpc_error(message_id, code, message, data=None, status=200):
    error = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return JsonResponse({"jsonrpc": "2.0", "id": message_id, "error": error}, status=status)


def _tool_output(value, is_error=False):
    text = json.dumps(value, ensure_ascii=False, indent=2, default=str)
    result = {"content": [{"type": "text", "text": text}], "structuredContent": value}
    if is_error:
        result["isError"] = True
    return result


def _viewset(resource):
    from . import views
    name = RESOURCE_VIEWSETS.get(resource)
    if not name:
        raise ValueError(f"Неизвестный ресурс CRM: {resource}")
    return getattr(views, name)


def _dispatch_viewset(user, resource, operation, object_id=None, data=None, filters=None, action=None):
    factory = APIRequestFactory()
    path = f"/api/{resource}/" + (f"{object_id}/" if object_id else "")
    if operation == "list":
        req = factory.get(path, data=filters or {})
        mapping = {"get": "list"}
    elif operation == "retrieve":
        req = factory.get(path)
        mapping = {"get": "retrieve"}
    elif operation == "create":
        req = factory.post(path, data or {}, format="json")
        mapping = {"post": "create"}
    elif operation == "update":
        req = factory.patch(path, data or {}, format="json")
        mapping = {"patch": "partial_update"}
    elif operation == "delete":
        req = factory.delete(path)
        mapping = {"delete": "destroy"}
    elif operation == "action":
        req = factory.post(path, data or {}, format="json") if action not in {"activity", "status_checks"} else factory.get(path)
        mapping = {req.method.lower(): action}
    else:
        raise ValueError("Неподдерживаемая операция")
    force_authenticate(req, user=user)
    kwargs = {"pk": object_id} if object_id else {}
    response = _viewset(resource).as_view(mapping)(req, **kwargs)
    if response.status_code >= 400:
        raise ValueError({"status": response.status_code, "detail": response.data})
    return {"status": response.status_code, "data": getattr(response, "data", None)}


def _call_search(user, query):
    from .views import global_search_view
    req = APIRequestFactory().get("/api/global-search/", {"q": query})
    force_authenticate(req, user=user)
    response = global_search_view(req)
    if response.status_code >= 400:
        raise ValueError({"status": response.status_code, "detail": response.data})
    return response.data


def _call_action(user, args):
    action = args["action"]
    object_id = int(args["id"])
    data = args.get("data") or {}
    if action == "project_activity":
        return _dispatch_viewset(user, "projects", "action", object_id, action="activity")
    if action == "project_status_checks":
        return _dispatch_viewset(user, "projects", "action", object_id, action="status_checks")
    if action in {"create_yandex_folder", "set_yandex_public_link", "approve_production_plan"} and not args.get("confirm"):
        raise ValueError("Это действие требует явного подтверждения пользователя: confirm=true")
    if action == "create_yandex_folder":
        return _dispatch_viewset(user, "projects", "action", object_id, data, action="yandex_disk_folder")
    if action == "set_yandex_public_link":
        return _dispatch_viewset(user, "projects", "action", object_id, data, action="yandex_disk_public_link")
    if action == "approve_production_plan":
        return _dispatch_viewset(user, "production-plans", "action", object_id, {"confirm": True}, action="approve")
    raise ValueError(f"Неизвестное действие: {action}")


def _call_upload(user, args):
    from django.core.files.uploadedfile import SimpleUploadedFile
    from .views import ProjectViewSet
    try:
        content = base64.b64decode(args["content_base64"], validate=True)
    except (ValueError, TypeError) as exc:
        raise ValueError("Файл не является корректным base64") from exc
    if len(content) > 8 * 1024 * 1024:
        raise ValueError("Файл больше 8 МБ")
    filename = Path(args["filename"]).name
    if args["target"] == "drawings":
        if Path(filename).suffix.lower() not in {".pdf", ".dxf"}:
            raise ValueError("В папку «Чертежи» разрешены только PDF и DXF")
        from .models import Project
        from .tenancy import current_workspace
        from .yandex_disk import create_folder, ensure_project_disk_folder, get_yandex_disk_settings, join_disk_path, upload_bytes
        project = Project.objects.filter(pk=int(args["project_id"]), workspace=current_workspace(user)).first()
        if not project or (not user.is_admin() and project.manager_id != user.id):
            raise PermissionError("Проект не найден или недоступен")
        disk_settings = get_yandex_disk_settings(project.workspace)
        if not disk_settings.enabled or not disk_settings.oauth_token:
            raise ValueError("Яндекс.Диск не подключён в настройках CRM")
        if not project.yandex_disk_path:
            result = ensure_project_disk_folder(project, actor=user, force=True)
            project.refresh_from_db()
            if not result.get("ok"):
                raise ValueError(result)
        drawings_path = join_disk_path(project.yandex_disk_path, "Чертежи")
        create_folder(disk_settings.oauth_token, drawings_path)
        destination = join_disk_path(drawings_path, filename)
        upload_bytes(disk_settings.oauth_token, destination, content)
        return {"project": project.id, "filename": filename, "yandex_disk_path": destination}
    if not args.get("field_id"):
        raise ValueError("Для target=project_field требуется field_id")
    upload = SimpleUploadedFile(filename, content)
    req = APIRequestFactory().post(
        f"/api/projects/{int(args['project_id'])}/custom-field-files/",
        {"field_id": int(args["field_id"]), "files": [upload]},
        format="multipart",
    )
    force_authenticate(req, user=user)
    response = ProjectViewSet.as_view({"post": "upload_custom_field_file"})(req, pk=int(args["project_id"]))
    if response.status_code >= 400:
        raise ValueError({"status": response.status_code, "detail": response.data})
    return response.data


def _execute_tool(user, token_record, name, args):
    scopes = set(token_record.scope.split())
    read_tools = {"crm_profile", "crm_list", "crm_get", "crm_search"}
    if name in read_tools and "crm.read" not in scopes:
        raise PermissionError("Токен не имеет области crm.read")
    if name not in read_tools and "crm.write" not in scopes:
        raise PermissionError("Токен не имеет области crm.write")
    if name == "crm_profile":
        display_name = user.get_full_name().strip() or user.username
        workspace_name = getattr(getattr(user, "workspace", None), "name", "CRM")
        return {
            "id": f"crm-user-{user.pk}",
            "name": display_name,
            "email": user.email or "",
            "nickname": f"{display_name} — {workspace_name}",
        }
    if name == "crm_list":
        return _dispatch_viewset(user, args["resource"], "list", filters=args.get("filters"))
    if name == "crm_get":
        return _dispatch_viewset(user, args["resource"], "retrieve", int(args["id"]))
    if name == "crm_create":
        sensitive = args["resource"] in {"payments", "accounts", "users", "project-statuses", "finance-categories"}
        if sensitive and not args.get("confirm"):
            raise ValueError("Финансовая или административная операция требует confirm=true после подтверждения пользователя")
        return _dispatch_viewset(user, args["resource"], "create", data=args["data"])
    if name == "crm_update":
        sensitive = args["resource"] in {"payments", "accounts", "users", "project-statuses", "finance-categories"}
        if sensitive and not args.get("confirm"):
            raise ValueError("Финансовое или административное изменение требует confirm=true после подтверждения пользователя")
        return _dispatch_viewset(user, args["resource"], "update", int(args["id"]), args["data"])
    if name == "crm_delete":
        if not args.get("confirm"):
            raise ValueError("Удаление требует confirm=true после подтверждения пользователя")
        return _dispatch_viewset(user, args["resource"], "delete", int(args["id"]))
    if name == "crm_search":
        return _call_search(user, args["query"])
    if name == "crm_action":
        return _call_action(user, args)
    if name == "crm_upload_file":
        if not args.get("confirm"):
            raise ValueError("Загрузка требует confirm=true")
        return _call_upload(user, args)
    raise ValueError(f"Неизвестный инструмент: {name}")


def _skill_catalog():
    result = []
    if not SKILL_ROOT.exists():
        return result
    for manifest in sorted(SKILL_ROOT.glob("*/SKILL.md")):
        name = manifest.parent.name
        resources = []
        for path in sorted(p for p in manifest.parent.rglob("*") if p.is_file()):
            relative = path.relative_to(manifest.parent).as_posix()
            resources.append({
                "uri": f"skill://crm-production/{name}/{relative}",
                "digest": f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}",
            })
        text = manifest.read_text(encoding="utf-8")
        frontmatter = {}
        if text.startswith("---\n"):
            block = text.split("---\n", 2)[1]
            for line in block.splitlines():
                if ":" in line:
                    key, value = line.split(":", 1)
                    frontmatter[key.strip()] = value.strip()
        result.append({"uri": f"skill://crm-production/{name}/SKILL.md", "frontmatter": frontmatter, "resources": resources})
    return result


def _read_skill(uri):
    prefix = "skill://crm-production/"
    if not str(uri).startswith(prefix):
        raise ValueError("Неизвестный URI навыка")
    relative = str(uri)[len(prefix):]
    target = (SKILL_ROOT / relative).resolve()
    root = SKILL_ROOT.resolve()
    if root not in target.parents or not target.is_file():
        raise ValueError("Ресурс навыка не найден")
    return {"contents": [{"uri": uri, "mimeType": "text/markdown" if target.suffix.lower() == ".md" else "application/octet-stream", "text": target.read_text(encoding="utf-8")}]}


def _get_skill(uri):
    for skill in _skill_catalog():
        if skill["uri"] == uri:
            return {"skill": skill}
    raise ValueError("Навык не найден")


@csrf_exempt
@require_http_methods(["GET", "POST", "OPTIONS"])
def mcp_view(request):
    if request.method == "OPTIONS":
        response = JsonResponse({})
        response["Allow"] = "POST, GET, OPTIONS"
        return response
    if request.method == "GET":
        return JsonResponse({"name": "CEH CRM Production", "transport": "streamable_http", "status": "ok"})
    try:
        message = json.loads(request.body.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError):
        return _rpc_error(None, -32700, "Parse error")
    message_id = message.get("id")
    method = message.get("method")
    params = message.get("params") or {}
    if method == "initialize":
        return _rpc_result(message_id, {
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {"listChanged": False}, "resources": {}, "extensions": {"io.modelcontextprotocol/skills": {}}},
            "serverInfo": {"name": "ceh-crm-production", "version": "1.0.0"},
            "instructions": "Use CRM tools within the authenticated user's permissions. Confirm destructive, financial, approval, and administrative changes before calling write tools.",
        })
    if method in {"notifications/initialized", "ping"}:
        return _rpc_result(message_id, {})
    if method == "tools/list":
        return _rpc_result(message_id, {"tools": TOOLS})
    if method == "skills/list":
        return _rpc_result(message_id, {"skills": _skill_catalog()})
    if method in {"skills/get", "resources/read"}:
        try:
            payload = _get_skill(params.get("uri")) if method == "skills/get" else _read_skill(params.get("uri"))
            return _rpc_result(message_id, payload)
        except ValueError as exc:
            return _rpc_error(message_id, -32602, str(exc))
    if method != "tools/call":
        return _rpc_error(message_id, -32601, f"Метод не поддерживается: {method}")
    token_record = authenticate_mcp_request(request)
    if not token_record:
        metadata_url = request.build_absolute_uri("/.well-known/oauth-protected-resource")
        challenge = (
            f'Bearer resource_metadata="{metadata_url}", error="invalid_token", '
            'error_description="Sign in to CRM to continue"'
        )
        result = _rpc_result(message_id, {
            "content": [{"type": "text", "text": "Требуется вход в CRM"}],
            "isError": True,
            "_meta": {"mcp/www_authenticate": [challenge]},
        })
        result.status_code = 401
        result["WWW-Authenticate"] = challenge
        return result
    try:
        value = _execute_tool(token_record.user, token_record, params.get("name"), dict(params.get("arguments") or {}))
        return _rpc_result(message_id, _tool_output(value))
    except PermissionError as exc:
        return _rpc_result(message_id, _tool_output({"error": str(exc)}, is_error=True))
    except Exception as exc:
        return _rpc_result(message_id, _tool_output({"error": str(exc)}, is_error=True))
