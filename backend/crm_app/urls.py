from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import (
    AccountViewSet,
    AuditLogViewSet,
    ClientBonusTransactionViewSet,
    ClientViewSet,
    DocumentTemplateViewSet,
    FinanceCategoryViewSet,
    PaymentViewSet,
    ProjectCommentViewSet,
    ProjectCustomFieldViewSet,
    ProjectStatusViewSet,
    ProjectViewSet,
    TaskViewSet,
    TaskTemplateViewSet,
    UserViewSet,
    billing_activate_invoice_view,
    billing_create_invoice_view,
    billing_summary_view,
    address_suggestions_view,
    chat_settings_view,
    assistant_chat_view,
    assistant_voice_view,
    bonus_promo_preview_view,
    cash_forecast_ai_view,
    cash_forecast_view,
    calculator_settings_view,
    finance_analytics_ai_view,
    finance_analytics_view,
    global_search_view,
    health_view,
    me_view,
    yandex_disk_folders_view,
    yandex_disk_oauth_callback_view,
    yandex_disk_oauth_complete_view,
    yandex_disk_oauth_start_view,
    yandex_disk_settings_view,
)

router = DefaultRouter()
router.register(r"clients", ClientViewSet, basename="clients")
router.register(r"client-bonus-transactions", ClientBonusTransactionViewSet, basename="client-bonus-transactions")
router.register(r"projects", ProjectViewSet, basename="projects")
router.register(r"payments", PaymentViewSet, basename="payments")
router.register(r"project-comments", ProjectCommentViewSet, basename="project-comments")
router.register(r"project-statuses", ProjectStatusViewSet, basename="project-statuses")
router.register(r"finance-categories", FinanceCategoryViewSet, basename="finance-categories")
router.register(r"accounts", AccountViewSet, basename="accounts")
router.register(r"project-custom-fields", ProjectCustomFieldViewSet, basename="project-custom-fields")
router.register(r"document-templates", DocumentTemplateViewSet, basename="document-templates")
router.register(r"tasks", TaskViewSet, basename="tasks")
router.register(r"task-templates", TaskTemplateViewSet, basename="task-templates")
router.register(r"audit-logs", AuditLogViewSet, basename="audit-logs")
router.register(r"users", UserViewSet, basename="users")

urlpatterns = [
    path("health/", health_view),
    path("me/", me_view),
    path("billing/summary/", billing_summary_view),
    path("billing/invoices/", billing_create_invoice_view),
    path("billing/activate/", billing_activate_invoice_view),
    path("bonus-promo-preview/", bonus_promo_preview_view),
    path("finance-analytics/", finance_analytics_view),
    path("finance-analytics/ai/", finance_analytics_ai_view),
    path("cash-forecast/", cash_forecast_view),
    path("cash-forecast/ai/", cash_forecast_ai_view),
    path("global-search/", global_search_view),
    path("address-suggestions/", address_suggestions_view),
    path("chat-settings/", chat_settings_view),
    path("calculator-settings/", calculator_settings_view),
    path("yandex-disk-folders/", yandex_disk_folders_view),
    path("yandex-disk/oauth/start/", yandex_disk_oauth_start_view),
    path("yandex-disk/oauth/complete/", yandex_disk_oauth_complete_view),
    path("yandex-disk/oauth/callback/", yandex_disk_oauth_callback_view),
    path("yandex-disk-settings/", yandex_disk_settings_view),
    path("assistant/chat/", assistant_chat_view),
    path("assistant/voice/", assistant_voice_view),
    path("projects", ProjectViewSet.as_view({"get": "list", "post": "create"}), name="projects-no-slash"),
    path("", include(router.urls)),
]
