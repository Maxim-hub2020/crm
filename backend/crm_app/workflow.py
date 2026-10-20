from datetime import timedelta
from decimal import Decimal

from django.utils import timezone

from .finance_analytics import build_project_finance_analytics
from .models import AuditLog, ProjectStatus, Task, TaskTemplate


def user_display_name(user):
    if not user:
        return ""
    return user.get_full_name() or user.username or f"User #{user.pk}"


def snapshot_model(instance, fields):
    if instance is None:
        return None

    data = {}
    for field in fields:
        value = getattr(instance, field, None)
        if hasattr(value, "isoformat"):
            value = value.isoformat()
        elif isinstance(value, Decimal):
            value = str(value)
        elif hasattr(value, "pk"):
            value = value.pk
        data[field] = value
    return data


def create_audit_log(actor, entity_type, entity_id, action, before=None, after=None, workspace=None):
    if not actor or not getattr(actor, "is_authenticated", False):
        return None

    return AuditLog.objects.create(
        workspace=workspace or getattr(actor, "workspace", None),
        actor=actor,
        entity_type=entity_type,
        entity_id=str(entity_id),
        action=action,
        before_json=before,
        after_json=after,
    )


def apply_task_templates_for_project(project, actor=None):
    if not project or not project.status:
        return []

    status = ProjectStatus.objects.filter(workspace=project.workspace, code=project.status).first()
    if not status:
        return []

    templates = TaskTemplate.objects.filter(workspace=project.workspace, status=status, auto_create=True).order_by("sort_order", "id")
    created = []
    today = timezone.localdate()

    for template in templates:
        exists = Task.objects.filter(project=project, title=template.title).exists()
        if exists:
            continue

        created.append(
            Task.objects.create(
                title=template.title,
                project=project,
                notes=template.notes,
                due_date=today + timedelta(days=int(template.due_in_days or 0)) if template.due_in_days is not None else None,
                priority=template.priority,
                assignee=project.manager,
                created_by=actor or project.manager,
            )
        )

    return created


def build_project_status_check(project):
    analytics = build_project_finance_analytics(project)
    open_tasks_count = Task.objects.filter(project=project, status=Task.Status.OPEN).count()
    status = ProjectStatus.objects.filter(workspace=project.workspace, code=project.status).first()
    issues = []

    if not project.client_id and not (project.client_name or "").strip():
        issues.append(
            {
                "key": "client_missing",
                "severity": "error",
                "title": "Не указан клиент",
                "message": "Перед закрытием проекта нужно выбрать или создать клиента.",
            }
        )

    if not project.total_amount:
        issues.append(
            {
                "key": "total_missing",
                "severity": "warning",
                "title": "Не указана сумма проекта",
                "message": "Без суммы система не сможет проверить оплату, маржу и прогноз.",
            }
        )

    if open_tasks_count:
        issues.append(
            {
                "key": "open_tasks",
                "severity": "warning",
                "title": f"Открытые задачи: {open_tasks_count}",
                "message": "Проверьте задачи перед переводом проекта дальше.",
            }
        )

    if analytics.get("expense_review_active"):
        missing = analytics.get("missing_required_expenses") or []
        if missing:
            issues.append(
                {
                    "key": "missing_expenses",
                    "severity": "warning",
                    "title": "Не все обязательные расходы внесены",
                    "message": "Проверьте: " + ", ".join(missing) + ".",
                }
            )

        if not analytics.get("paid_in_full"):
            issues.append(
                {
                    "key": "income_not_closed",
                    "severity": "warning",
                    "title": "Оплата клиента не закрывает сумму проекта",
                    "message": "Сверьте сумму проекта и внесенные доходы.",
                }
            )

        if analytics.get("low_margin"):
            issues.append(
                {
                    "key": "low_margin",
                    "severity": "warning",
                    "title": "Маржа ниже 30%",
                    "message": "Проект требует проверки себестоимости и цен.",
                }
            )

    return {
        "project": project.id,
        "status": project.status,
        "status_name": status.name if status else project.status,
        "can_continue": not any(issue["severity"] == "error" for issue in issues),
        "issues": issues,
        "analytics": analytics,
    }
