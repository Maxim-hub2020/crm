from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [("crm_app", "0052_workspace_projects_view_mode")]

    operations = [
        migrations.AddField(
            model_name="task",
            name="parent_task",
            field=models.ForeignKey(blank=True, db_index=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="subtasks", to="crm_app.task"),
        ),
    ]
