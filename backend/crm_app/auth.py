from django.contrib.auth import get_user_model
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer
from rest_framework_simplejwt.views import TokenObtainPairView


class EmailOrUsernameTokenObtainPairSerializer(TokenObtainPairSerializer):
    def validate(self, attrs):
        login = str(attrs.get(self.username_field) or attrs.get("username") or "").strip()
        if login:
            User = get_user_model()
            user = None
            if not User.objects.filter(username__iexact=login).exists():
                user = User.objects.filter(email__iexact=login, is_active=True).order_by("id").first()
            if user:
                attrs[self.username_field] = getattr(user, self.username_field)
        return super().validate(attrs)


class EmailOrUsernameTokenObtainPairView(TokenObtainPairView):
    serializer_class = EmailOrUsernameTokenObtainPairSerializer
