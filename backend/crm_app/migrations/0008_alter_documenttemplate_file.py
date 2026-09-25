import crm_app.models
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("crm_app", "0007_system_contract_documents"),
    ]

    operations = [
        migrations.AlterField(
            model_name="documenttemplate",
            name="file",
            field=models.FileField(upload_to=crm_app.models.document_template_upload_to),
        ),
    ]
