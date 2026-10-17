from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("crm_app", "0049_personal_income_category"),
    ]

    operations = [
        migrations.AddField(
            model_name="payment",
            name="destination_account",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="incoming_transfers",
                to="crm_app.account",
            ),
        ),
        migrations.AlterField(
            model_name="payment",
            name="operation_kind",
            field=models.CharField(
                choices=[
                    ("standard", "Standard"),
                    ("balance_adjustment", "Balance adjustment"),
                    ("account_transfer", "Account transfer"),
                ],
                db_index=True,
                default="standard",
                max_length=30,
            ),
        ),
    ]
