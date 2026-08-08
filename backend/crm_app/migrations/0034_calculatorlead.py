import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("crm_app", "0033_calculatorquote")]

    operations = [
        migrations.CreateModel(
            name="CalculatorLead",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("calculation_id", models.CharField(max_length=64, unique=True)),
                ("client_name", models.CharField(max_length=200)),
                ("client_phone", models.CharField(db_index=True, max_length=50)),
                ("client_email", models.EmailField(blank=True, default="", max_length=254)),
                ("product", models.CharField(max_length=20)),
                ("configuration", models.JSONField(default=dict)),
                ("amount", models.DecimalField(decimal_places=2, max_digits=12)),
                ("price_version", models.CharField(max_length=80)),
                ("source_url", models.URLField(blank=True, default="", max_length=1000)),
                ("referrer", models.URLField(blank=True, default="", max_length=1000)),
                ("utm", models.JSONField(blank=True, default=dict)),
                ("status", models.CharField(choices=[("new", "New"), ("in_progress", "In progress"), ("done", "Done")], db_index=True, default="new", max_length=20)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("workspace", models.ForeignKey(db_index=True, on_delete=django.db.models.deletion.CASCADE, related_name="calculator_leads", to="crm_app.workspace")),
            ],
            options={"ordering": ["-created_at", "-id"]},
        ),
    ]
