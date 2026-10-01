export function validMaxChatUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:" || !["max.ru", "max.page.link"].includes(url.hostname) ||
        url.username || url.password || url.port || !url.pathname.replaceAll("/", "") ||
        url.pathname.startsWith("/chat") || url.pathname.startsWith("/:share")) return "";
    return url.toString();
  } catch {
    return "";
  }
}
