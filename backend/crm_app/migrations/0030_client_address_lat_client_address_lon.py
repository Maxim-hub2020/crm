from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("crm_app", "0029_calculatorsettings"),
    ]

    operations = [
        migrations.AddField(
            model_name="client",
            name="address_lat",
            field=models.CharField(blank=True, max_length=32, null=True),
        ),
        migrations.AddField(
            model_name="client",
            name="address_lon",
            field=models.CharField(blank=True, max_length=32, null=True),
        ),
    ]
