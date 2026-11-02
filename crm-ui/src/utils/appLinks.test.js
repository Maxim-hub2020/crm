import test from "node:test";
import assert from "node:assert/strict";

import { buildAndroidIntentUrl } from "./appLinks.js";

test("builds an Android intent with an application package and browser fallback", () => {
  const webUrl = "https://disk.yandex.ru/client/disk/CRM/%D0%9F%D1%80%D0%BE%D0%B5%D0%BA%D1%82";
  const result = buildAndroidIntentUrl(webUrl, "ru.yandex.disk");

  assert.match(result, /^intent:\/\/disk\.yandex\.ru\/client\/disk\/CRM\//);
  assert.match(result, /scheme=https;package=ru\.yandex\.disk;/);
  assert.match(result, new RegExp(`S\\.browser_fallback_url=${encodeURIComponent(webUrl)}`));
});
