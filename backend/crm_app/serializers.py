from rest_framework import serializers
from .models import Project, Payment, Commission, Payout, User

class MeSerializer(serializers.ModelSerializer):
    full_name = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ["id", "username", "full_name", "role", "is_active"]

    def get_full_name(self, obj):
        fn = obj.get_full_name()
        return fn if fn else obj.username


class ProjectSerializer(serializers.ModelSerializer):
    class Meta:
        model = Project
        fields = "__all__"
        read_only_fields = ["manager", "created_at", "updated_at"]


class PaymentSerializer(serializers.ModelSerializer):
    class Meta:
        model = Payment
        fields = "__all__"
        read_only_fields = ["created_by", "created_at"]


class CommissionSerializer(serializers.ModelSerializer):
    class Meta:
        model = Commission
        fields = "__all__"
        read_only_fields = ["created_at"]


class PayoutSerializer(serializers.ModelSerializer):
    class Meta:
        model = Payout
        fields = "__all__"
        read_only_fields = ["created_by", "created_at"]
