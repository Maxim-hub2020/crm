from django.db import migrations, models
import django.db.models.deletion


def copy_project_clients_forward(apps, _schema_editor):
    Client = apps.get_model("crm_app", "Client")
    Project = apps.get_model("crm_app", "Project")

    for project in Project.objects.all().order_by("id"):
        phone = (project.client_phone or "").strip()
        name = (project.client_name or "").strip() or f"Клиент #{project.id}"
        client = Client.objects.filter(phone=phone).first() if phone else None

        if client is None and not phone:
            client = Client.objects.filter(name=name, phone="").first()

        if client is None:
            client = Client.objects.create(
                name=name,
                phone=phone,
                email=project.client_email or None,
                address=project.object_address or None,
                works_with_contract=bool(project.works_with_contract),
            )
        else:
            changed_fields = []
            if name and not client.name:
                client.name = name
                changed_fields.append("name")
            if project.client_email and not client.email:
                client.email = project.client_email
                changed_fields.append("email")
            if project.object_address and not client.address:
                client.address = project.object_address
                changed_fields.append("address")
            if project.works_with_contract and not client.works_with_contract:
                client.works_with_contract = True
                changed_fields.append("works_with_contract")
            if changed_fields:
                changed_fields.append("updated_at")
                client.save(update_fields=changed_fields)

        project.client_id = client.id
        project.save(update_fields=["client"])


def clear_project_clients_reverse(apps, _schema_editor):
    Project = apps.get_model("crm_app", "Project")
    Project.objects.update(client=None)


class Migration(migrations.Migration):

    dependencies = [
        ("crm_app", "0009_crmmemorysnapshot"),
    ]

    operations = [
        migrations.CreateModel(
            name="Client",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=200)),
                ("phone", models.CharField(blank=True, db_index=True, default="", max_length=50)),
                ("email", models.EmailField(blank=True, max_length=254, null=True)),
                ("address", models.CharField(blank=True, max_length=300, null=True)),
                ("works_with_contract", models.BooleanField(default=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "ordering": ["name", "id"],
            },
        ),
        migrations.AddConstraint(
            model_name="client",
            constraint=models.UniqueConstraint(
                condition=~models.Q(phone=""),
                fields=("phone",),
                name="unique_client_phone_non_empty",
            ),
        ),
        migrations.AddField(
            model_name="project",
            name="client",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="projects",
                to="crm_app.client",
            ),
        ),
        migrations.RunPython(copy_project_clients_forward, clear_project_clients_reverse),
    ]
