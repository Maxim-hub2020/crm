import assert from "node:assert/strict";
import test from "node:test";

import { snapOrthogonalPoint } from "./measurementGeometry.js";

test("snaps a nearly horizontal line to the exact axis", () => {
  assert.deepEqual(snapOrthogonalPoint({ x: 100, y: 200 }, { x: 900, y: 260 }), {
    point: { x: 900, y: 200 },
    axis: "horizontal",
  });
});

test("snaps a nearly vertical line to the exact axis", () => {
  assert.deepEqual(snapOrthogonalPoint({ x: 500, y: 100 }, { x: 440, y: 1000 }), {
    point: { x: 500, y: 1000 },
    axis: "vertical",
  });
});

test("keeps a deliberate angled line unchanged", () => {
  const candidate = { x: 700, y: 650 };
  assert.deepEqual(snapOrthogonalPoint({ x: 100, y: 100 }, candidate), { point: candidate, axis: null });
});
