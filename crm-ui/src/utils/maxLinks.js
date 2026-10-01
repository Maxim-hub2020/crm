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

export function maxWebChatUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "max.ru" || url.pathname !== "/chat" ||
        !/^7\d{10}$/.test(url.searchParams.get("phone") || "")) return "https://web.max.ru/";
    const webUrl = new URL("https://web.max.ru/");
    webUrl.search = url.search;
    return webUrl.toString();
  } catch {
    return "https://web.max.ru/";
  }
}
