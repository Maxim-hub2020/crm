from django.contrib import admin

from .models import (
    Account,
    AuditLog,
    ChatIntegrationSettings,
    Client,
    CRMMemorySnapshot,
    DocumentTemplate,
    FinanceCategory,
    Payment,
    Project,
    ProjectCustomField,
    ProjectStatus,
    Task,
    User,
)

admin.site.register(User)
admin.site.register(Client)
admin.site.register(ProjectStatus)
admin.site.register(Project)
admin.site.register(Payment)
admin.site.register(Task)
admin.site.register(FinanceCategory)
admin.site.register(Account)
admin.site.register(ProjectCustomField)
admin.site.register(DocumentTemplate)
admin.site.register(ChatIntegrationSettings)
admin.site.register(CRMMemorySnapshot)
admin.site.register(AuditLog)
