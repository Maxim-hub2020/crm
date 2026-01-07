from django.contrib import admin
from .models import User, Project, Payment, Commission, Payout, AuditLog

admin.site.register(User)
admin.site.register(Project)
admin.site.register(Payment)
admin.site.register(Commission)
admin.site.register(Payout)
admin.site.register(AuditLog)
