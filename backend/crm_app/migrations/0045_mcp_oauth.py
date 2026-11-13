from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("crm_app", "0044_project_yandex_disk_public_url"),
    ]

    operations = [
        migrations.CreateModel(
            name="McpOAuthClient",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("client_id", models.CharField(max_length=255, unique=True)),
                ("client_name", models.CharField(blank=True, default="", max_length=200)),
                ("redirect_uris", models.JSONField(default=list)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
        ),
        migrations.CreateModel(
            name="McpAuthorizationCode",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("code_hash", models.CharField(max_length=64, unique=True)),
                ("redirect_uri", models.URLField(max_length=500)),
                ("resource", models.URLField(max_length=500)),
                ("scope", models.CharField(blank=True, default="", max_length=500)),
                ("code_challenge", models.CharField(max_length=128)),
                ("expires_at", models.DateTimeField(db_index=True)),
                ("used_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("client", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="authorization_codes", to="crm_app.mcpoauthclient")),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="mcp_authorization_codes", to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.CreateModel(
            name="McpAccessToken",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("access_token_hash", models.CharField(max_length=64, unique=True)),
                ("refresh_token_hash", models.CharField(max_length=64, unique=True)),
                ("resource", models.URLField(max_length=500)),
                ("scope", models.CharField(blank=True, default="", max_length=500)),
                ("expires_at", models.DateTimeField(db_index=True)),
                ("refresh_expires_at", models.DateTimeField(db_index=True)),
                ("revoked_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("client", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="access_tokens", to="crm_app.mcpoauthclient")),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="mcp_access_tokens", to=settings.AUTH_USER_MODEL)),
            ],
        ),
    ]
