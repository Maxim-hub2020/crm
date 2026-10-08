from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("crm_app", "0043_client_max_chat_url")]

    operations = [
        migrations.AddField(
            model_name="project",
            name="yandex_disk_public_url",
            field=models.URLField(blank=True, default="", max_length=1000),
        ),
    ]
