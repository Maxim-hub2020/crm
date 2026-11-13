from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("crm_app", "0053_task_parent_task")]

    operations = [
        migrations.AddField("client", "is_legal_entity", models.BooleanField(default=False)),
        migrations.AddField("client", "legal_details", models.JSONField(blank=True, default=dict)),
    ]
