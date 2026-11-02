import assert from "node:assert/strict";
import test from "node:test";

import { MEASUREMENT_VIEWPORT, measurementViewportFraction, measurementViewportRenderBox, panMeasurementViewport, zoomMeasurementViewport } from "./measurementViewport.js";

test("zooms around the requested point", () => {
  assert.deepEqual(zoomMeasurementViewport(MEASUREMENT_VIEWPORT, 2, { x: 0.25, y: 0.5 }), {
    x: 125,
    y: 175,
    width: 500,
    height: 350,
  });
});

test("keeps a panned viewport inside the sheet", () => {
  const zoomed = zoomMeasurementViewport(MEASUREMENT_VIEWPORT, 2);
  assert.deepEqual(panMeasurementViewport(zoomed, 900, -900), {
    x: 500,
    y: 0,
    width: 500,
    height: 350,
  });
});

test("limits zoom to six times", () => {
  const zoomed = zoomMeasurementViewport(MEASUREMENT_VIEWPORT, 20);
  assert.equal(Math.round(MEASUREMENT_VIEWPORT.width / zoomed.width), 6);
});

test("maps touches correctly when a portrait screen letterboxes the drawing", () => {
  const rect = { left: 0, top: 100, width: 390, height: 700 };
  const rendered = measurementViewportRenderBox(rect, MEASUREMENT_VIEWPORT);
  assert.equal(rendered.height, 273);
  assert.deepEqual(measurementViewportFraction({ x: 195, y: rendered.y + rendered.height / 2 }, rect, MEASUREMENT_VIEWPORT), { x: 0.5, y: 0.5 });
});
