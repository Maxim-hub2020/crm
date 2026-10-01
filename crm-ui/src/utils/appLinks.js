import { nativeAppAvailable, sendNativeAction } from "./nativeApp.js";

const ANDROID_USER_AGENT = /Android/i;

export function buildAndroidIntentUrl(webUrl, packageName) {
  const parsed = new URL(webUrl);
  const scheme = parsed.protocol.replace(":", "") || "https";
  const target = `${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
  return `intent://${target}#Intent;scheme=${scheme};package=${packageName};S.browser_fallback_url=${encodeURIComponent(webUrl)};end`;
}

export function openAppLink({ webUrl, nativeUrl = "", androidPackage = "" }) {
  if (!webUrl || typeof window === "undefined") return;
  if (sendNativeAction("openExternal", webUrl)) return;

  if (androidPackage && ANDROID_USER_AGENT.test(window.navigator.userAgent)) {
    window.location.assign(buildAndroidIntentUrl(webUrl, androidPackage));
    return;
  }

  if (!nativeUrl) {
    window.location.assign(webUrl);
    return;
  }

  let fallbackTimer;
  const cancelFallback = () => {
    if (fallbackTimer) window.clearTimeout(fallbackTimer);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("pagehide", cancelFallback);
  };
  const handleVisibilityChange = () => {
    if (document.hidden) cancelFallback();
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pagehide", cancelFallback, { once: true });
  fallbackTimer = window.setTimeout(() => {
    cancelFallback();
    if (!document.hidden) window.location.assign(webUrl);
  }, 1400);
  window.location.assign(nativeUrl);
}

export function maxNativeUrl(webUrl) {
  return String(webUrl || "").replace(/^https:\/\//i, "max://");
}

export function openNativeYandexRoute({ webUrl, mapsUrl, navigatorUrl = "" }) {
  if (!webUrl || !nativeAppAvailable()) return false;
  if (!window.CEHCRMNative?.capabilities?.route) return sendNativeAction("openExternal", webUrl);
  return sendNativeAction("openRoute", webUrl, { mapsUrl, navigatorUrl });
}
