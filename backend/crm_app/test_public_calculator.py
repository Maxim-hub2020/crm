from django.core.cache import cache
from rest_framework import status
from rest_framework.test import APITestCase

from .models import CalculatorLead, CalculatorSettings, User, default_workspace


class PublicCalculatorApiTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.workspace = default_workspace()
        self.shower_catalog = {
            "constructions": [{
                "id": "shower-1",
                "title": "Душевая перегородка",
                "shortTitle": "Перегородка",
                "basePrice": 4000,
                "installationPrice": 5000,
                "fields": [
                    {"key": "HEIGHT_0", "label": "Высота", "defaultValue": 2000},
                    {"key": "WIDTH_0", "label": "Ширина", "defaultValue": 1000},
                ],
            }],
            "glass": [{"id": "clear", "label": "Бесцветное", "price": 6200}],
            "hardware": [{"id": "chrome", "label": "Хром", "price": 100}],
            "hardwareClass": [{"id": "standard", "label": "Стандарт", "price": 3700}],
            "services": {
                "deliveryBase": 1500,
                "deliveryKmRate": 50,
                "productMarkupPercent": 0,
                "hardwareMarkupPercent": 0,
                "heightSurchargeAfter": 2200,
                "heightSurchargePercent": 30,
            },
        }
        self.mirror_catalog = {
            "materials": [{"id": "mirror", "label": "Зеркало", "price": 2250}],
            "services": [{
                "id": "installation",
                "label": "Монтаж",
                "price": 2000,
                "unit": "piece",
                "category": "work",
                "visibleInQuote": True,
            }],
            "settings": {"materialMarkupPercent": 30, "serviceMarkupPercent": 0},
        }
        CalculatorSettings.objects.update_or_create(
            workspace=self.workspace,
            defaults={"shower_catalog": self.shower_catalog, "mirror_catalog": self.mirror_catalog},
        )

    def test_config_does_not_expose_prices(self):
        response = self.client.get("/api/public-calculator/config/")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertNotIn("price", response.data["shower"]["glass"][0])
        self.assertNotIn("basePrice", response.data["shower"]["constructions"][0])

    def test_calculation_can_be_sent_as_lead_and_read_by_admin(self):
        calculation = self.client.post(
            "/api/public-calculator/calculate/",
            {
                "product": "shower",
                "configuration": {
                    "constructionId": "shower-1",
                    "dimensions": {"HEIGHT_0": 2000, "WIDTH_0": 1000},
                    "glassId": "clear",
                    "hardwareId": "chrome",
                    "hardwareClassId": "standard",
                    "installation": True,
                },
                "delivery": {"enabled": True, "zone": "outside", "km": 10},
            },
            format="json",
        )
        self.assertEqual(calculation.status_code, status.HTTP_200_OK)
        self.assertGreater(calculation.data["amount"], 0)

        lead_response = self.client.post(
            "/api/public-calculator/lead/",
            {
                "calculation_id": calculation.data["calculation_id"],
                "name": "Иван",
                "phone": "+7 999 123-45-67",
                "source": {"url": "https://amalgama.cehcrm.ru/?utm_source=test", "utm": {"utm_source": "test"}},
            },
            format="json",
        )
        self.assertEqual(lead_response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(CalculatorLead.objects.count(), 1)

        admin = User.objects.create_user(username="admin-public-calc", password="test", role=User.Role.ADMIN, workspace=self.workspace)
        self.client.force_authenticate(admin)
        list_response = self.client.get("/api/calculator-leads/")
        self.assertEqual(list_response.status_code, status.HTTP_200_OK)
        self.assertEqual(list_response.data[0]["client_name"], "Иван")

    def test_honeypot_does_not_create_lead(self):
        response = self.client.post(
            "/api/public-calculator/lead/",
            {"company": "spam", "calculation_id": "missing"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertFalse(CalculatorLead.objects.exists())
