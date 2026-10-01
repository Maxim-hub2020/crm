from django.db import migrations, models


def mark_legacy_internal_project_deletions(apps, schema_editor):
    CalculatorQuote = apps.get_model("crm_app", "CalculatorQuote")
    CalculatorQuote.objects.filter(lead_deleted=True).exclude(
        quote_id__startswith="public-"
    ).update(project_sync_disabled=True)


class Migration(migrations.Migration):
    dependencies = [("crm_app", "0036_calculatorquote_project")]

    operations = [
        migrations.AddField(
            model_name="calculatorquote",
            name="project_sync_disabled",
            field=models.BooleanField(default=False),
        ),
        migrations.RunPython(mark_legacy_internal_project_deletions, migrations.RunPython.noop),
    ]
