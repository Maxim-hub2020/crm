import json
import os
import re
import threading
import time
import uuid
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen


PORT = int(os.getenv("PORT", "8080"))
MAX_API_BASE_URL = os.getenv("MAX_API_BASE_URL", "https://platform-api2.max.ru").rstrip("/")
MAX_BOT_TOKEN = os.getenv("MAX_BOT_TOKEN", "").strip()
MAX_USER_ID = os.getenv("MAX_USER_ID", "").strip()
MAX_CHAT_ID = os.getenv("MAX_CHAT_ID", "").strip()
TELEGRAM_API_BASE_URL = os.getenv("TELEGRAM_API_BASE_URL", "https://api.telegram.org").rstrip("/")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "").strip()
ALLOWED_ORIGIN = os.getenv("ALLOWED_ORIGIN", "https://amalgama.cehcrm.ru").rstrip("/")
MAX_BODY_BYTES = 16 * 1024
RATE_LIMIT_COUNT = 5
RATE_LIMIT_WINDOW = 10 * 60
ALLOWED_SERVICES = {"Душевые", "Зеркала", "Мебель", "Комплексный проект"}
CALCULATOR_SERVICES = {"shower": "Душевые", "mirror": "Зеркала"}

_requests_by_ip = defaultdict(deque)
_rate_lock = threading.Lock()


def _clean_text(value, max_length):
    if not isinstance(value, str):
        return ""
    return " ".join(value.strip().split())[:max_length]


def _client_ip(handler):
    forwarded = handler.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",", 1)[0].strip()
    return handler.client_address[0]


def _is_rate_limited(ip_address):
    now = time.monotonic()
    cutoff = now - RATE_LIMIT_WINDOW
    with _rate_lock:
        entries = _requests_by_ip[ip_address]
        while entries and entries[0] < cutoff:
            entries.popleft()
        if len(entries) >= RATE_LIMIT_COUNT:
            return True
        entries.append(now)
        return False


def _recipient_query():
    if MAX_USER_ID:
        return {"user_id": MAX_USER_ID}
    if MAX_CHAT_ID:
        return {"chat_id": MAX_CHAT_ID}
    return None


def _build_message(lead, request_id):
    timestamp = datetime.now(timezone(timedelta(hours=3))).strftime("%d.%m.%Y %H:%M МСК")
    message = lead["message"] or "Не указано"
    heading = "Новая заявка из калькулятора AMALGAMA" if lead.get("source") == "calculator" else "Новая заявка с сайта AMALGAMA"
    lines = [
        heading,
        f"Номер заявки: {request_id}",
        f"Дата: {timestamp}",
        "",
        f"Имя: {lead['name']}",
        f"Телефон: {lead['phone']}",
        f"Направление: {lead['service']}",
        f"Задача: {message}",
    ]
    if lead.get("amount"):
        lines.append(f"Ориентировочная стоимость: {lead['amount']}")
    return "\n".join(lines)


def _send_to_telegram(text):
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        raise RuntimeError("Telegram integration is not configured")

    body = urlencode(
        {
            "chat_id": TELEGRAM_CHAT_ID,
            "text": text,
            "disable_web_page_preview": "true",
        }
    ).encode("utf-8")
    request = Request(
        f"{TELEGRAM_API_BASE_URL}/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
            "User-Agent": "amalgama-site-notifier/2.0",
        },
    )

    try:
        with urlopen(request, timeout=12) as response:
            payload = json.loads(response.read().decode("utf-8"))
            if response.status < 200 or response.status >= 300 or not payload.get("ok"):
                raise RuntimeError(f"Telegram API returned {response.status}")
    except HTTPError as error:
        raise RuntimeError(f"Telegram API returned {error.code}") from error
    except (URLError, TimeoutError, json.JSONDecodeError) as error:
        raise RuntimeError("Telegram API request failed") from error


def _send_to_max(text):
    recipient = _recipient_query()
    if not MAX_BOT_TOKEN or recipient is None:
        raise RuntimeError("MAX integration is not configured")

    url = f"{MAX_API_BASE_URL}/messages?{urlencode(recipient)}"
    body = json.dumps({"text": text, "notify": True}, ensure_ascii=False).encode("utf-8")
    request = Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": MAX_BOT_TOKEN,
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "amalgama-site-notifier/1.0",
        },
    )

    try:
        with urlopen(request, timeout=12) as response:
            if response.status < 200 or response.status >= 300:
                raise RuntimeError(f"MAX API returned {response.status}")
            json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        raise RuntimeError(f"MAX API returned {error.code}") from error
    except (URLError, TimeoutError, json.JSONDecodeError) as error:
        raise RuntimeError("MAX API request failed") from error


