from django.db import migrations, models


def seed_project_order_numbers(apps, _schema_editor):
    Project = apps.get_model("crm_app", "Project")
    for index, project in enumerate(Project.objects.order_by("created_at", "id"), start=1):
        project.order_number = index
        project.save(update_fields=["order_number"])


class Migration(migrations.Migration):

    dependencies = [
        ("crm_app", "0015_subscriptionplan_includes_assistant_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="project",
            name="order_number",
            field=models.PositiveIntegerField(blank=True, db_index=True, null=True, unique=True),
        ),
        migrations.RunPython(seed_project_order_numbers, migrations.RunPython.noop),
    ]
