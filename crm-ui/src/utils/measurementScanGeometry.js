export function editableScanContourLines(contour, width, height, sessionId) {
  if (!Array.isArray(contour)) return [];
  const points = contour.map((point) => ({
    x: Math.round(Number(point.x) * width),
    y: Math.round((1 - Number(point.y)) * height),
  })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (points.length > 1 && points[0].x === points.at(-1).x && points[0].y === points.at(-1).y) points.pop();
  if (points.length < 3) return [];
  return points.map((start, index) => {
    const end = points[(index + 1) % points.length];
    return {
      id: `lidar-${sessionId}-wall-${index}`,
      type: "dimension",
      side: "wall",
      label: `Контур LiDAR · сторона ${index + 1}`,
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      value: "",
      note: "Укажите фактический размер после замера",
      needs_review: true,
      source_scan_session: sessionId,
    };
  });
}

export function resizeMeasurementWall(diagram, nextWidth, nextHeight) {
  const previousWidth = Number(diagram.wall.width);
  const previousHeight = Number(diagram.wall.height);
  const width = Number(nextWidth);
  const height = Number(nextHeight);
  if (![previousWidth, previousHeight, width, height].every(Number.isFinite) ||
      previousWidth <= 0 || previousHeight <= 0 || width < 100 || height < 100 || width > 20000 || height > 20000) return diagram;
  const sx = width / previousWidth;
  const sy = height / previousHeight;
  const scale = (value, factor) => Math.round(Number(value) * factor);
  return {
    ...diagram,
    wall: {
      ...diagram.wall,
      width,
      height,
      points: (diagram.wall.points || []).map((point) => ({ x: scale(point.x, sx), y: scale(point.y, sy) })),
    },
    elements: (diagram.elements || []).map((element) => element.type === "dimension"
      ? { ...element, x1: scale(element.x1, sx), y1: scale(element.y1, sy), x2: scale(element.x2, sx), y2: scale(element.y2, sy) }
      : {
          ...element,
          x: scale(element.x, sx),
          y: scale(element.y, sy),
          ...(element.horizontal_distance != null ? { horizontal_distance: scale(element.horizontal_distance, sx) } : {}),
          ...(element.vertical_distance != null ? { vertical_distance: scale(element.vertical_distance, sy) } : {}),
          ...(element.source_scan_session ? {
            ...(element.width != null ? { width: scale(element.width, sx) } : {}),
            ...(element.height != null ? { height: scale(element.height, sy) } : {}),
          } : {}),
        }),
  };
}
