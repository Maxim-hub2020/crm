import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("crm_app", "0041_measurementsheet_measurementphoto"),
    ]

    operations = [
        migrations.CreateModel(
            name="MeasurementScanSession",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("room_id", models.CharField(max_length=120)),
                ("room_name", models.CharField(blank=True, default="", max_length=160)),
                ("token_hash", models.CharField(max_length=64)),
                ("status", models.CharField(choices=[("pending", "Pending"), ("completed", "Completed"), ("applied", "Applied"), ("expired", "Expired")], db_index=True, default="pending", max_length=20)),
                ("result", models.JSONField(blank=True, default=dict)),
                ("expires_at", models.DateTimeField(db_index=True)),
                ("completed_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("created_by", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="created_measurement_scan_sessions", to=settings.AUTH_USER_MODEL)),
                ("project", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="measurement_scan_sessions", to="crm_app.project")),
                ("workspace", models.ForeignKey(db_index=True, on_delete=django.db.models.deletion.CASCADE, related_name="measurement_scan_sessions", to="crm_app.workspace")),
            ],
            options={"ordering": ["-created_at"]},
        ),
    ]
