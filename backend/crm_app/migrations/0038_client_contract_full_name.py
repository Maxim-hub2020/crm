from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("crm_app", "0037_calculatorquote_project_sync_disabled")]

    operations = [
        migrations.AddField(
            model_name="client",
            name="contract_full_name",
            field=models.CharField(blank=True, default="", max_length=300),
        ),
    ]
