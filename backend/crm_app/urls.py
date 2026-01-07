from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import ProjectViewSet, PaymentViewSet, CommissionViewSet, PayoutViewSet, DashboardViewSet, me_view

router = DefaultRouter()
router.register(r"projects", ProjectViewSet, basename="projects")
router.register(r"payments", PaymentViewSet, basename="payments")
router.register(r"commissions", CommissionViewSet, basename="commissions")
router.register(r"payouts", PayoutViewSet, basename="payouts")
router.register(r"dashboard", DashboardViewSet, basename="dashboard")

urlpatterns = [
    path("me/", me_view),
    path("", include(router.urls)),
]
