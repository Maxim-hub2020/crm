from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("crm_app", "0046_payment_project_optional"),
    ]

    operations = [
        migrations.AddField(
            model_name="payment",
            name="operation_kind",
            field=models.CharField(
                choices=[("standard", "Standard"), ("balance_adjustment", "Balance adjustment")],
                db_index=True,
                default="standard",
                max_length=30,
            ),
        ),
        migrations.AddField(
            model_name="payment",
            name="adjustment_direction",
            field=models.CharField(
                blank=True,
                choices=[("increase", "Increase"), ("decrease", "Decrease")],
                default="",
                max_length=20,
            ),
        ),
    ]
