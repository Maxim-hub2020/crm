import base64
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

import requests
from django.conf import settings
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from rest_framework.test import APIRequestFactory, force_authenticate

from .mcp_oauth import authenticate_mcp_request, canonical_resource


SKILL_ROOT = Path(__file__).resolve().parent / "mcp_skills"
MAX_MCP_FILE_SIZE = 8 * 1024 * 1024

OPENAI_FILE_SCHEMA = {
    "type": "object",
    "properties": {
        "download_url": {"type": "string"},
        "file_id": {"type": "string"},
        "mime_type": {"type": "string"},
        "file_name": {"type": "string"},
    },
    "required": ["download_url", "file_id"],
    "additionalProperties": False,
}

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
        "name": "crm_resolve_project",
        "title": "Определить проект CRM",
        "description": "Быстро найти проект по номеру заказа, адресу, клиенту, телефону или названию и сразу получить полную карточку одним вызовом. Номер заказа — это не внутренний ID. Не вызывайте после этого crm_get для того же проекта.",
        "inputSchema": {"type": "object", "properties": {
            "query": {"type": "string", "minLength": 1, "description": "Известное пользователю обозначение: номер заказа, адрес, клиент, телефон или название проекта."},
        }, "required": ["query"], "additionalProperties": False},
        "securitySchemes": [OAUTH_SCHEME],
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "crm_get",
        "title": "Карточка объекта CRM",
        "description": "Получить одну карточку CRM по внутреннему идентификатору. Для проекта сначала вызовите crm_resolve_project: никогда не передавайте номер заказа в поле id.",
        "inputSchema": {"type": "object", "properties": {
            "resource": {"type": "string", "enum": _resource_enum()},
            "id": {"type": "integer", "minimum": 1, "description": "Внутренний ID объекта из результата CRM-инструмента; не номер заказа."},
        }, "required": ["resource", "id"], "additionalProperties": False},
        "securitySchemes": [OAUTH_SCHEME],
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "crm_create",
        "title": "Создать объект CRM",
        "description": "Создать проект, клиента, задачу, платёж, комментарий, замер или другой разрешённый объект CRM. Для объекта существующего проекта передайте известный пользователю номер, адрес, клиента или телефон в project_query: сервер сам найдёт внутренний project_id за один вызов.",
        "inputSchema": {"type": "object", "properties": {
            "resource": {"type": "string", "enum": _resource_enum()},
            "project_query": {"type": "string", "minLength": 1, "description": "Номер заказа, адрес, клиент, телефон или название проекта. Используйте для project-comments, payments, tasks, production-plans и measurement-sheets вместо предварительного поиска."},
            "data": {"type": "object", "additionalProperties": True},
            "confirm": {"type": "boolean", "description": "True только после явного подтверждения пользователя для финансовых и административных операций."},
        }, "required": ["resource", "data"], "additionalProperties": False},
        "securitySchemes": [OAUTH_SCHEME],
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "crm_update",
        "title": "Изменить объект CRM",
        "description": "Частично изменить существующий объект CRM. Для resource=projects можно передать номер заказа, адрес, клиента или телефон в project_query вместо внутреннего id. Перед финансовым или административным изменением подтвердить итог с пользователем.",
        "inputSchema": {"type": "object", "properties": {
            "resource": {"type": "string", "enum": _resource_enum()},
            "id": {"type": "integer", "minimum": 1, "description": "Внутренний ID объекта из результата CRM-инструмента; не номер заказа."},
            "project_query": {"type": "string", "minLength": 1, "description": "Только для resource=projects: номер заказа, адрес, клиент, телефон или название."},
            "data": {"type": "object", "additionalProperties": True},
            "confirm": {"type": "boolean", "description": "True только после явного подтверждения пользователя для финансовых и административных изменений."},
        }, "required": ["resource", "data"], "anyOf": [{"required": ["id"]}, {"required": ["project_query"]}], "additionalProperties": False},
        "securitySchemes": [OAUTH_SCHEME],
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False},
    },
    {
        "name": "crm_delete",
        "title": "Удалить объект CRM",
        "description": "Удалить объект CRM. Всегда требует явного подтверждения пользователя и confirm=true.",
        "inputSchema": {"type": "object", "properties": {
            "resource": {"type": "string", "enum": _resource_enum()},
            "id": {"type": "integer", "minimum": 1, "description": "Внутренний ID объекта из результата CRM-инструмента; не номер заказа."},
            "confirm": {"type": "boolean", "const": True},
        }, "required": ["resource", "id", "confirm"], "additionalProperties": False},
        "securitySchemes": [OAUTH_SCHEME],
        "annotations": {"readOnlyHint": False, "destructiveHint": True, "openWorldHint": False},
    },
    {
        "name": "crm_search",
        "title": "Поиск по CRM",
        "description": "Общий поиск проектов, клиентов, задач, финансов и комментариев. Для выбора проекта перед последующим действием используйте crm_resolve_project.",
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
            "id": {"type": "integer", "minimum": 1, "description": "Внутренний ID проекта или производственного плана из результата CRM-инструмента; не номер заказа."},
            "data": {"type": "object", "additionalProperties": True},
            "confirm": {"type": "boolean"},
        }, "required": ["action", "id"], "additionalProperties": False},
        "securitySchemes": [OAUTH_SCHEME],
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": True},
    },
    {
        "name": "crm_upload_file",
        "title": "Загрузить файл в CRM",
        "description": "Одним вызовом найти проект и прикрепить файл из текущего чата к его полю либо опубликовать финальный PDF/DXF в папку «Чертежи» на Яндекс.Диске. Предпочитайте project_query с номером заказа или адресом; project_id нужен только если уже известен. Максимум 8 МБ.",
        "inputSchema": {"type": "object", "$defs": {"OpenAIFile": OPENAI_FILE_SCHEMA}, "properties": {
            "project_id": {"type": "integer", "minimum": 1, "description": "Внутренний ID проекта, предварительно полученный через crm_resolve_project; не номер заказа."},
            "project_query": {"type": "string", "minLength": 1, "description": "Номер заказа, адрес, клиент, телефон или название проекта; позволяет найти проект и загрузить файл за один вызов."},
            "target": {"type": "string", "enum": ["project_field", "drawings"]},
            "field_id": {"type": "integer", "minimum": 1, "description": "Идентификатор файлового поля. Для поля «Замер» можно не указывать: CRM найдёт его автоматически."},
            "file": {"$ref": "#/$defs/OpenAIFile"},
            "filename": {"type": "string", "minLength": 1},
            "content_base64": {"type": "string", "minLength": 1},
            "confirm": {"type": "boolean", "const": True},
        }, "required": ["target", "confirm"], "allOf": [
            {"anyOf": [{"required": ["project_id"]}, {"required": ["project_query"]}]},
            {"anyOf": [{"required": ["file"]}, {"required": ["filename", "content_base64"]}]},
        ], "additionalProperties": False},
        "securitySchemes": [OAUTH_SCHEME],
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": True},
        "_meta": {"openai/fileParams": ["file"]},
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


def _project_candidate(project):
    return {
        "project_id": project.id,
        "order_number": project.order_number,
        "order_number_label": f"№{project.order_number:04d}" if project.order_number else "",
        "title": project.title,
        "client_name": project.client_name,
        "client_phone": project.client_phone,
        "object_address": project.object_address or "",
        "status": project.status,
    }


def _explicit_order_number(query):
    value = str(query or "").strip()
    match = re.fullmatch(
        r"(?:(?:заказ|проект)\s*)?(?:(?:номер|№|#)\s*)?0*(\d{1,6})",
        value,
        flags=re.IGNORECASE,
    )
    return int(match.group(1)) if match else None


def _call_resolve_project(user, query, include_card=True):
    from .models import Project
    from .tenancy import current_workspace

    value = str(query or "").strip()
    projects = Project.objects.filter(workspace=current_workspace(user)).select_related("client")
    if not user.is_admin():
        projects = projects.filter(manager=user)

    order_number = _explicit_order_number(value)
    if order_number is not None:
        candidates = [_project_candidate(project) for project in projects.filter(order_number=order_number)[:2]]
    else:
        search = _call_search(user, value)
        project_ids = [
            item.get("project_id") or item.get("id")
            for item in search.get("results", [])
            if item.get("type") == "project"
        ]
        by_id = {project.id: project for project in projects.filter(id__in=project_ids)}
        candidates = [_project_candidate(by_id[project_id]) for project_id in project_ids if project_id in by_id]

    if not candidates:
        status = "not_found"
        instruction = "Проект не найден. Не выполняйте запись и уточните у пользователя номер, адрес, клиента или телефон."
    elif len(candidates) == 1:
        status = "resolved"
        instruction = "Проект определён, полная карточка уже включена в project. Ответьте без дополнительного crm_get."
    else:
        status = "ambiguous"
        instruction = "Найдено несколько проектов. Покажите краткий список и попросите пользователя выбрать; до выбора ничего не изменяйте."
    result = {"query": value, "match_status": status, "projects": candidates, "instruction": instruction}
    if status == "resolved" and include_card:
        result["project"] = _dispatch_viewset(user, "projects", "retrieve", candidates[0]["project_id"])["data"]
    return result


def _resolve_project_id(user, query):
    result = _call_resolve_project(user, query, include_card=False)
    if result["match_status"] == "resolved":
        return int(result["projects"][0]["project_id"])
    if result["match_status"] == "ambiguous":
        labels = [
            " · ".join(filter(None, [project["order_number_label"], project["client_name"], project["object_address"]]))
            for project in result["projects"]
        ]
        raise ValueError({"detail": "Найдено несколько проектов", "projects": labels})
    raise ValueError("Проект не найден по номеру, адресу, клиенту, телефону или названию")


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


def _safe_download_url(value):
    url = str(value or "").strip()
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("ChatGPT передал некорректную ссылку на файл")
    return url


def _download_chat_file(file_ref):
    url = _safe_download_url(file_ref.get("download_url"))
    try:
        response = requests.get(url, stream=True, timeout=(5, 30), allow_redirects=True)
        response.raise_for_status()
    except requests.RequestException as exc:
        raise ValueError("Не удалось получить файл из текущего чата. Прикрепите его ещё раз.") from exc
    try:
        for hop in [*response.history, response]:
            _safe_download_url(hop.url)
    except ValueError:
        response.close()
        raise
    declared_size = response.headers.get("Content-Length")
    if declared_size:
        try:
            content_length = int(declared_size)
        except (TypeError, ValueError):
            content_length = 0
        if content_length > MAX_MCP_FILE_SIZE:
            response.close()
            raise ValueError("Файл больше 8 МБ")
    chunks = []
    total = 0
    try:
        for chunk in response.iter_content(chunk_size=64 * 1024):
            if not chunk:
                continue
            total += len(chunk)
            if total > MAX_MCP_FILE_SIZE:
                raise ValueError("Файл больше 8 МБ")
            chunks.append(chunk)
    finally:
        response.close()
    filename = Path(str(file_ref.get("file_name") or file_ref.get("file_id") or "chat-file")).name
    content_type = str(file_ref.get("mime_type") or response.headers.get("Content-Type") or "application/octet-stream").split(";", 1)[0]
    return b"".join(chunks), filename, content_type


def _upload_content(args):
    file_ref = args.get("file")
    if isinstance(file_ref, dict):
        return _download_chat_file(file_ref)
    try:
        content = base64.b64decode(args["content_base64"], validate=True)
    except (KeyError, ValueError, TypeError) as exc:
        raise ValueError("Передайте файл из чата в поле file") from exc
    if len(content) > MAX_MCP_FILE_SIZE:
        raise ValueError("Файл больше 8 МБ")
    return content, Path(args["filename"]).name, "application/octet-stream"


def _measurement_field_id(user):
    from .models import ProjectCustomField
    from .tenancy import current_workspace

    file_fields = ProjectCustomField.objects.filter(
        workspace=current_workspace(user),
        field_type=ProjectCustomField.FieldType.FILE,
    ).order_by("sort_order", "id")
    fields = [field for field in file_fields if "замер" in field.name.casefold()]
    exact = [field for field in fields if field.name.strip().casefold() == "замер"]
    if len(exact) == 1:
        return exact[0].id
    if len(fields) == 1:
        return fields[0].id
    if not fields:
        raise ValueError("В CRM не найдено файловое поле «Замер»")
    raise ValueError("Найдено несколько файловых полей замера; укажите field_id")


def _call_upload(user, args):
    from django.core.files.uploadedfile import SimpleUploadedFile
    from .views import ProjectViewSet
    args = dict(args)
    if args.get("project_query"):
        resolved_id = _resolve_project_id(user, args["project_query"])
        if args.get("project_id") and int(args["project_id"]) != resolved_id:
            raise ValueError("project_id не соответствует project_query")
        args["project_id"] = resolved_id
    if not args.get("project_id"):
        raise ValueError("Передайте project_query или внутренний project_id")
    content, filename, content_type = _upload_content(args)
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
    field_id = args.get("field_id") or _measurement_field_id(user)
    upload = SimpleUploadedFile(filename, content, content_type=content_type)
    request_host = next(
        (
            host
            for host in settings.ALLOWED_HOSTS
            if host not in {"*", "localhost", "127.0.0.1", "backend"} and not host.startswith(".")
        ),
        "localhost",
    )
    req = APIRequestFactory().post(
        f"/api/projects/{int(args['project_id'])}/custom-field-files/",
        {"field_id": int(field_id), "files": [upload]},
        format="multipart",
        HTTP_HOST=request_host,
        HTTP_X_FORWARDED_PROTO="https",
    )
    force_authenticate(req, user=user)
    response = ProjectViewSet.as_view({"post": "upload_custom_field_file"})(req, pk=int(args["project_id"]))
    if response.status_code >= 400:
        raise ValueError({"status": response.status_code, "detail": response.data})
    return response.data


def _execute_tool(user, token_record, name, args):
    scopes = set(token_record.scope.split())
    read_tools = {"crm_profile", "crm_list", "crm_resolve_project", "crm_get", "crm_search"}
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
    if name == "crm_resolve_project":
        return _call_resolve_project(user, args["query"])
    if name == "crm_get":
        return _dispatch_viewset(user, args["resource"], "retrieve", int(args["id"]))
    if name == "crm_create":
        sensitive = args["resource"] in {"payments", "accounts", "users", "project-statuses", "finance-categories"}
        if sensitive and not args.get("confirm"):
            raise ValueError("Финансовая или административная операция требует confirm=true после подтверждения пользователя")
        data = dict(args["data"])
        if args.get("project_query"):
            project_resources = {"payments", "project-comments", "production-plans", "measurement-sheets", "measurement-scans", "tasks"}
            if args["resource"] not in project_resources:
                raise ValueError("project_query поддерживается только для объектов, связанных с проектом")
            resolved_id = _resolve_project_id(user, args["project_query"])
            if data.get("project") and int(data["project"]) != resolved_id:
                raise ValueError("Поле project не соответствует project_query")
            data["project"] = resolved_id
        return _dispatch_viewset(user, args["resource"], "create", data=data)
    if name == "crm_update":
        sensitive = args["resource"] in {"payments", "accounts", "users", "project-statuses", "finance-categories"}
        if sensitive and not args.get("confirm"):
            raise ValueError("Финансовое или административное изменение требует confirm=true после подтверждения пользователя")
        object_id = args.get("id")
        if args.get("project_query"):
            if args["resource"] != "projects":
                raise ValueError("project_query при изменении поддерживается только для resource=projects")
            resolved_id = _resolve_project_id(user, args["project_query"])
            if object_id and int(object_id) != resolved_id:
                raise ValueError("id не соответствует project_query")
            object_id = resolved_id
        if not object_id:
            raise ValueError("Передайте id или project_query")
        return _dispatch_viewset(user, args["resource"], "update", int(object_id), args["data"])
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
            "instructions": "For fast voice replies, call crm_resolve_project once: it already returns the full project card, so do not follow it with crm_get. For project comments, tasks, payments, updates, and uploads, pass the user's order number, address, client, or phone directly as project_query in the write tool; do not pre-search unless the result is ambiguous. Never treat an order number as an internal ID. Confirm destructive, financial, approval, and administrative changes.",
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
