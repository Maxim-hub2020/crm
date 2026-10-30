from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("crm_app", "0051_task_execution_location"),
    ]

    operations = [
        migrations.AddField(
            model_name="workspace",
            name="projects_view_mode",
            field=models.CharField(default="kanban", max_length=16),
        ),
    ]
