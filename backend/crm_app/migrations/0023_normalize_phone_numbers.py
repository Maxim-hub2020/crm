import re

from django.db import migrations


def _format_phone(value):
    raw_value = str(value or "").strip()
    if not raw_value:
        return ""

    digits = re.sub(r"\D", "", raw_value)
    if len(digits) == 10:
        national = digits
    elif len(digits) == 11 and digits[0] in ("7", "8"):
        national = digits[1:]
    else:
        return raw_value

    return f"+7-{national[:3]}-{national[3:6]}-{national[6:8]}-{national[8:10]}"


def normalize_phone_numbers(apps, _schema_editor):
    Client = apps.get_model("crm_app", "Client")
    Project = apps.get_model("crm_app", "Project")

    for client in Client.objects.exclude(phone="").only("id", "workspace_id", "phone").iterator():
        normalized = _format_phone(client.phone)
        if normalized != client.phone:
            if Client.objects.exclude(pk=client.pk).filter(workspace_id=client.workspace_id, phone=normalized).exists():
                continue
            Client.objects.filter(pk=client.pk).update(phone=normalized)

    for project in Project.objects.exclude(client_phone="").only("id", "client_phone").iterator():
        normalized = _format_phone(project.client_phone)
        if normalized != project.client_phone:
            Project.objects.filter(pk=project.pk).update(client_phone=normalized)


class Migration(migrations.Migration):

    dependencies = [
        ("crm_app", "0022_client_bonuses"),
    ]

    operations = [
        migrations.RunPython(normalize_phone_numbers, migrations.RunPython.noop),
    ]
