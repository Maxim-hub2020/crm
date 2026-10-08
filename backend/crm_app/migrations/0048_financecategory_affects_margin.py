from django.db import migrations, models


def mark_personal_expenses(apps, schema_editor):
    FinanceCategory = apps.get_model("crm_app", "FinanceCategory")
    for category in FinanceCategory.objects.filter(type="expense"):
        if category.name.strip().casefold() == "личные траты":
            category.affects_margin = False
            category.save(update_fields=["affects_margin"])


class Migration(migrations.Migration):
    dependencies = [
        ("crm_app", "0047_payment_balance_adjustment"),
    ]

    operations = [
        migrations.AddField(
            model_name="financecategory",
            name="affects_margin",
            field=models.BooleanField(
                default=True,
                help_text="Whether operations in this category affect profit and margin analytics.",
            ),
        ),
        migrations.RunPython(mark_personal_expenses, migrations.RunPython.noop),
    ]
