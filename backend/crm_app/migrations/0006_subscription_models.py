from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("crm_app", "0005_task"),
    ]

    operations = [
        migrations.CreateModel(
            name="SubscriptionPlan",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("code", models.SlugField(allow_unicode=True, max_length=50, unique=True)),
                ("name", models.CharField(max_length=120)),
                ("description", models.TextField(blank=True, default="")),
                ("price_rub", models.DecimalField(decimal_places=2, default="1500.00", max_digits=10)),
                ("interval_months", models.PositiveIntegerField(default=1)),
                ("is_active", models.BooleanField(default=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={"ordering": ["id"]},
        ),
        migrations.CreateModel(
            name="WorkspaceSubscription",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("inactive", "Inactive"),
                            ("active", "Active"),
                            ("past_due", "Past due"),
                            ("canceled", "Canceled"),
                        ],
                        db_index=True,
                        default="inactive",
                        max_length=20,
                    ),
                ),
                ("started_at", models.DateTimeField(blank=True, null=True)),
                ("current_period_start", models.DateField(blank=True, db_index=True, null=True)),
                ("current_period_end", models.DateField(blank=True, db_index=True, null=True)),
                ("auto_renew", models.BooleanField(default=True)),
                ("last_payment_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "plan",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="subscriptions",
                        to="crm_app.subscriptionplan",
                    ),
                ),
            ],
            options={"ordering": ["id"]},
        ),
        migrations.CreateModel(
            name="SubscriptionInvoice",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("amount_rub", models.DecimalField(decimal_places=2, max_digits=10)),
                ("period_start", models.DateField(db_index=True)),
                ("period_end", models.DateField(db_index=True)),
                (
                    "status",
                    models.CharField(
                        choices=[("pending", "Pending"), ("paid", "Paid"), ("canceled", "Canceled")],
                        db_index=True,
                        default="pending",
                        max_length=20,
                    ),
                ),
                ("payment_provider", models.CharField(blank=True, default="manual", max_length=30)),
                ("external_id", models.CharField(blank=True, default="", max_length=120)),
                ("checkout_url", models.URLField(blank=True, null=True)),
                ("paid_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "created_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="created_subscription_invoices",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "plan",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="invoices",
                        to="crm_app.subscriptionplan",
                    ),
                ),
                (
                    "subscription",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="invoices",
                        to="crm_app.workspacesubscription",
                    ),
                ),
            ],
            options={"ordering": ["-created_at", "-id"]},
        ),
    ]
