import test from "node:test";
import assert from "node:assert/strict";
import { nativeAppAvailable, nativeAppVersion, nativeScannerAvailable, sendNativeAction } from "./nativeApp.js";
import { openAppLink, openNativeYandexRoute } from "./appLinks.js";

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

test("new iOS build sends the complete route to its native Yandex Maps handler", () => {
  const messages = [];
  globalThis.window = {
    CEHCRMNative: { capabilities: { route: true }, postMessage(message) { messages.push(message); } },
  };
  assert.equal(openNativeYandexRoute({
    webUrl: "https://yandex.ru/maps/?mode=routes&rtext=~47.23,39.71",
    mapsUrl: "yandexmaps://build_route_on_map/?lat_to=47.23&lon_to=39.71",
    navigatorUrl: "yandexnavi://build_route_on_map?lat_to=47.23&lon_to=39.71",
  }), true);
  assert.equal(messages[0].action, "openRoute");
  assert.match(messages[0].mapsUrl, /lat_to=47\.23/);
  delete globalThis.window;
});

test("older iOS build opens the route URL instead of dropping the action", () => {
  const messages = [];
  globalThis.window = { CEHCRMNative: { postMessage(message) { messages.push(message); } } };
  assert.equal(openNativeYandexRoute({ webUrl: "https://yandex.ru/maps/?mode=routes&rtext=~47.23,39.71" }), true);
  assert.deepEqual(messages, [{ action: "openExternal", url: "https://yandex.ru/maps/?mode=routes&rtext=~47.23,39.71" }]);
  delete globalThis.window;
});
