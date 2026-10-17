import assert from "node:assert/strict";
import test from "node:test";

import { mergeMeasurementSpecifications, packageMeasurementTranscript } from "./measurementTranscript.js";

test("structures a spoken mirror specification", () => {
  const items = packageMeasurementTranscript("Здесь зеркало с лицевой подсветкой 3000 кельвинов, сенсорное управление, с подогревом");
  assert.deepEqual(items.map(({ category, text }) => ({ category, text })), [
    { category: "product", text: "Изделие: Зеркало" },
    { category: "lighting", text: "Подсветка: Лицевая" },
    { category: "light_temperature", text: "Температура света: 3000 К" },
    { category: "control", text: "Управление: Сенсорное" },
    { category: "heating", text: "Подогрев: Есть" },
  ]);
});

test("understands spoken color temperature and missing lighting type", () => {
  const items = packageMeasurementTranscript("Зеркало с подсветкой четыре тысячи кельвинов без подогрева");
  assert.equal(items.find((item) => item.category === "lighting")?.text, "Подсветка: Есть, тип нужно уточнить");
  assert.equal(items.find((item) => item.category === "light_temperature")?.text, "Температура света: 4000 К");
  assert.equal(items.find((item) => item.category === "heating")?.text, "Подогрев: Нет");
});

test("replaces an existing structured value instead of duplicating it", () => {
  const existing = [{ id: "temperature", category: "light_temperature", text: "Температура света: 3000 К" }];
  const incoming = packageMeasurementTranscript("Температура подсветки 4000 кельвинов");
  const merged = mergeMeasurementSpecifications(existing, incoming);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((item) => item.category === "light_temperature")?.text, "Температура света: 4000 К");
});

test("keeps unrecognized parts of speech as editable notes", () => {
  const items = packageMeasurementTranscript("Крепёж согласовать после демонтажа. Позвонить заказчику");
  assert.deepEqual(items.map((item) => item.text), [
    "Крепление: Способ нужно уточнить",
    "Примечание: Позвонить заказчику",
  ]);
});

test("extracts production dimensions, shape and mounting", () => {
  const items = packageMeasurementTranscript("Прямоугольное зеркало 900 на 1800 миллиметров без рамы, крепление на клей");
  assert.equal(items.find((item) => item.category === "shape")?.text, "Форма: Прямоугольная");
  assert.equal(items.find((item) => item.category === "dimensions")?.text, "Размер: 900 × 1800 мм");
  assert.equal(items.find((item) => item.category === "frame")?.text, "Рама: Нет");
  assert.equal(items.find((item) => item.category === "mounting")?.text, "Крепление: На клей");
});
