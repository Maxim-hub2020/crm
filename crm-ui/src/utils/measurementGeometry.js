export function snapOrthogonalPoint(start, candidate, toleranceDegrees = 10) {
  const dx = Number(candidate.x) - Number(start.x);
  const dy = Number(candidate.y) - Number(start.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
    return { point: candidate, axis: null };
  }

  const tolerance = Math.tan((toleranceDegrees * Math.PI) / 180);
  if (Math.abs(dy) <= Math.abs(dx) * tolerance) {
    return { point: { x: candidate.x, y: start.y }, axis: "horizontal" };
  }
  if (Math.abs(dx) <= Math.abs(dy) * tolerance) {
    return { point: { x: start.x, y: candidate.y }, axis: "vertical" };
  }
  return { point: candidate, axis: null };
}
