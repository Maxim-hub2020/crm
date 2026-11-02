from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("crm_app", "0038_client_contract_full_name"),
    ]

    operations = [
        migrations.AddField(
            model_name="workspace",
            name="hidden_menu_sections",
            field=models.JSONField(blank=True, default=list),
        ),
    ]
