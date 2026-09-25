from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


def seed_system_rows(apps, schema_editor):
    FinanceCategory = apps.get_model("crm_app", "FinanceCategory")
    Account = apps.get_model("crm_app", "Account")
    ProjectCustomField = apps.get_model("crm_app", "ProjectCustomField")

    for name in ["Доставка", "Комплектующие", "Монтаж", "Оплата контрагентам", "Аренда"]:
        FinanceCategory.objects.get_or_create(name=name, type="expense")
    FinanceCategory.objects.get_or_create(name="Аванс", type="income")
    FinanceCategory.objects.get_or_create(name="Оплата клиента", type="income")
    Account.objects.get_or_create(name="Основной счет")
    ProjectCustomField.objects.get_or_create(name="Адрес", defaults={"field_type": "text", "sort_order": 10})


class Migration(migrations.Migration):
    dependencies = [
        ("crm_app", "0006_subscription_models"),
    ]

    operations = [
        migrations.AddField(
            model_name="project",
            name="works_with_contract",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="projectstatus",
            name="stuck_after_days",
            field=models.PositiveIntegerField(default=3),
        ),
        migrations.CreateModel(
            name="Account",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=120, unique=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={"ordering": ["name", "id"]},
        ),
        migrations.CreateModel(
            name="FinanceCategory",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=120)),
                (
                    "type",
                    models.CharField(
                        choices=[("expense", "Expense"), ("income", "Income")],
                        db_index=True,
                        default="expense",
                        max_length=20,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={"ordering": ["type", "name", "id"]},
        ),
        migrations.CreateModel(
            name="ProjectCustomField",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=120)),
                (
                    "field_type",
                    models.CharField(
                        choices=[("text", "Text"), ("number", "Number"), ("date", "Date"), ("file", "File")],
                        default="text",
                        max_length=20,
                    ),
                ),
                ("sort_order", models.PositiveIntegerField(default=0)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={"ordering": ["sort_order", "id"]},
        ),
        migrations.CreateModel(
            name="DocumentTemplate",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                (
                    "type",
                    models.CharField(choices=[("contract", "Contract"), ("act", "Act")], max_length=20, unique=True),
                ),
                ("file", models.FileField(upload_to="document_templates/")),
                ("original_name", models.CharField(blank=True, default="", max_length=255)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "uploaded_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="uploaded_document_templates",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={"ordering": ["type"]},
        ),
        migrations.AddConstraint(
            model_name="financecategory",
            constraint=models.UniqueConstraint(
                fields=("name", "type"),
                name="unique_finance_category_name_type",
            ),
        ),
        migrations.RunPython(seed_system_rows, migrations.RunPython.noop),
    ]
