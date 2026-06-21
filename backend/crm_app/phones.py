import re

PHONE_VALIDATION_ERROR = "Телефон должен быть в формате +7-999-123-45-67, 8-999-123-45-67 или 10 цифр."


def phone_digits(value):
    return re.sub(r"\D", "", str(value or ""))


def format_russian_phone_digits(national_digits):
    digits = phone_digits(national_digits)[:10]
    if len(digits) != 10:
        return ""
    return f"+7-{digits[:3]}-{digits[3:6]}-{digits[6:8]}-{digits[8:10]}"


def normalize_russian_phone(value, *, strict=True):
    raw_value = str(value or "").strip()
    if not raw_value:
        return ""

    digits = phone_digits(raw_value)
    national_digits = ""
    if len(digits) == 10:
        national_digits = digits
    elif len(digits) == 11 and digits[0] in ("7", "8"):
        national_digits = digits[1:]

    if national_digits:
        return format_russian_phone_digits(national_digits)

    if strict:
        raise ValueError(PHONE_VALIDATION_ERROR)
    return raw_value


def phone_search_digits(value):
    digits = phone_digits(value)
    if len(digits) >= 2 and digits[0] in ("7", "8"):
        return digits[1:]
    return digits
