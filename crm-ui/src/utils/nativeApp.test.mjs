import test from "node:test";
import assert from "node:assert/strict";
import { nativeAppAvailable, sendNativeAction } from "./nativeApp.js";
import { openAppLink } from "./appLinks.js";

test("browser without native handler uses the original link", () => {
  let url;
  globalThis.window = { navigator: { userAgent: "iPhone" }, location: { assign(value) { url = value; } } };
  assert.equal(nativeAppAvailable(), false);
  assert.equal(sendNativeAction("scan", "cehcrm-lidar://scan"), false);
  openAppLink({ webUrl: "https://disk.yandex.ru/client/disk/test" });
  assert.equal(url, "https://disk.yandex.ru/client/disk/test");
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
