from django.db import migrations, models


def copy_project_title_forward(apps, _schema_editor):
    Project = apps.get_model("crm_app", "Project")
    for project in Project.objects.filter(title=""):
        project.title = project.client_name or f"Проект #{project.id}"
        project.save(update_fields=["title"])


class Migration(migrations.Migration):

    dependencies = [
        ("crm_app", "0010_client_project_client"),
    ]

    operations = [
        migrations.AddField(
            model_name="project",
            name="title",
            field=models.CharField(blank=True, default="", max_length=200),
        ),
        migrations.RunPython(copy_project_title_forward, migrations.RunPython.noop),
    ]
