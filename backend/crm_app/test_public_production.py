import json
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from rest_framework import status
from rest_framework.test import APITestCase

from .models import CalculatorSettings, MeasurementPhoto, MeasurementSheet, ProductionPlan, Project, User, default_workspace


class PublicProductionIntakeTests(APITestCase):
    def setUp(self):
        self.workspace = default_workspace()
        self.manager = User.objects.create_user(
            username="diy-production-manager",
            password="test",
            role=User.Role.ADMIN,
            workspace=self.workspace,
        )
        CalculatorSettings.objects.update_or_create(
            workspace=self.workspace,
            defaults={
                "shower_catalog": {
                    "hardwareItems": [
                        {"id": "av24-3382", "label": "Петля FDP-20, матовая", "price": 1350},
                    ]
                },
                "mirror_catalog": {},
            },
        )

    @override_settings(CALCULATOR_NOTIFIER_URL="http://notifier/api/calculator-leads")
    @patch("crm_app.public_production.urlopen")
    def test_intake_creates_mcp_ready_project_plan_and_measurement(self, mock_urlopen):
        mock_urlopen.return_value.__enter__.return_value.status = 200
        response = self.client.post(
            "/api/public-production/intake/",
            {
                "name": "Иван",
                "phone": "+7 (999) 123-45-67",
                "email": "ivan@example.com",
                "topology": "corner",
                "width": "1000",
                "depth": "900",
                "height": "2000",
                "ledge_width": "90",
                "tray_axis": "center",
                "opening_direction": "outward-right",
                "glass_thickness": "8",
                "finish": "black",
                "walls_finished": "true",
                "floor_checked": "false",
                "cart": json.dumps([{"id": "av24-3382", "quantity": 2}]),
                "comment": "Смеситель находится слева.",
                "files": SimpleUploadedFile("эскиз.png", b"fake-image-content", content_type="image/png"),
            },
            format="multipart",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data["production_status"], ProductionPlan.Status.NEEDS_INPUT)
        self.assertEqual(response.data["uploaded_files"], 1)
        self.assertEqual(Project.objects.count(), 1)
        project = Project.objects.get()
        self.assertEqual(project.categories, "shower")
        self.assertTrue(project.title.startswith("DIY"))
        sheet = MeasurementSheet.objects.get(project=project)
        self.assertEqual(sheet.data["dimensions"]["width_mm"], 1000)
        self.assertFalse(sheet.is_complete)
        self.assertEqual(MeasurementPhoto.objects.filter(sheet=sheet).count(), 1)
        plan = ProductionPlan.objects.get(project=project)
        self.assertTrue(plan.specification["source"]["mcp_ready"])
        self.assertEqual(plan.specification["hardware"]["selected_by_customer"][0]["catalog_id"], "av24-3382")
        self.assertTrue(plan.blocking_questions)
        self.assertFalse(plan.output_files)
        mock_urlopen.assert_called_once()

    def test_unknown_catalog_item_is_rejected_without_project(self):
        response = self.client.post(
            "/api/public-production/intake/",
            {
                "name": "Иван",
                "phone": "+7 (999) 123-45-67",
                "topology": "partition",
                "width": "1000",
                "cart": json.dumps([{"id": "missing", "quantity": 1}]),
            },
            format="multipart",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(Project.objects.exists())

    def test_intake_requires_evidence_dimensions_or_cart(self):
        response = self.client.post(
            "/api/public-production/intake/",
            {"name": "Иван", "phone": "+7 (999) 123-45-67", "topology": "other"},
            format="multipart",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(Project.objects.exists())
