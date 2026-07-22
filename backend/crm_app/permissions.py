from rest_framework.permissions import BasePermission

class IsAdmin(BasePermission):
    def has_permission(self, request, view):
        return request.user.is_authenticated and getattr(request.user, "is_admin", lambda: False)()

class IsAuthenticatedAny(BasePermission):
    def has_permission(self, request, view):
        return request.user.is_authenticated
