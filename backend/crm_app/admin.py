from django.contrib import admin

from .models import (
    Account,
    AuditLog,
    CalculatorQuote,
    CalculatorSettings,
    ChatIntegrationSettings,
    Client,
    ClientBonusTransaction,
    DocumentTemplate,
    FinanceCategory,
    Payment,
    Project,
    ProjectCustomField,
    ProjectStatus,
    Task,
    TaskTemplate,
    User,
    Workspace,
    YandexDiskSettings,
)

admin.site.register(User)
admin.site.register(Workspace)
admin.site.register(Client)
admin.site.register(ClientBonusTransaction)
admin.site.register(ProjectStatus)
admin.site.register(Project)
admin.site.register(Payment)
admin.site.register(Task)
admin.site.register(TaskTemplate)
admin.site.register(FinanceCategory)
admin.site.register(Account)
admin.site.register(ProjectCustomField)
admin.site.register(DocumentTemplate)
admin.site.register(ChatIntegrationSettings)
admin.site.register(CalculatorQuote)
admin.site.register(CalculatorSettings)
admin.site.register(YandexDiskSettings)
admin.site.register(AuditLog)
