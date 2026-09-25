from django.db import migrations, models


def seed_finance_category_sort_order(apps, _schema_editor):
    FinanceCategory = apps.get_model("crm_app", "FinanceCategory")

    workspace_ids = list(FinanceCategory.objects.values_list("workspace_id", flat=True).distinct())
    for workspace_id in workspace_ids:
        for category_type in ("income", "expense"):
            queryset = FinanceCategory.objects.filter(workspace_id=workspace_id, type=category_type).order_by("name", "id")
            for index, category in enumerate(queryset, start=1):
                category.sort_order = index * 10
                category.save(update_fields=["sort_order"])


class Migration(migrations.Migration):
    dependencies = [
        ("crm_app", "0018_workspace_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="financecategory",
            name="sort_order",
            field=models.PositiveIntegerField(default=0),
        ),
        migrations.RunPython(seed_finance_category_sort_order, migrations.RunPython.noop),
        migrations.AlterModelOptions(
            name="financecategory",
            options={"ordering": ["type", "sort_order", "id"]},
        ),
    ]
