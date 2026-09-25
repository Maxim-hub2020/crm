import json
import os
from html import escape
from urllib import error as urllib_error
from urllib import parse, request as urllib_request

from django.core import signing
from django.utils import timezone

from .models import ProjectStatus, Workspace, YandexDiskSettings


YANDEX_DISK_API_BASE = "https://cloud-api.yandex.net/v1/disk/resources"
YANDEX_DISK_MOVE_API = f"{YANDEX_DISK_API_BASE}/move"
YANDEX_DISK_UPLOAD_API = f"{YANDEX_DISK_API_BASE}/upload"
YANDEX_OAUTH_AUTHORIZE_URL = "https://oauth.yandex.ru/authorize"
YANDEX_OAUTH_TOKEN_URL = "https://oauth.yandex.ru/token"
YANDEX_DISK_WEB_BASE = "https://disk.yandex.ru/client/disk"
YANDEX_DISK_OAUTH_STATE_SALT = "crm-yandex-disk-oauth"
YANDEX_DISK_OAUTH_STATE_MAX_AGE_SECONDS = 15 * 60
PROJECT_FOLDER_SUBFOLDERS = [
    "Визуализация",
    "Закупочная смета",
    "Модель",
    "Раскрой",
    "Смета",
    "Согласование",
    "ТЗ",
    "Чертежи",
]


class YandexDiskError(Exception):
    pass


def yandex_disk_oauth_configured():
    return bool(_yandex_disk_client_id() and _yandex_disk_client_secret())


def build_yandex_disk_authorization_url(request, workspace):
    client_id = _yandex_disk_client_id()
    if not client_id:
        raise YandexDiskError("YANDEX_DISK_CLIENT_ID не настроен в backend .env.")
    if not _yandex_disk_client_secret():
        raise YandexDiskError("YANDEX_DISK_CLIENT_SECRET не настроен в backend .env.")

    state = signing.dumps(
        {"workspace_id": workspace.id, "nonce": timezone.now().timestamp()},
        salt=YANDEX_DISK_OAUTH_STATE_SALT,
    )
    query = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": yandex_disk_redirect_uri(request),
        "state": state,
        "force_confirm": "yes",
    }
    scopes = os.getenv("YANDEX_DISK_SCOPES", "").strip()
    if scopes:
        query["scope"] = scopes
    return f"{YANDEX_OAUTH_AUTHORIZE_URL}?{parse.urlencode(query)}"


def connect_yandex_disk_with_code(request, code, state):
    if not code:
        raise YandexDiskError("Яндекс не вернул код авторизации.")
    if not state:
        raise YandexDiskError("Яндекс не вернул state авторизации.")

    try:
        payload = signing.loads(
            state,
            salt=YANDEX_DISK_OAUTH_STATE_SALT,
            max_age=YANDEX_DISK_OAUTH_STATE_MAX_AGE_SECONDS,
        )
    except signing.BadSignature as exc:
        raise YandexDiskError("Сессия подключения Яндекс.Диска устарела или повреждена. Повторите подключение.") from exc

    workspace = Workspace.objects.filter(id=payload.get("workspace_id")).first()
    if not workspace:
        raise YandexDiskError("Компания для подключения Яндекс.Диска не найдена.")

    token_payload = exchange_yandex_disk_code(request, code)
    access_token = token_payload.get("access_token")
    if not access_token:
        raise YandexDiskError("Яндекс не вернул OAuth-токен.")

    settings = get_yandex_disk_settings(workspace)
    settings.oauth_token = access_token
    settings.enabled = True
    settings.save(update_fields=["oauth_token", "enabled", "updated_at"])
    return settings


def connect_yandex_disk_with_manual_code(request, workspace, code):
    if not code:
        raise YandexDiskError("Укажите код подтверждения Яндекс.Диска.")

    token_payload = exchange_yandex_disk_code(request, code)
    access_token = token_payload.get("access_token")
    if not access_token:
        raise YandexDiskError("Яндекс не вернул OAuth-токен.")

    settings = get_yandex_disk_settings(workspace)
    settings.oauth_token = access_token
    settings.enabled = True
    settings.save(update_fields=["oauth_token", "enabled", "updated_at"])
    return settings


