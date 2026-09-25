const DB_NAME = "crm-offline-measurements";
const STORE_NAME = "photos";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, callback) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = callback(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

export function addOfflineMeasurementPhoto(projectId, file) {
  const id = `${projectId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return withStore("readwrite", (store) => store.put({ id, projectId: String(projectId), name: file.name, type: file.type, blob: file }));
}

export async function listOfflineMeasurementPhotos(projectId) {
  const all = await withStore("readonly", (store) => store.getAll());
  return all.filter((item) => item.projectId === String(projectId));
}

export function deleteOfflineMeasurementPhoto(id) {
  return withStore("readwrite", (store) => store.delete(id));
}
