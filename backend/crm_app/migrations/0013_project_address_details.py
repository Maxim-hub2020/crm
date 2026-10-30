from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("crm_app", "0012_task_project"),
    ]

    operations = [
        migrations.AddField(
            model_name="project",
            name="object_lat",
            field=models.CharField(blank=True, max_length=32, null=True),
        ),
        migrations.AddField(
            model_name="project",
            name="object_lon",
            field=models.CharField(blank=True, max_length=32, null=True),
        ),
        migrations.AddField(
            model_name="project",
            name="apartment",
            field=models.CharField(blank=True, default="", max_length=50),
        ),
        migrations.AddField(
            model_name="project",
            name="entrance",
            field=models.CharField(blank=True, default="", max_length=50),
        ),
        migrations.AddField(
            model_name="project",
            name="floor",
            field=models.CharField(blank=True, default="", max_length=50),
        ),
    ]
