import assert from "node:assert/strict";
import test from "node:test";

import { maxWebChatUrl, validMaxChatUrl } from "./maxLinks.js";

test("MAX chat links are saved only from supported MAX domains", () => {
  assert.equal(validMaxChatUrl("https://max.ru/u/client-id"), "https://max.ru/u/client-id");
  assert.equal(validMaxChatUrl("https://max.ru/chat?phone=79000000000"), "");
  assert.equal(validMaxChatUrl("https://max.ru/:share?text=hello"), "");
  assert.equal(validMaxChatUrl("https://example.com/u/client-id"), "");
});

test("iOS web fallback keeps the client phone on the official MAX web host", () => {
  const result = new URL(maxWebChatUrl("https://max.ru/chat?phone=79000000000&text=Hello"));
  assert.equal(result.origin, "https://web.max.ru");
  assert.equal(result.pathname, "/");
  assert.equal(result.searchParams.get("phone"), "79000000000");
  assert.equal(result.searchParams.get("text"), "Hello");
  assert.equal(maxWebChatUrl("https://example.com/chat?phone=79000000000"), "https://web.max.ru/");
});
