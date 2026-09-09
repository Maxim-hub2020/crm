import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("crm_app", "0021_project_client_set_null"),
    ]

    operations = [
        migrations.AddField(
            model_name="client",
            name="bonus_balance",
            field=models.DecimalField(decimal_places=2, default=0, max_digits=12),
        ),
        migrations.AddField(
            model_name="project",
            name="bonus_promo_code",
            field=models.CharField(blank=True, default="", max_length=5),
        ),
        migrations.AddField(
            model_name="project",
            name="referred_by_client",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="referred_projects",
                to="crm_app.client",
            ),
        ),
        migrations.AddField(
            model_name="project",
            name="referral_bonus_used",
            field=models.DecimalField(decimal_places=2, default=0, max_digits=12),
        ),
        migrations.AddField(
            model_name="project",
            name="bonus_accrued_amount",
            field=models.DecimalField(decimal_places=2, default=0, max_digits=12),
        ),
        migrations.AddField(
            model_name="project",
            name="bonus_accrued_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.CreateModel(
            name="ClientBonusTransaction",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("type", models.CharField(choices=[("accrual", "Accrual"), ("promo_debit", "Promo debit"), ("promo_credit", "Promo credit")], max_length=20)),
                ("amount", models.DecimalField(decimal_places=2, max_digits=12)),
                ("balance_after", models.DecimalField(decimal_places=2, max_digits=12)),
                ("promo_code", models.CharField(blank=True, default="", max_length=5)),
                ("comment", models.CharField(blank=True, default="", max_length=300)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "client",
                    models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="bonus_transactions", to="crm_app.client"),
                ),
                (
                    "created_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="created_bonus_transactions",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "project",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="bonus_transactions",
                        to="crm_app.project",
                    ),
                ),
                (
                    "related_client",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="related_bonus_transactions",
                        to="crm_app.client",
                    ),
                ),
                (
                    "workspace",
                    models.ForeignKey(
                        blank=True,
                        db_index=True,
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="client_bonus_transactions",
                        to="crm_app.workspace",
                    ),
                ),
            ],
            options={
                "ordering": ["-created_at", "-id"],
            },
        ),
        migrations.AddIndex(
            model_name="clientbonustransaction",
            index=models.Index(fields=["workspace", "client", "-created_at"], name="crm_app_cli_workspa_00d247_idx"),
        ),
        migrations.AddIndex(
            model_name="clientbonustransaction",
            index=models.Index(fields=["workspace", "project"], name="crm_app_cli_workspa_f00770_idx"),
        ),
    ]
