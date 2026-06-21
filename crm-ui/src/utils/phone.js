const PHONE_ERROR = "Телефон должен быть в формате +7-999-123-45-67, 8-999-123-45-67 или 10 цифр.";

export function phoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

export function formatRussianPhoneDigits(value) {
  const digits = phoneDigits(value).slice(0, 10);
  if (!digits) return "+7-";

  const parts = ["+7"];
  if (digits.length <= 3) {
    parts.push(digits);
  } else if (digits.length <= 6) {
    parts.push(digits.slice(0, 3), digits.slice(3));
  } else if (digits.length <= 8) {
    parts.push(digits.slice(0, 3), digits.slice(3, 6), digits.slice(6));
  } else {
    parts.push(digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 8), digits.slice(8, 10));
  }

  return parts.filter(Boolean).join("-");
}

export function formatRussianPhoneInput(value, { keepEmpty = true } = {}) {
  const raw = String(value || "");
  const digits = phoneDigits(raw);
  if (!digits) return keepEmpty ? "" : "+7-";

  let nationalDigits = digits;
  if (digits.startsWith("7") || digits.startsWith("8")) {
    nationalDigits = digits.slice(1);
  }

  if (!nationalDigits) return "+7-";
  return formatRussianPhoneDigits(nationalDigits);
}

export function normalizeRussianPhone(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const digits = phoneDigits(raw);
  if (digits.length === 10) return formatRussianPhoneDigits(digits);
  if (digits.length === 11 && (digits.startsWith("7") || digits.startsWith("8"))) {
    return formatRussianPhoneDigits(digits.slice(1));
  }

  return null;
}

export function clientPhoneValidationError(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return normalizeRussianPhone(raw) ? "" : PHONE_ERROR;
}

export function normalizeOptionalClientPhone(value) {
  return normalizeRussianPhone(value) || "";
}
