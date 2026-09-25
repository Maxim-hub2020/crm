export const MEASUREMENT_VIEWPORT = { x: 0, y: 0, width: 1000, height: 700 };
export const MAX_MEASUREMENT_ZOOM = 6;

export function clampMeasurementViewport(viewport) {
  const minimumWidth = MEASUREMENT_VIEWPORT.width / MAX_MEASUREMENT_ZOOM;
  const width = Math.min(Math.max(Number(viewport.width) || MEASUREMENT_VIEWPORT.width, minimumWidth), MEASUREMENT_VIEWPORT.width);
  const height = width * (MEASUREMENT_VIEWPORT.height / MEASUREMENT_VIEWPORT.width);
  return {
    x: Math.min(Math.max(Number(viewport.x) || 0, 0), MEASUREMENT_VIEWPORT.width - width),
    y: Math.min(Math.max(Number(viewport.y) || 0, 0), MEASUREMENT_VIEWPORT.height - height),
    width,
    height,
  };
}

export function zoomMeasurementViewport(viewport, factor, anchor = { x: 0.5, y: 0.5 }) {
  const nextWidth = viewport.width / factor;
  const nextHeight = nextWidth * (MEASUREMENT_VIEWPORT.height / MEASUREMENT_VIEWPORT.width);
  const next = {
    x: viewport.x + viewport.width * anchor.x - nextWidth * anchor.x,
    y: viewport.y + viewport.height * anchor.y - nextHeight * anchor.y,
    width: nextWidth,
    height: nextHeight,
  };
  return clampMeasurementViewport(next);
}

export function panMeasurementViewport(viewport, deltaX, deltaY) {
  return clampMeasurementViewport({
    ...viewport,
    x: viewport.x + deltaX,
    y: viewport.y + deltaY,
  });
}
