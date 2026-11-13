import html
import re
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse

import requests


AV24_HOSTS = {"av24.su", "www.av24.su"}
DEFAULT_HEADERS = {
    "User-Agent": "CEH-CRM/1.0 (+https://cehcrm.ru; catalog synchronization)",
    "Accept-Language": "ru-RU,ru;q=0.9",
}


def _text(value):
    value = re.sub(r"<[^>]+>", " ", str(value or ""))
    return " ".join(html.unescape(value).split())


def _absolute(source_url, value):
    url = urljoin(source_url, html.unescape(value or ""))
    parsed = urlparse(url)
    if parsed.hostname not in AV24_HOSTS:
        return ""
    return parsed._replace(scheme="https").geturl()


def parse_product_page(source_url, markup, checked_at=None):
    parsed_source = urlparse(source_url)
    if parsed_source.hostname not in AV24_HOSTS:
        raise ValueError("Разрешены только карточки товаров AV24.")

    title_match = re.search(r"<h1[^>]*>(.*?)</h1>", markup, re.I | re.S)
    sku_match = re.search(
        r'class=["\'][^"\']*js-product-sku[^"\']*["\'][^>]*>(.*?)</span>',
        markup,
        re.I | re.S,
    )
    features = {}
    feature_pattern = re.compile(
        r'class=["\'][^"\']*product-features__name[^"\']*["\'][^>]*>(.*?)</div>\s*'
        r'<div[^>]*class=["\'][^"\']*product-features__value[^"\']*["\'][^>]*>(.*?)</div>',
        re.I | re.S,
    )
    for name, value in feature_pattern.findall(markup):
        clean_name, clean_value = _text(name), _text(value)
        if clean_name and clean_value:
            features[clean_name] = clean_value

    drawing_url = ""
    for href, label in re.findall(r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', markup, re.I | re.S):
        if ".pdf" in href.lower() and ("чертеж" in _text(label).lower() or "/drawings/" in href.lower()):
            drawing_url = _absolute(source_url, href)
            if drawing_url:
                break

    preview_url = ""
    drawing_position = markup.lower().find("чертеж")
    drawing_block = markup[drawing_position:drawing_position + 5000] if drawing_position >= 0 else ""
    preview_match = re.search(r'<img[^>]+src=["\']([^"\']+)["\']', drawing_block, re.I)
    if preview_match:
        preview_url = _absolute(source_url, preview_match.group(1))

    checked_at = checked_at or datetime.now(timezone.utc).isoformat(timespec="seconds")
    return {
        "source": "AV24",
        "sourcePage": source_url,
        "checkedAt": checked_at,
        "title": _text(title_match.group(1)) if title_match else "",
        "sku": _text(sku_match.group(1)) if sku_match else "",
        "features": features,
        "drawingUrl": drawing_url,
        "drawingPreviewUrl": preview_url,
        "sourceStatus": "linked" if drawing_url else "drawing_not_published",
        "review": {
            "status": "pending" if drawing_url else "blocked",
            "note": (
                "Техническая карта найдена. Требуется проверка размеров и операций технологом."
                if drawing_url else
                "На карточке товара не найдена техническая карта."
            ),
        },
    }


def fetch_product_page(source_url, timeout=20, session=None):
    parsed = urlparse(source_url)
    if parsed.scheme != "https" or parsed.hostname not in AV24_HOSTS:
        raise ValueError("Некорректная ссылка AV24.")
    client = session or requests.Session()
    response = client.get(source_url, headers=DEFAULT_HEADERS, timeout=timeout)
    response.raise_for_status()
    return parse_product_page(source_url, response.text)


def normalized_sku(value):
    value = str(value or "").upper().replace("Х", "X")
    match = re.search(r"\b(?:FD[A-Z]{1,3}|DK)-?\d+(?:[.-]\d+)*(?:[LR])?\b", value)
    return match.group(0).replace(" ", "") if match else ""


def referenced_hardware_ids(catalog):
    result = []
    for construction in catalog.get("constructions", []):
        for component in construction.get("hardwareComponents", []):
            item_id = str(component.get("hardwareItemId") or "")
            if item_id and item_id not in result:
                result.append(item_id)
    return result


def resolve_source_item(item, all_items):
    if item.get("sourceUrl"):
        return item
    target = normalized_sku(item.get("sku") or item.get("label"))
    if not target:
        return item
    candidates = [
        row for row in all_items
        if row.get("sourceUrl") and normalized_sku(row.get("sku") or row.get("label")) == target
    ]
    if not candidates:
        return item
    preferred = next((row for row in candidates if "/PSS" in str(row.get("sku") or "").upper()), None)
    return preferred or candidates[0]
