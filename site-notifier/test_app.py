import json
import threading
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen

import app


class CalculatorLeadNotificationTests(unittest.TestCase):
    def setUp(self):
        self.server = app.LeadServer(("127.0.0.1", 0), app.LeadHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_calculator_products_are_accepted_and_sent(self):
        for product, service in app.CALCULATOR_SERVICES.items():
            with self.subTest(product=product), patch.object(app, "_send_notification") as send_notification:
                body = json.dumps(
                    {
                        "name": "Тестовый клиент",
                        "phone": "+79991234567",
                        "product": product,
                        "amount": "50 000 ₽",
                        "message": "КП №1001 сохранено в архиве калькулятора.",
                    },
                    ensure_ascii=False,
                ).encode("utf-8")
                request = Request(
                    f"http://127.0.0.1:{self.server.server_port}/api/calculator-leads",
                    data=body,
                    method="POST",
                    headers={"Content-Type": "application/json; charset=utf-8"},
                )

                with urlopen(request, timeout=2) as response:
                    payload = json.loads(response.read().decode("utf-8"))

                self.assertEqual(response.status, 200)
                self.assertTrue(payload["ok"])
                send_notification.assert_called_once()
                self.assertIn(f"Направление: {service}", send_notification.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
