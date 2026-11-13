import json
import os
import re
from urllib import error as urllib_error
from urllib import request as urllib_request


def normalize_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip().lower()


def dadata_api_key():
    return (os.getenv("DADATA_API_KEY") or os.getenv("VITE_DADATA_API_KEY") or "").strip()


def dadata_default_region():
    return os.getenv("DADATA_DEFAULT_REGION", "Ростовская область").strip() or "Ростовская область"


def dadata_query(query):
    clean_query = str(query or "").strip()
    if not clean_query:
        return ""

    normalized = normalize_text(clean_query)
    region = dadata_default_region()
    region_markers = [normalize_text(region), "ростовск", "ростов-на-дону", "ростов на дону"]
    if any(marker and marker in normalized for marker in region_markers):
        return clean_query
    return f"{region}, {clean_query}" if region else clean_query


def suggest_dadata_address(query, count=1):
    api_key = dadata_api_key()
    if not api_key:
        return []

    payload = json.dumps(
        {
            "query": dadata_query(query),
            "count": max(1, min(int(count or 1), 10)),
            "locations_boost": [{"region": dadata_default_region()}],
        },
        ensure_ascii=False,
    ).encode("utf-8")
    request = urllib_request.Request(
        "https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address",
        data=payload,
        headers={
            "Authorization": f"Token {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib_request.urlopen(request, timeout=5) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError, urllib_error.URLError):
        return []

    suggestions = data.get("suggestions") if isinstance(data, dict) else []
    return suggestions if isinstance(suggestions, list) else []
