import test from "node:test";
import assert from "node:assert/strict";
import { clearNativeVisitLocations, projectVisitLocations, syncNativeVisitLocations } from "./visitLocations.js";

test("only active projects with verified coordinates are monitored", () => {
  const result = projectVisitLocations([
    { id: 1, order_number_label: "0041", title: "Зеркало", object_address: "Ростов-на-Дону, Ленина, 1", object_lat: "47.2", object_lon: "39.7", status: "active" },
    { id: 2, object_address: "Ленина, 2", object_lat: "", object_lon: "39.7", status: "active" },
    { id: 3, object_address: "Ленина, 3", object_lat: "47.2", object_lon: "39.7", status: "closed" },
    { id: 4, object_address: "Ленина, 4", object_lat: "91", object_lon: "39.7", status: "active" },
  ]);
  assert.deepEqual(result, [{ id: 1, title: "№0041 · Зеркало", address: "Ростов-на-Дону, Ленина, 1", lat: 47.2, lon: 39.7 }]);
});

test("native sync sends the sanitized project list", () => {
  const messages = [];
  globalThis.window = { CEHCRMNative: { capabilities: { visitAlerts: true }, postMessage: (message) => messages.push(message) } };
  assert.equal(syncNativeVisitLocations([{ id: 5, title: "Тест", object_address: "Адрес", object_lat: "47", object_lon: "40" }]), true);
  assert.equal(messages[0].action, "syncVisitLocations");
  assert.equal(messages[0].projects[0].id, 5);
  assert.equal(syncNativeVisitLocations([{ id: 5, title: "Тест", object_address: "Адрес", object_lat: "47", object_lon: "40" }]), true);
  assert.equal(messages.length, 1);
  clearNativeVisitLocations();
  assert.equal(messages[1].action, "clearVisitLocations");
  delete globalThis.window;
});
