from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("crm_app", "0027_project_yandex_disk_archived_at_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="client",
            name="apartment",
            field=models.CharField(blank=True, default="", max_length=50),
        ),
        migrations.AddField(
            model_name="client",
            name="floor",
            field=models.CharField(blank=True, default="", max_length=50),
        ),
    ]
