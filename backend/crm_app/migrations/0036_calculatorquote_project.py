import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("crm_app", "0035_calculator_lead_link")]

    operations = [
        migrations.AddField(
            model_name="calculatorquote",
            name="project",
            field=models.OneToOneField(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="calculator_quote",
                to="crm_app.project",
            ),
        ),
    ]
