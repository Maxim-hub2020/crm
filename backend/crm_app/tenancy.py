from .models import Workspace


DEFAULT_WORKSPACE_NAME = "Основная компания"
DEFAULT_WORKSPACE_SLUG = "default"


def ensure_default_workspace():
    workspace = Workspace.objects.order_by("id").first()
    if workspace:
        return workspace
    return Workspace.objects.create(name=DEFAULT_WORKSPACE_NAME, slug=DEFAULT_WORKSPACE_SLUG)


def ensure_user_workspace(user):
    if not user or not getattr(user, "is_authenticated", False):
        return None

    if getattr(user, "workspace_id", None):
        return user.workspace

    workspace = ensure_default_workspace()
    user.workspace = workspace
    user.save(update_fields=["workspace"])
    return workspace


def current_workspace(user):
    return ensure_user_workspace(user)


def filter_by_workspace(queryset, workspace, field_name="workspace"):
    if workspace is None:
        return queryset.none()
    return queryset.filter(**{field_name: workspace})
