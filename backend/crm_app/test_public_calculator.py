import json
from unittest.mock import patch

from django.core.cache import cache
from django.test import override_settings
from rest_framework import status
from rest_framework.test import APITestCase

from .models import CalculatorLead, CalculatorQuote, CalculatorSettings, User, default_workspace


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
                "hardwareComponents": [
                    {"id": "hinge-6", "hardwareItemId": "hinge-6", "quantity": 2, "glassThickness": 6},
                    {"id": "hinge-8", "hardwareItemId": "hinge-8", "quantity": 2, "glassThickness": 8},
                    {"id": "handle", "hardwareItemId": "handle", "quantity": 1},
                ],
                "fields": [
                    {"key": "HEIGHT_0", "label": "Высота", "defaultValue": 2000},
                    {"key": "WIDTH_0", "label": "Ширина", "defaultValue": 1000},
                ],
            }],
            "glass": [{"id": "clear", "label": "Бесцветное", "price": 6200, "thickness": 8}],
            "hardware": [{"id": "chrome", "label": "Хром", "price": 0}],
            "hardwareClass": [{"id": "standard", "label": "Стандарт", "price": 0}],
            "hardwareItems": [
                {"id": "hinge-6", "label": "Петля для стекла 6 мм", "price": 900},
                {"id": "hinge-8", "label": "Петля для стекла 8 мм", "price": 1200},
                {"id": "handle", "label": "Ручка универсальная", "price": 600},
            ],
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
        self.assertEqual(response.data["delivery"]["insideLabel"], "По г. Ростов-на-Дону")

    def test_shower_calculation_matches_admin_coefficients_and_rounding(self):
        catalog = self.shower_catalog
        catalog["hardware"][0]["price"] = 20
        catalog["hardwareClass"][0]["price"] = 30
        catalog["services"].update({
            "productMarkupPercent": 10,
            "hardwareMarkupPercent": 15,
            "designerPercent": 10,
        })
        CalculatorSettings.objects.filter(workspace=self.workspace).update(shower_catalog=catalog)

        response = self.client.post(
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
                    "designerEnabled": True,
                    "discountEnabled": True,
                    "discountPercent": 10,
                },
                "delivery": {"enabled": False, "zone": "inside", "km": 0},
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["amount"], 23900)

    @override_settings(CALCULATOR_NOTIFIER_URL="http://notifier/api/calculator-leads")
    @patch("crm_app.public_calculator.urlopen")
    def test_calculation_can_be_sent_as_lead_and_read_by_admin(self, mock_urlopen):
        mock_urlopen.return_value.__enter__.return_value.status = 200
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
        self.assertEqual(calculation.data["amount"], 22400)

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
        self.assertEqual(CalculatorQuote.objects.count(), 1)
        quote = CalculatorQuote.objects.get()
        self.assertEqual(quote.number, "1001")
        self.assertEqual(lead_response.data["quote_id"], quote.quote_id)
        self.assertEqual(lead_response.data["quote_number"], "1001")
        self.assertEqual(quote.payload["customer"]["clientName"], "Иван")
        self.assertEqual(quote.payload["customer"]["clientPhone"], "+79991234567")
        self.assertEqual(quote.payload["items"][0]["kind"], "shower")
        self.assertEqual(quote.payload["items"][0]["form"]["constructionId"], "shower-1")
        self.assertEqual(quote.payload["result"]["total"], calculation.data["amount"])
        self.assertEqual(quote.payload["orderDelivery"], {"enabled": True, "zone": "outside", "km": 10})
        mock_urlopen.assert_called_once()
        notification = json.loads(mock_urlopen.call_args.args[0].data.decode("utf-8"))
        self.assertEqual(notification["phone"], "+79991234567")
        self.assertEqual(notification["product"], "shower")
        self.assertIn("КП №1001", notification["message"])

        admin = User.objects.create_user(username="admin-public-calc", password="test", role=User.Role.ADMIN, workspace=self.workspace)
        self.client.force_authenticate(admin)
        list_response = self.client.get("/api/calculator-leads/")
        self.assertEqual(list_response.status_code, status.HTTP_200_OK)
        self.assertEqual(list_response.data[0]["client_name"], "Иван")
        quotes_response = self.client.get("/api/calculator-quotes/")
        self.assertEqual(quotes_response.status_code, status.HTTP_200_OK)
        self.assertEqual(quotes_response.data["quotes"][0]["number"], "1001")

    def test_mirror_lead_creates_editable_quote(self):
        calculation = self.client.post(
            "/api/public-calculator/calculate/",
            {
                "product": "mirror",
                "configuration": {
                    "width": 800,
                    "height": 1200,
                    "materialId": "mirror",
                    "options": [{"id": "option-1", "serviceId": "installation", "quantity": 1}],
                },
                "delivery": {"enabled": False, "zone": "inside", "km": 0},
            },
            format="json",
        )
        self.assertEqual(calculation.status_code, status.HTTP_200_OK)

        lead_response = self.client.post(
            "/api/public-calculator/lead/",
            {
                "calculation_id": calculation.data["calculation_id"],
                "name": "Анна",
                "phone": "+7 (999) 555-44-33",
            },
            format="json",
        )

        self.assertEqual(lead_response.status_code, status.HTTP_201_CREATED)
        quote = CalculatorQuote.objects.get()
        item = quote.payload["items"][0]
        self.assertEqual(item["kind"], "mirror")
        self.assertEqual(item["form"]["width"], 800)
        self.assertEqual(item["form"]["height"], 1200)
        self.assertEqual(item["form"]["options"][0]["serviceId"], "installation")
        self.assertEqual(item["serviceLines"][0]["label"], "Монтаж")
        self.assertEqual(item["details"][-1]["value"], "Включено")
        self.assertEqual(quote.payload["customer"]["clientName"], "Анна")

    def test_honeypot_does_not_create_lead(self):
        response = self.client.post(
            "/api/public-calculator/lead/",
            {"company": "spam", "calculation_id": "missing"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertFalse(CalculatorLead.objects.exists())
