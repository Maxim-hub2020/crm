import json
from urllib import error as urllib_error
from urllib import parse, request

from django.utils import timezone

from .models import YandexDiskSettings


YANDEX_DISK_API_BASE = "https://cloud-api.yandex.net/v1/disk/resources"
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
    project.yandex_disk_error = ""
    project.save(update_fields=["yandex_disk_path", "yandex_disk_web_url", "yandex_disk_created_at", "yandex_disk_error", "updated_at"])
    return {"ok": True, "path": folder_path, "web_url": web_url, "subfolders": subfolders}


def get_yandex_disk_settings(workspace):
    settings, _created = YandexDiskSettings.objects.get_or_create(workspace=workspace)
    return settings


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
