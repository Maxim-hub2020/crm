from django.db.models import Sum
from rest_framework import viewsets
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.response import Response

from .models import Project, Payment, Commission, Payout, User
from .serializers import ProjectSerializer, PaymentSerializer, CommissionSerializer, PayoutSerializer, MeSerializer
from .permissions import IsAdmin, IsAuthenticatedAny
from .services import create_commission_for_advance, next_month_start
from django.utils import timezone

@api_view(["GET"])
@permission_classes([IsAuthenticatedAny])
def me_view(request):
    return Response(MeSerializer(request.user).data)

class ProjectViewSet(viewsets.ModelViewSet):
    serializer_class = ProjectSerializer
    permission_classes = [IsAuthenticatedAny]

    def get_queryset(self):
        qs = Project.objects.all().order_by("-created_at")
        if self.request.user.is_admin():
            return qs
        return qs.filter(manager=self.request.user)

    def perform_create(self, serializer):
        serializer.save(manager=self.request.user)

class PaymentViewSet(viewsets.ModelViewSet):
    serializer_class = PaymentSerializer
    permission_classes = [IsAuthenticatedAny]

    def get_queryset(self):
        qs = Payment.objects.select_related("project", "created_by").all().order_by("-paid_at")
        if self.request.user.is_admin():
            return qs
        return qs.filter(project__manager=self.request.user)

    def perform_create(self, serializer):
        payment = serializer.save(created_by=self.request.user)
        create_commission_for_advance(payment)

class CommissionViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = CommissionSerializer
    permission_classes = [IsAuthenticatedAny]

    def get_queryset(self):
        qs = Commission.objects.select_related("payment", "project", "manager").all().order_by("-created_at")
        if self.request.user.is_admin():
            return qs
        return qs.filter(manager=self.request.user)

class PayoutViewSet(viewsets.ModelViewSet):
    serializer_class = PayoutSerializer
    permission_classes = [IsAdmin]

    def get_queryset(self):
        return Payout.objects.select_related("manager", "created_by").all().order_by("-paid_at")

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)

class DashboardViewSet(viewsets.ViewSet):
    permission_classes = [IsAuthenticatedAny]

    @action(detail=False, methods=["get"])
    def top(self, request):
        period = request.query_params.get("period")
        if not period:
            return Response({"detail": "period is required as YYYY-MM-01"}, status=400)

        try:
            period_date = timezone.datetime.strptime(period, "%Y-%m-%d").date()
            period_date = period_date.replace(day=1)
        except Exception:
            return Response({"detail": "period must be YYYY-MM-01"}, status=400)

        if request.user.is_admin():
            managers = User.objects.filter(role=User.Role.MANAGER, is_active=True).order_by("username")
        else:
            managers = User.objects.filter(id=request.user.id)

        start_dt = timezone.make_aware(timezone.datetime.combine(period_date, timezone.datetime.min.time()))
        end_dt = timezone.make_aware(timezone.datetime.combine(next_month_start(period_date), timezone.datetime.min.time()))

        data = []
        for m in managers:
            sales = Commission.objects.filter(
                manager=m,
                period_month=period_date,
                sale_number_in_month__gt=0
            ).exclude(status=Commission.Status.CANCELED).count()

            advance_sum = Payment.objects.filter(
                project__manager=m,
                type=Payment.Type.ADVANCE,
                paid_at__gte=start_dt,
                paid_at__lt=end_dt,
            ).aggregate(s=Sum("amount"))["s"] or 0

            accrued = Commission.objects.filter(
                manager=m,
                period_month=period_date
            ).exclude(status=Commission.Status.CANCELED).aggregate(s=Sum("commission_amount"))["s"] or 0

            paid = Payout.objects.filter(
                manager=m,
                period_month=period_date
            ).aggregate(s=Sum("amount"))["s"] or 0

            to_pay = accrued - paid

            data.append({
                "manager_id": m.id,
                "manager": m.get_full_name() or m.username,
                "sales": sales,
                "advance_sum": f"{advance_sum:.2f}",
                "accrued_commission": f"{accrued:.2f}",
                "paid_out": f"{paid:.2f}",
                "to_pay": f"{to_pay:.2f}",
            })

        data.sort(key=lambda x: float(x["accrued_commission"]), reverse=True)
        return Response(data, status=200)
