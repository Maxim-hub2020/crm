import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("crm_app", "0034_calculatorlead")]

    operations = [
        migrations.AddField("calculatorquote", "lead_deleted", models.BooleanField(default=False)),
        migrations.AddField("calculatorlead", "quote", models.OneToOneField(
            blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
            related_name="lead", to="crm_app.calculatorquote",
        )),
        migrations.AddField("calculatorlead", "manager_note", models.TextField(blank=True, default="")),
        migrations.AddField("calculatorlead", "follow_up_at", models.DateTimeField(blank=True, null=True)),
    ]
