from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("crm_app", "0019_financecategory_sort_order"),
    ]

    operations = [
        migrations.AddField(
            model_name="project",
            name="custom_fields",
            field=models.JSONField(blank=True, default=dict),
        ),
    ]
