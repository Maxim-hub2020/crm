from django.contrib import admin
from django.conf import settings
from django.conf.urls.static import static
from django.urls import path, include
from rest_framework_simplejwt.views import TokenRefreshView

from crm_app.auth import EmailOrUsernameTokenObtainPairView
from crm_app.mcp_oauth import authorization_server_metadata, protected_resource_metadata

urlpatterns = [
    path(".well-known/oauth-protected-resource", protected_resource_metadata),
    path(".well-known/oauth-authorization-server", authorization_server_metadata),
    path("admin/", admin.site.urls),
    path("api/", include("crm_app.urls")),
    path("api/auth/token/", EmailOrUsernameTokenObtainPairView.as_view(), name="token_obtain_pair"),
    path("api/auth/token/refresh/", TokenRefreshView.as_view(), name="token_refresh_pair"),
    path("api/auth/refresh/", TokenRefreshView.as_view(), name="token_refresh"),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
