from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("crm_app", "0023_normalize_phone_numbers"),
    ]

    operations = [
        migrations.AlterField(
            model_name="clientbonustransaction",
            name="type",
            field=models.CharField(
                choices=[
                    ("accrual", "Accrual"),
                    ("accrual_reversal", "Accrual reversal"),
                    ("promo_debit", "Promo debit"),
                    ("promo_credit", "Promo credit"),
                    ("promo_refund", "Promo refund"),
                    ("promo_credit_reverse", "Promo credit reversal"),
                ],
                max_length=20,
            ),
        ),
    ]
