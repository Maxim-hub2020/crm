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

export function measurementViewportRenderBox(rect, viewport) {
  const viewportAspect = viewport.width / viewport.height;
  const rectAspect = rect.width / rect.height;
  if (rectAspect > viewportAspect) {
    const width = rect.height * viewportAspect;
    return { x: rect.left + (rect.width - width) / 2, y: rect.top, width, height: rect.height };
  }
  const height = rect.width / viewportAspect;
  return { x: rect.left, y: rect.top + (rect.height - height) / 2, width: rect.width, height };
}

export function measurementViewportFraction(clientPoint, rect, viewport) {
  const rendered = measurementViewportRenderBox(rect, viewport);
  return {
    x: Math.min(Math.max((clientPoint.x - rendered.x) / rendered.width, 0), 1),
    y: Math.min(Math.max((clientPoint.y - rendered.y) / rendered.height, 0), 1),
  };
}
