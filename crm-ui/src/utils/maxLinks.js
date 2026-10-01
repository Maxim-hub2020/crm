export function validMaxChatUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:" || !["max.ru", "max.page.link"].includes(url.hostname) ||
        url.username || url.password || url.port || !url.pathname.replaceAll("/", "") ||
        url.pathname.startsWith("/chat")) return "";
    return url.toString();
  } catch {
    return "";
  }
}

export function maxShareUrl(text) {
  return `https://max.ru/:share?text=${encodeURIComponent(text)}`;
}
