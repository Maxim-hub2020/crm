from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("crm_app", "0045_mcp_oauth"),
    ]

    operations = [
        migrations.AlterField(
            model_name="payment",
            name="project",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="payments",
                to="crm_app.project",
            ),
        ),
    ]
