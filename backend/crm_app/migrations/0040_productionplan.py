from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("crm_app", "0039_workspace_hidden_menu_sections"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="ProductionPlan",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("revision", models.PositiveIntegerField(default=1)),
                ("product_type", models.CharField(choices=[("shower", "Shower"), ("mirror", "Mirror")], max_length=20)),
                ("status", models.CharField(choices=[("draft", "Draft"), ("needs_input", "Needs input"), ("ready_for_review", "Ready for review"), ("approved", "Approved")], db_index=True, default="draft", max_length=30)),
                ("summary", models.TextField(blank=True, default="")),
                ("specification", models.JSONField(blank=True, default=dict)),
                ("blocking_questions", models.JSONField(blank=True, default=list)),
                ("warnings", models.JSONField(blank=True, default=list)),
                ("source_files", models.JSONField(blank=True, default=list)),
                ("output_files", models.JSONField(blank=True, default=list)),
                ("approved_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("approved_by", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="approved_production_plans", to=settings.AUTH_USER_MODEL)),
                ("created_by", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="created_production_plans", to=settings.AUTH_USER_MODEL)),
                ("project", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="production_plans", to="crm_app.project")),
                ("workspace", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="production_plans", to="crm_app.workspace")),
            ],
            options={"ordering": ["-revision", "-id"]},
        ),
        migrations.AddConstraint(
            model_name="productionplan",
            constraint=models.UniqueConstraint(fields=("project", "revision"), name="unique_project_production_plan_revision"),
        ),
    ]
