import assert from "node:assert/strict";
import test from "node:test";

import { editableScanContourLines, resizeMeasurementWall } from "./measurementScanGeometry.js";

test("LiDAR contour becomes editable dimension lines without a duplicate closing point", () => {
  const contour = [
    { x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 },
    { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }, { x: 0.1, y: 0.1 },
  ];
  const lines = editableScanContourLines(contour, 2000, 3000, "scan-1");
  assert.equal(lines.length, 4);
  assert.deepEqual([lines[0].x1, lines[0].y1, lines[0].x2, lines[0].y2], [200, 2700, 1800, 2700]);
  assert.deepEqual([lines[3].x2, lines[3].y2], [200, 2700]);
  assert.equal(lines[0].value, "");
  assert.equal(lines[0].source_scan_session, "scan-1");
});

test("editing wall dimensions rescales scan geometry without changing measured labels", () => {
  const diagram = {
    wall: { width: 2000, height: 3000, points: [] },
    elements: [
      { id: "line", type: "dimension", x1: 200, y1: 300, x2: 800, y2: 300, value: 610 },
      { id: "socket", type: "socket_single", x: 500, y: 600, horizontal_distance: 500, vertical_distance: 600, width: 68, height: 68, source_scan_session: "scan-1" },
    ],
  };
  const result = resizeMeasurementWall(diagram, 4000, 1500);
  assert.deepEqual([result.elements[0].x1, result.elements[0].y1, result.elements[0].x2, result.elements[0].y2], [400, 150, 1600, 150]);
  assert.equal(result.elements[0].value, 610);
  assert.deepEqual([result.elements[1].x, result.elements[1].y], [1000, 300]);
  assert.deepEqual([result.elements[1].horizontal_distance, result.elements[1].vertical_distance], [1000, 300]);
  assert.equal(result.wall.width, 4000);
});

test("invalid dimensions do not modify the diagram", () => {
  const diagram = { wall: { width: 2000, height: 3000 }, elements: [] };
  assert.equal(resizeMeasurementWall(diagram, 0, 3000), diagram);
  assert.equal(resizeMeasurementWall(diagram, 2000, 21000), diagram);
});
