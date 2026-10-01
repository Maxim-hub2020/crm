from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import crm_app.models


class Migration(migrations.Migration):
    dependencies = [("crm_app", "0040_productionplan"), migrations.swappable_dependency(settings.AUTH_USER_MODEL)]
    operations = [
        migrations.CreateModel(
            name="MeasurementSheet",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("data", models.JSONField(blank=True, default=dict)),
                ("is_complete", models.BooleanField(default=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("created_by", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="created_measurement_sheets", to=settings.AUTH_USER_MODEL)),
                ("project", models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name="measurement_sheet", to="crm_app.project")),
                ("workspace", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="measurement_sheets", to="crm_app.workspace")),
            ],
        ),
        migrations.CreateModel(
            name="MeasurementPhoto",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("file", models.FileField(upload_to=crm_app.models.measurement_photo_upload_to)),
                ("original_name", models.CharField(blank=True, default="", max_length=255)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("sheet", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="photos", to="crm_app.measurementsheet")),
            ],
        ),
    ]