def _notification_channel():
    if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID:
        return "telegram"
    if MAX_BOT_TOKEN and _recipient_query():
        return "max"
    return ""


def _fallback_channel():
    if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID and MAX_BOT_TOKEN and _recipient_query():
        return "max"
    return ""


def _send_notification(text):
    if _notification_channel() == "telegram":
        try:
            _send_to_telegram(text)
            return
        except RuntimeError:
            if not _fallback_channel():
                raise
            print("telegram_delivery_failed fallback=max", flush=True)
    _send_to_max(text)


class LeadHandler(BaseHTTPRequestHandler):
    server_version = "AMALGAMA-Notifier/1.0"

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlsplit(self.path).path != "/health":
            self._send_json(404, {"ok": False})
            return
        self._send_json(
            200,
            {
                "ok": True,
                "configured": bool(_notification_channel()),
                "channel": _notification_channel(),
                "fallback": _fallback_channel(),
            },
        )

    def do_POST(self):
        request_path = urlsplit(self.path).path
        is_calculator_lead = request_path == "/api/calculator-leads"
        if request_path not in {"/api/site-leads", "/api/calculator-leads"}:
            self._send_json(404, {"ok": False})
            return

        if not is_calculator_lead:
            origin = self.headers.get("Origin")
            if origin and origin.rstrip("/") != ALLOWED_ORIGIN:
                self._send_json(403, {"ok": False})
                return

            fetch_site = self.headers.get("Sec-Fetch-Site")
            if fetch_site and fetch_site not in {"same-origin", "same-site"}:
                self._send_json(403, {"ok": False})
                return

        content_type = self.headers.get("Content-Type", "")
        if not content_type.lower().startswith("application/json"):
            self._send_json(415, {"ok": False})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length <= 0 or content_length > MAX_BODY_BYTES:
            self._send_json(413, {"ok": False})
            return

        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, {"ok": False})
            return
        if not isinstance(payload, dict):
            self._send_json(400, {"ok": False})
            return

        if not is_calculator_lead and _clean_text(payload.get("company"), 100):
            self._send_json(200, {"ok": True})
            return

        if not is_calculator_lead and _is_rate_limited(_client_ip(self)):
            self._send_json(429, {"ok": False})
            return

        product = _clean_text(payload.get("product"), 20)
        lead = {
            "name": _clean_text(payload.get("name"), 80),
            "phone": _clean_text(payload.get("phone"), 32),
            "service": CALCULATOR_SERVICES.get(product, _clean_text(payload.get("service"), 40)),
            "message": _clean_text(payload.get("message"), 1000),
            "amount": _clean_text(payload.get("amount"), 40),
            "source": "calculator" if is_calculator_lead else "site",
        }
        phone_digits = re.sub(r"\D", "", lead["phone"])
        if (
            len(lead["name"]) < 2
            or not lead["phone"].startswith("+7")
            or len(phone_digits) != 11
            or not phone_digits.startswith("7")
            or lead["service"] not in ALLOWED_SERVICES
        ):
            self._send_json(422, {"ok": False})
            return

        lead["phone"] = (
            f"+7 ({phone_digits[1:4]}) {phone_digits[4:7]}-"
            f"{phone_digits[7:9]}-{phone_digits[9:11]}"
        )

        request_id = uuid.uuid4().hex[:8].upper()
        try:
            _send_notification(_build_message(lead, request_id))
        except RuntimeError as error:
            print(f"lead_delivery_failed request_id={request_id} reason={error}", flush=True)
            self._send_json(502, {"ok": False})
            return

        print(f"lead_delivered request_id={request_id}", flush=True)
        self._send_json(200, {"ok": True, "request_id": request_id})

    def log_message(self, format_string, *args):
        return


class LeadServer(ThreadingHTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    print(f"notifier_listening port={PORT} channel={_notification_channel() or 'none'}", flush=True)
    LeadServer(("0.0.0.0", PORT), LeadHandler).serve_forever()
