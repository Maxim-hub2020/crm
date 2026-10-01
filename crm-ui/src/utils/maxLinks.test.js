import assert from "node:assert/strict";
import test from "node:test";

import { validMaxChatUrl } from "./maxLinks.js";

test("MAX chat links are saved only from supported MAX domains", () => {
  assert.equal(validMaxChatUrl("https://max.ru/u/client-id"), "https://max.ru/u/client-id");
  assert.equal(validMaxChatUrl("https://max.ru/chat?phone=79000000000"), "");
  assert.equal(validMaxChatUrl("https://max.ru/:share?text=hello"), "");
  assert.equal(validMaxChatUrl("https://example.com/u/client-id"), "");
});
