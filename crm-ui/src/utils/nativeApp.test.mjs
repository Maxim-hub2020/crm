import test from "node:test";
import assert from "node:assert/strict";
import { nativeAppAvailable, nativeAppVersion, nativeScannerAvailable, sendNativeAction } from "./nativeApp.js";
import { openAppLink } from "./appLinks.js";

test("browser without native handler uses the original link", () => {
  let url;
  globalThis.window = { navigator: { userAgent: "iPhone" }, location: { assign(value) { url = value; } } };
  assert.equal(nativeAppAvailable(), false);
  assert.equal(nativeScannerAvailable(), false);
  assert.equal(sendNativeAction("scan", "cehcrm-lidar://scan"), false);
  openAppLink({ webUrl: "https://disk.yandex.ru/client/disk/test" });
  assert.equal(url, "https://disk.yandex.ru/client/disk/test");
  delete globalThis.window;
});

test("document-start bridge reports the build and launches the built-in scanner", () => {
  const messages = [];
  globalThis.window = { CEHCRMNative: { version: "1.0.0 (3)", postMessage(message) { messages.push(message); } } };
  assert.equal(nativeAppVersion(), "1.0.0 (3)");
  assert.equal(nativeScannerAvailable(), true);
  assert.equal(sendNativeAction("scan", "cehcrm-lidar://scan"), true);
  assert.deepEqual(messages, [{ action: "scan", url: "cehcrm-lidar://scan" }]);
  delete globalThis.window;
});

test("previous native build uses its user agent and custom-scheme fallback", () => {
  globalThis.window = { navigator: { userAgent: "Mozilla/5.0 iPhone CEHCRM-iOS/1.0" } };
  assert.equal(nativeAppVersion(), "1.0");
  assert.equal(nativeScannerAvailable(), true);
  assert.equal(sendNativeAction("scan", "cehcrm-lidar://scan"), false);
  delete globalThis.window;
});

test("unavailable bridge returns false instead of breaking the scan action", () => {
  globalThis.window = { CEHCRMNative: { postMessage() { throw new Error("Handler unavailable"); } } };
  assert.equal(sendNativeAction("scan", "cehcrm-lidar://scan"), false);
  delete globalThis.window;
});

test("native bridge forwards scan and external links without browser navigation", () => {
  const messages = [];
  globalThis.window = {
    webkit: { messageHandlers: { cehCRM: { postMessage(message) { messages.push(message); } } } },
    location: { assign() { assert.fail("Must not navigate"); } },
  };
  assert.equal(sendNativeAction("scan", "cehcrm-lidar://scan"), true);
  openAppLink({ webUrl: "https://disk.yandex.ru/client/disk/test" });
  assert.deepEqual(messages, [
    { action: "scan", url: "cehcrm-lidar://scan" },
    { action: "openExternal", url: "https://disk.yandex.ru/client/disk/test" },
  ]);
  delete globalThis.window;
});
