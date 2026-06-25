import json
from urllib import error as urllib_error
from urllib import parse, request

from django.utils import timezone

from .models import ProjectStatus, YandexDiskSettings


YANDEX_DISK_API_BASE = "https://cloud-api.yandex.net/v1/disk/resources"
YANDEX_DISK_MOVE_API = f"{YANDEX_DISK_API_BASE}/move"
YANDEX_DISK_WEB_BASE = "https://disk.yandex.ru/client/disk"
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


def get_yandex_disk_settings(workspace):
    settings, _created = YandexDiskSettings.objects.get_or_create(workspace=workspace)
    return settings


def list_disk_folders(token, disk_path="disk:/"):
    url = f"{YANDEX_DISK_API_BASE}?{parse.urlencode({'path': normalize_disk_path(disk_path), 'limit': 200})}"
    api_request = request.Request(url, method="GET", headers={"Authorization": f"OAuth {token}"})
    try:
        with request.urlopen(api_request, timeout=12) as response:
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
    api_request = request.Request(url, method="PUT", headers={"Authorization": f"OAuth {token}"})
    try:
        with request.urlopen(api_request, timeout=12) as response:
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
    api_request = request.Request(f"{YANDEX_DISK_MOVE_API}?{query}", method="POST", headers={"Authorization": f"OAuth {token}"})
    try:
        with request.urlopen(api_request, timeout=15) as response:
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