def exchange_yandex_disk_code(request, code):
    client_id = _yandex_disk_client_id()
    client_secret = _yandex_disk_client_secret()
    if not client_id:
        raise YandexDiskError("YANDEX_DISK_CLIENT_ID не настроен в backend .env.")
    if not client_secret:
        raise YandexDiskError("YANDEX_DISK_CLIENT_SECRET не настроен в backend .env.")

    body = parse.urlencode(
        {
            "grant_type": "authorization_code",
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "device_name": "CEH CRM",
        }
    ).encode("utf-8")
    api_request = urllib_request.Request(
        YANDEX_OAUTH_TOKEN_URL,
        data=body,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib_request.urlopen(api_request, timeout=12) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib_error.HTTPError as exc:
        try:
            payload = json.loads(exc.read().decode("utf-8"))
        except Exception:
            payload = {}
        message = payload.get("error_description") or payload.get("message") or payload.get("description") or f"Yandex OAuth error {exc.code}"
        raise YandexDiskError(message) from exc
    except urllib_error.URLError as exc:
        raise YandexDiskError(f"Yandex OAuth connection error: {exc.reason}") from exc


def yandex_disk_redirect_uri(request):
    configured = os.getenv("YANDEX_DISK_REDIRECT_URI", "").strip()
    if configured:
        return configured
    return request.build_absolute_uri("/api/yandex-disk/oauth/callback/")


def project_folder_name(project):
    order_label = f"№{project.order_number:04d}" if project.order_number else f"Проект {project.id}"
    title = _sanitize_path_segment(project.title or project.client_name or "Проект")
    return f"{order_label} · {title}"


def yandex_disk_web_url(disk_path):
    clean_path = _strip_disk_prefix(disk_path)
    encoded_segments = [parse.quote(segment, safe="") for segment in clean_path.strip("/").split("/") if segment]
    return f"{YANDEX_DISK_WEB_BASE}/{'/'.join(encoded_segments)}" if encoded_segments else YANDEX_DISK_WEB_BASE


def ensure_project_disk_folder(project, actor=None, force=False):
    settings = get_yandex_disk_settings(project.workspace)
    if not settings.enabled or (not settings.auto_create_project_folders and not force):
        return {"ok": False, "skipped": True, "message": "Yandex Disk integration is disabled."}
    if not settings.oauth_token:
        message = "Yandex Disk OAuth token is not configured."
        _save_disk_error(project, message)
        return {"ok": False, "error": message}
    if project.yandex_disk_path and not force:
        return {"ok": True, "path": project.yandex_disk_path, "web_url": project.yandex_disk_web_url, "already_exists": True}

    base_path = normalize_disk_path(settings.base_path)
    folder_path = join_disk_path(base_path, project_folder_name(project))
    subfolders = normalize_folder_template(settings.folder_template)

    try:
        ensure_folder_tree(settings.oauth_token, base_path)
        create_folder(settings.oauth_token, folder_path)
        for subfolder in subfolders:
            create_folder(settings.oauth_token, join_disk_path(folder_path, subfolder))
    except YandexDiskError as exc:
        _save_disk_error(project, str(exc))
        return {"ok": False, "error": str(exc), "path": folder_path}

    web_url = yandex_disk_web_url(folder_path)
    project.yandex_disk_path = folder_path
    project.yandex_disk_web_url = web_url
    project.yandex_disk_created_at = timezone.now()
    project.yandex_disk_archived_at = None
    project.yandex_disk_error = ""
    project.save(update_fields=["yandex_disk_path", "yandex_disk_web_url", "yandex_disk_created_at", "yandex_disk_archived_at", "yandex_disk_error", "updated_at"])
    return {"ok": True, "path": folder_path, "web_url": web_url, "subfolders": subfolders}


def archive_project_disk_folder(project, actor=None, force=False):
    settings = get_yandex_disk_settings(project.workspace)
    if not settings.enabled:
        return {"ok": False, "skipped": True, "message": "Yandex Disk integration is disabled."}
    if not settings.oauth_token:
        message = "Yandex Disk OAuth token is not configured."
        _save_disk_error(project, message)
        return {"ok": False, "error": message}

    if not project.yandex_disk_path:
        created = ensure_project_disk_folder(project, actor=actor, force=force)
        project.refresh_from_db()
        if not created.get("ok"):
            return created

    archive_path = normalize_disk_path(settings.archive_path or "/CRM/Архив")
    destination_path = join_disk_path(archive_path, project_folder_name(project))
    if normalize_disk_path(project.yandex_disk_path) == normalize_disk_path(destination_path):
        if not project.yandex_disk_archived_at:
            project.yandex_disk_archived_at = timezone.now()
            project.yandex_disk_error = ""
            project.save(update_fields=["yandex_disk_archived_at", "yandex_disk_error", "updated_at"])
        return {"ok": True, "path": project.yandex_disk_path, "web_url": project.yandex_disk_web_url, "already_archived": True}

    try:
        ensure_folder_tree(settings.oauth_token, archive_path)
        move_resource(settings.oauth_token, project.yandex_disk_path, destination_path)
    except YandexDiskError as exc:
        _save_disk_error(project, str(exc))
        return {"ok": False, "error": str(exc), "path": destination_path}

    web_url = yandex_disk_web_url(destination_path)
    project.yandex_disk_path = destination_path
    project.yandex_disk_web_url = web_url
    project.yandex_disk_archived_at = timezone.now()
    project.yandex_disk_error = ""
    project.save(update_fields=["yandex_disk_path", "yandex_disk_web_url", "yandex_disk_archived_at", "yandex_disk_error", "updated_at"])
    return {"ok": True, "path": destination_path, "web_url": web_url, "archived": True}


def sync_measurement_drawings_to_yandex(sheet):
    project = sheet.project
    settings = get_yandex_disk_settings(project.workspace)
    if not settings.enabled:
        return {"ok": False, "skipped": True, "message": "Yandex Disk integration is disabled."}
    if not settings.oauth_token:
        return {"ok": False, "skipped": True, "message": "Yandex Disk OAuth token is not configured."}

    if not project.yandex_disk_path:
        created = ensure_project_disk_folder(project, actor=sheet.created_by, force=True)
        project.refresh_from_db()
        if not created.get("ok"):
            return created

    drawings_path = join_disk_path(project.yandex_disk_path, "Чертежи")
    data = sheet.data if isinstance(sheet.data, dict) else {}
    rooms = data.get("rooms") if isinstance(data.get("rooms"), list) else []
    if not rooms:
        rooms = [{"name": "Комната 1", "diagram": data.get("diagram") or {}}]

    try:
        create_folder(settings.oauth_token, drawings_path)
        upload_bytes(
            settings.oauth_token,
            join_disk_path(drawings_path, "Данные замера.json"),
            json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8"),
            "application/json; charset=utf-8",
        )
        for index, room in enumerate(rooms, start=1):
            filename = f"Замер - лист {index:02d}.svg"
            upload_bytes(
                settings.oauth_token,
                join_disk_path(drawings_path, filename),
                render_measurement_room_svg(room, index).encode("utf-8"),
                "image/svg+xml; charset=utf-8",
            )
    except (TypeError, ValueError, YandexDiskError) as exc:
        _save_disk_error(project, str(exc))
        return {"ok": False, "error": str(exc), "path": drawings_path}

    if project.yandex_disk_error:
        project.yandex_disk_error = ""
        project.save(update_fields=["yandex_disk_error", "updated_at"])
    return {"ok": True, "path": drawings_path, "files": len(rooms) + 1}


def render_measurement_room_svg(room, sheet_number=1):
    room = room if isinstance(room, dict) else {}
    diagram = room.get("diagram") if isinstance(room.get("diagram"), dict) else {}
    wall = diagram.get("wall") if isinstance(diagram.get("wall"), dict) else {}
    width = max(_safe_number(wall.get("width"), 2000), 100)
    height = max(_safe_number(wall.get("height"), 2600), 100)
    margin = max(min(width, height) * 0.06, 80)
    name = escape(str(room.get("name") or f"Комната {sheet_number}"))
    elements = diagram.get("elements") if isinstance(diagram.get("elements"), list) else []

    def sx(value):
        return _safe_number(value)

    def sy(value):
        return height - _safe_number(value)

    drawing = []
    points = wall.get("points") if isinstance(wall.get("points"), list) else []
    if len(points) >= 2:
        polygon = " ".join(f"{sx(point.get('x')):.2f},{sy(point.get('y')):.2f}" for point in points if isinstance(point, dict))
        drawing.append(f'<polygon points="{polygon}" class="wall"/>')
    else:
        drawing.append(f'<rect x="0" y="0" width="{width:.2f}" height="{height:.2f}" class="wall"/>')

    for element in elements:
        if not isinstance(element, dict) or element.get("side", "wall") != "wall":
            continue
        element_type = str(element.get("type") or "")
        label = escape(str(element.get("label") or "Элемент"))
        if element_type == "dimension":
            x1, y1 = sx(element.get("x1")), sy(element.get("y1"))
            x2, y2 = sx(element.get("x2")), sy(element.get("y2"))
            value = escape(str(element.get("value") or round(((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5)))
            mx, my = (x1 + x2) / 2, (y1 + y2) / 2
            drawing.append(f'<line x1="{x1:.2f}" y1="{y1:.2f}" x2="{x2:.2f}" y2="{y2:.2f}" class="dimension" marker-start="url(#arrow)" marker-end="url(#arrow)"/>')
            drawing.append(f'<text x="{mx:.2f}" y="{my - 18:.2f}" class="dimension-text">{value} мм</text>')
            continue

        x, y = sx(element.get("x")), sy(element.get("y"))
        element_width = max(_safe_number(element.get("width"), 60), 20)
        element_height = max(_safe_number(element.get("height"), 60), 20)
        if element_type == "cut_circle" or element_type.startswith("socket"):
            diameter = max(_safe_number(element.get("diameter"), element_height), 20)
            count = max(int(_safe_number(element.get("count"), 1)), 1)
            spacing = max(_safe_number(element.get("spacing"), 71), diameter)
            for item_index in range(count):
                cx = x - spacing * (count - 1) / 2 + item_index * spacing
                drawing.append(f'<circle cx="{cx:.2f}" cy="{y:.2f}" r="{diameter / 2:.2f}" class="object"/>')
        elif element_type == "light":
            drawing.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{max(element_width, element_height) / 2:.2f}" class="light"/>')
        elif element_type == "power":
            drawing.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{max(element_width, element_height) / 2:.2f}" class="power"/>')
        else:
            drawing.append(f'<rect x="{x - element_width / 2:.2f}" y="{y - element_height / 2:.2f}" width="{element_width:.2f}" height="{element_height:.2f}" class="object"/>')
        drawing.append(f'<text x="{x:.2f}" y="{y + element_height / 2 + 32:.2f}" class="object-text">{label}</text>')

    view_width = width + margin * 2
    view_height = height + margin * 2
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="{-margin:.2f} {-margin:.2f} {view_width:.2f} {view_height:.2f}">
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#0284c7"/></marker></defs>
  <style>.wall{{fill:#fffdf6;stroke:#0f172a;stroke-width:4;vector-effect:non-scaling-stroke}}.dimension{{stroke:#0284c7;stroke-width:2.5;vector-effect:non-scaling-stroke}}.dimension-text,.object-text{{font-family:Arial,sans-serif;font-size:28px;font-weight:700;text-anchor:middle;fill:#0f172a}}.object{{fill:#fff;stroke:#0f172a;stroke-width:3;vector-effect:non-scaling-stroke}}.light{{fill:#fef3c7;stroke:#0f172a;stroke-width:3;vector-effect:non-scaling-stroke}}.power{{fill:#e0f2fe;stroke:#0369a1;stroke-width:3;vector-effect:non-scaling-stroke}}.title{{font-family:Arial,sans-serif;font-size:34px;font-weight:700;fill:#0f172a}}</style>
  <rect x="{-margin:.2f}" y="{-margin:.2f}" width="{view_width:.2f}" height="{view_height:.2f}" fill="#ffffff"/>
  <text x="0" y="{-margin / 2:.2f}" class="title">Лист {sheet_number}. {name}</text>
  {''.join(drawing)}
</svg>'''


def upload_bytes(token, disk_path, content, content_type="application/octet-stream"):
    query = parse.urlencode({"path": normalize_disk_path(disk_path), "overwrite": "true"})
    link_request = urllib_request.Request(f"{YANDEX_DISK_UPLOAD_API}?{query}", method="GET", headers={"Authorization": f"OAuth {token}"})
    try:
        with urllib_request.urlopen(link_request, timeout=12) as response:
            upload_url = json.loads(response.read().decode("utf-8")).get("href")
        if not upload_url:
            raise YandexDiskError("Яндекс.Диск не вернул адрес загрузки файла.")
        upload_request = urllib_request.Request(upload_url, data=content, method="PUT", headers={"Content-Type": content_type})
        with urllib_request.urlopen(upload_request, timeout=20) as response:
            return response.status in (200, 201, 202)
    except urllib_error.HTTPError as exc:
        try:
            payload = json.loads(exc.read().decode("utf-8"))
        except Exception:
            payload = {}
        message = payload.get("message") or payload.get("description") or f"Yandex Disk API error {exc.code}"
        raise YandexDiskError(message) from exc
    except urllib_error.URLError as exc:
        raise YandexDiskError(f"Yandex Disk connection error: {exc.reason}") from exc


def _safe_number(value, fallback=0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(fallback)


def is_archive_project_status(project):
    statuses = ProjectStatus.objects.filter(workspace=project.workspace)
    latest_status = statuses.order_by("sort_order", "id").last()
    if statuses.count() > 1 and latest_status and project.status == latest_status.code:
        return True

    status = statuses.filter(code=project.status).first()
    status_text = " ".join(
        [
            str(project.status or ""),
            str(getattr(status, "name", "") or ""),
            str(getattr(status, "short_name", "") or ""),
        ]
    ).casefold()
    return any(marker in status_text for marker in ("заверш", "закры", "completed", "closed", "done", "finish"))


def is_application_project_status(project):
    status = ProjectStatus.objects.filter(workspace=project.workspace, code=project.status).first()
    values = {
        str(project.status or "").strip().casefold(),
        str(getattr(status, "name", "") or "").strip().casefold(),
    }
    return bool(values.intersection({"заявка", "заявки", "application", "applications", "lead", "leads"}))


def get_yandex_disk_settings(workspace):
    settings, _created = YandexDiskSettings.objects.get_or_create(workspace=workspace)
    return settings


def list_disk_folders(token, disk_path="disk:/"):
    url = f"{YANDEX_DISK_API_BASE}?{parse.urlencode({'path': normalize_disk_path(disk_path), 'limit': 200})}"
    api_request = urllib_request.Request(url, method="GET", headers={"Authorization": f"OAuth {token}"})
    try:
        with urllib_request.urlopen(api_request, timeout=12) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib_error.HTTPError as exc:
        try:
            payload = json.loads(exc.read().decode("utf-8"))
        except Exception:
            payload = {}
        message = payload.get("message") or payload.get("description") or f"Yandex Disk API error {exc.code}"
        raise YandexDiskError(message) from exc
    except urllib_error.URLError as exc:
        raise YandexDiskError(f"Yandex Disk connection error: {exc.reason}") from exc

    items = payload.get("_embedded", {}).get("items", [])
    folders = [
        {
            "name": item.get("name") or "",
            "path": normalize_disk_path(item.get("path") or ""),
            "modified": item.get("modified") or "",
        }
        for item in items
        if item.get("type") == "dir"
    ]
    folders.sort(key=lambda item: item["name"].casefold())
    return {"path": normalize_disk_path(payload.get("path") or disk_path), "folders": folders}


def normalize_folder_template(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            value = value.splitlines()
    if not isinstance(value, list):
        value = PROJECT_FOLDER_SUBFOLDERS

    folders = []
    for item in value:
        folder = _sanitize_path_segment(str(item or "").strip())
        if folder and folder not in folders:
            folders.append(folder)
    return folders or PROJECT_FOLDER_SUBFOLDERS


def normalize_disk_path(path):
    path = str(path or "").strip()
    if path.startswith("disk:/"):
        path = path[6:]
    path = "/" + path.strip("/")
    return f"disk:{path}"


def join_disk_path(parent_path, *segments):
    path = normalize_disk_path(parent_path)
    clean_segments = [_sanitize_path_segment(segment) for segment in segments]
    suffix = "/".join(segment for segment in clean_segments if segment)
    return f"{path.rstrip('/')}/{suffix}" if suffix else path


def ensure_folder_tree(token, disk_path):
    clean_path = _strip_disk_prefix(disk_path).strip("/")
    current = "disk:/"
    for segment in clean_path.split("/"):
        if not segment:
            continue
        current = join_disk_path(current, segment)
        create_folder(token, current)


def create_folder(token, disk_path):
    url = f"{YANDEX_DISK_API_BASE}?{parse.urlencode({'path': normalize_disk_path(disk_path)})}"
    api_request = urllib_request.Request(url, method="PUT", headers={"Authorization": f"OAuth {token}"})
    try:
        with urllib_request.urlopen(api_request, timeout=12) as response:
            if response.status in (200, 201, 202):
                return True
    except urllib_error.HTTPError as exc:
        if exc.code == 409:
            return True
        try:
            payload = json.loads(exc.read().decode("utf-8"))
        except Exception:
            payload = {}
        message = payload.get("message") or payload.get("description") or f"Yandex Disk API error {exc.code}"
        raise YandexDiskError(message) from exc
    except urllib_error.URLError as exc:
        raise YandexDiskError(f"Yandex Disk connection error: {exc.reason}") from exc

    return True


def move_resource(token, src_path, dst_path):
    query = parse.urlencode(
        {
            "from": normalize_disk_path(src_path),
            "path": normalize_disk_path(dst_path),
            "overwrite": "false",
        }
    )
    api_request = urllib_request.Request(f"{YANDEX_DISK_MOVE_API}?{query}", method="POST", headers={"Authorization": f"OAuth {token}"})
    try:
        with urllib_request.urlopen(api_request, timeout=15) as response:
            if response.status in (200, 201, 202):
                return True
    except urllib_error.HTTPError as exc:
        try:
            payload = json.loads(exc.read().decode("utf-8"))
        except Exception:
            payload = {}
        message = payload.get("message") or payload.get("description") or f"Yandex Disk API error {exc.code}"
        raise YandexDiskError(message) from exc
    except urllib_error.URLError as exc:
        raise YandexDiskError(f"Yandex Disk connection error: {exc.reason}") from exc

    return True


def _strip_disk_prefix(path):
    path = str(path or "").strip()
    return path[5:] if path.startswith("disk:") else path


def _sanitize_path_segment(value):
    segment = str(value or "").strip()
    for char in ('/', '\\', ':', '*', '?', '"', '<', '>', '|'):
        segment = segment.replace(char, " ")
    return " ".join(segment.split())[:120]


def _save_disk_error(project, message):
    project.yandex_disk_error = message
    project.save(update_fields=["yandex_disk_error", "updated_at"])


def _yandex_disk_client_id():
    return os.getenv("YANDEX_DISK_CLIENT_ID", "").strip()


def _yandex_disk_client_secret():
    return os.getenv("YANDEX_DISK_CLIENT_SECRET", "").strip()
