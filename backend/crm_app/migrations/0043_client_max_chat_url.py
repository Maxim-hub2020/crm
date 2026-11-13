from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("crm_app", "0042_measurementscansession"),
    ]

    operations = [
        migrations.AddField(
            model_name="client",
            name="max_chat_url",
            field=models.URLField(blank=True, default="", max_length=500),
        ),
    ]
