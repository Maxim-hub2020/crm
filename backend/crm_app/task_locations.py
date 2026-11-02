from .dadata import normalize_text, suggest_dadata_address


ROSTOV_ZONE_BY_DISTRICT = {
    "советск": "Западный",
    "железнодорож": "Западный",
    "ворошиловск": "Северный",
    "октябрьск": "Северный",
    "ленинск": "Центр",
    "кировск": "Центр",
    "первомайск": "Сельмаш",
    "пролетарск": "Сельмаш",
}


def task_zone_from_dadata(data, address=""):
    data = data if isinstance(data, dict) else {}
    street_and_address = normalize_text(" ".join([
        str(data.get("street") or ""),
        str(address or ""),
    ]))
    if "береговая" in street_and_address:
        return "Береговая"

    city = normalize_text(data.get("city") or data.get("settlement"))
    administrative_district = normalize_text(data.get("city_district") or "")
    if "ростов" in city:
        for marker, zone in ROSTOV_ZONE_BY_DISTRICT.items():
            if marker in administrative_district:
                return zone

    return str(data.get("city_district") or "").strip()


def infer_task_location(address):
    clean_address = str(address or "").strip()
    if len(clean_address) < 3:
        return {}

    suggestions = suggest_dadata_address(clean_address, count=1)
    if not suggestions or not isinstance(suggestions[0], dict):
        return {}

    suggestion = suggestions[0]
    data = suggestion.get("data") if isinstance(suggestion.get("data"), dict) else {}
    return {
        "city": str(data.get("city") or data.get("settlement") or "").strip(),
        "district": task_zone_from_dadata(data, suggestion.get("value") or clean_address),
    }
