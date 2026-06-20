const PHONE_ERROR = "Телефон должен быть в формате +7 999 123-45-67, 8 999 123-45-67 или 10 цифр.";

export function phoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

export function normalizeRussianPhone(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const digits = phoneDigits(raw);
  if (digits.length === 10) return `+7${digits}`;
  if (digits.length === 11 && (digits.startsWith("7") || digits.startsWith("8"))) {
    return `+7${digits.slice(1)}`;
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
