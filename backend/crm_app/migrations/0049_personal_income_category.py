from django.db import migrations


def ensure_personal_income_category(apps, schema_editor):
    FinanceCategory = apps.get_model("crm_app", "FinanceCategory")
    Workspace = apps.get_model("crm_app", "Workspace")

    for workspace in Workspace.objects.all():
        category = FinanceCategory.objects.filter(
            workspace=workspace,
            name__iexact="Личные доходы",
            type="income",
        ).first()
        if category:
            if category.affects_margin:
                category.affects_margin = False
                category.save(update_fields=["affects_margin"])
            continue

        max_order = (
            FinanceCategory.objects.filter(workspace=workspace, type="income")
            .order_by("-sort_order")
            .values_list("sort_order", flat=True)
            .first()
        )
        FinanceCategory.objects.create(
            workspace=workspace,
            name="Личные доходы",
            type="income",
            affects_margin=False,
            sort_order=(max_order or 0) + 10,
        )


class Migration(migrations.Migration):
    dependencies = [
        ("crm_app", "0048_financecategory_affects_margin"),
    ]

    operations = [
        migrations.RunPython(ensure_personal_income_category, migrations.RunPython.noop),
    ]
