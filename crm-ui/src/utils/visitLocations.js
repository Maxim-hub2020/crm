const FINISHED_STATUS = /^(closed|completed|done|finished|canceled|cancelled|завершено|отменено)$/i;
let lastSyncedSignature = "";

export function projectVisitLocations(projects) {
  return (Array.isArray(projects) ? projects : []).flatMap((project) => {
    const address = String(project.object_address || "").trim();
    const rawLat = String(project.object_lat ?? "").trim();
    const rawLon = String(project.object_lon ?? "").trim();
    const lat = Number(rawLat);
    const lon = Number(rawLon);
    if (!project.id || !address || !rawLat || !rawLon ||
        !Number.isFinite(lat) || !Number.isFinite(lon) ||
        lat < -90 || lat > 90 || lon < -180 || lon > 180 ||
        FINISHED_STATUS.test(String(project.status || ""))) return [];
    return [{
      id: Number(project.id),
      title: [project.order_number_label ? `№${project.order_number_label}` : "", project.title || "Проект"].filter(Boolean).join(" · "),
      address,
      phone: String(project.client_phone || "").trim(),
      lat,
      lon,
    }];
  });
}

export function syncNativeVisitLocations(projects) {
  if (!window.CEHCRMNative?.capabilities?.visitAlerts) return false;
  const locations = projectVisitLocations(projects);
  const signature = JSON.stringify(locations);
  if (signature === lastSyncedSignature) return true;
  try {
    window.CEHCRMNative.postMessage({ action: "syncVisitLocations", projects: locations });
    lastSyncedSignature = signature;
    return true;
  } catch {
    return false;
  }
}

export function clearNativeVisitLocations() {
  lastSyncedSignature = "";
  if (!window.CEHCRMNative?.capabilities?.visitAlerts) return;
  try { window.CEHCRMNative.postMessage({ action: "clearVisitLocations" }); } catch { /* Native bridge unavailable. */ }
}
