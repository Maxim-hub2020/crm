import re

PHONE_VALIDATION_ERROR = "Телефон должен быть в формате +7-999-123-45-67, 8-999-123-45-67 или 10 цифр."


def phone_digits(value):
    return re.sub(r"\D", "", str(value or ""))


def russian_national_phone_digits(value):
    digits = phone_digits(value)
    if len(digits) > 11 and digits[0] in ("7", "8"):
        return digits[-10:]
    if len(digits) == 11 and digits[0] in ("7", "8"):
        return digits[1:]
    return digits


def format_russian_phone_digits(national_digits):
    digits = phone_digits(national_digits)[:10]
    if len(digits) != 10:
        return ""
    return f"+7-{digits[:3]}-{digits[3:6]}-{digits[6:8]}-{digits[8:10]}"


def normalize_russian_phone(value, *, strict=True):
    raw_value = str(value or "").strip()
    if not raw_value:
        return ""

    national_digits = russian_national_phone_digits(raw_value)
    if len(national_digits) == 10:
        return format_russian_phone_digits(national_digits)

    if strict:
        raise ValueError(PHONE_VALIDATION_ERROR)
    return raw_value


def phone_search_digits(value):
    digits = russian_national_phone_digits(value)
    if len(digits) >= 2 and len(digits) != 10 and digits[0] in ("7", "8"):
        return digits[1:]
    return digits
