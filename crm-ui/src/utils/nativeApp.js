export function nativeAppAvailable() {
  return typeof window !== "undefined" &&
    (typeof window.CEHCRMNative?.postMessage === "function" ||
      typeof window.webkit?.messageHandlers?.cehCRM?.postMessage === "function");
}

export function nativeAppVersion() {
  if (typeof window === "undefined") return "";
  return window.CEHCRMNative?.version ||
    window.navigator?.userAgent?.match(/CEHCRM-iOS\/([^ ]+(?: \(\d+\))?)/)?.[1] || "";
}

export function nativeScannerAvailable(distributed = false) {
  return distributed || nativeAppAvailable() || Boolean(nativeAppVersion());
}

export function sendNativeAction(action, url, details = {}) {
  if (!nativeAppAvailable()) return false;
  try {
    if (typeof window.CEHCRMNative?.postMessage === "function") {
      window.CEHCRMNative.postMessage({ action, url, ...details });
    } else {
      window.webkit.messageHandlers.cehCRM.postMessage({ action, url, ...details });
    }
  } catch {
    return false;
  }
  return true;
}
