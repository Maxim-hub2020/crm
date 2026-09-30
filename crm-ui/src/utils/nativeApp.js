export function nativeAppAvailable() {
  return typeof window !== "undefined" &&
    typeof window.webkit?.messageHandlers?.cehCRM?.postMessage === "function";
}

export function sendNativeAction(action, url) {
  if (!nativeAppAvailable()) return false;
  window.webkit.messageHandlers.cehCRM.postMessage({ action, url });
  return true;
}
