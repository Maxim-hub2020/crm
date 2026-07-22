from rest_framework.permissions import BasePermission

class IsAdmin(BasePermission):
    def has_permission(self, request, view):
        return request.user.is_authenticated and getattr(request.user, "is_admin", lambda: False)()

class IsAuthenticatedAny(BasePermission):
    def has_permission(self, request, view):
        return request.user.is_authenticated


class HasActiveSubscription(BasePermission):
    message = "Подписка не активна. Откройте раздел оплаты и продлите доступ к CRM."

    def has_permission(self, request, view):
        if not request.user.is_authenticated:
            return False

        if getattr(request.user, "is_superuser", False) or getattr(request.user, "is_admin", lambda: False)():
            return True

        from .subscription import get_workspace_subscription, has_trial_access, is_subscription_active

        subscription = get_workspace_subscription(request.user)
        return is_subscription_active(subscription) or has_trial_access(subscription)

