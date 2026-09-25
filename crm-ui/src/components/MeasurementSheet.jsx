import React, { useEffect, useRef, useState } from "react";
import { Camera, CheckCircle2, Cloud, CloudOff, FileDown, Paperclip, Plus, Trash2 } from "lucide-react";

import {
  createMeasurementScanSession,
  extractApiErrorMessage,
  fetchMeasurementScanSession,
  fetchMeasurementSheet,
  markMeasurementScanApplied,
  saveMeasurementSheet,
  uploadMeasurementPhotos,
} from "../api";
import { Button, Input, Label, Modal, Select } from "./ui.jsx";
import { addOfflineMeasurementPhoto, deleteOfflineMeasurementPhoto, listOfflineMeasurementPhotos } from "../utils/offlineMeasurements.js";
import MeasurementCanvas, { createDefaultDiagram } from "./MeasurementCanvas.jsx";

const EMPTY = {
  product_type: "mirror",
  mirror_type: "plain",
  shape: "rectangle",
  width_top: "", width_middle: "", width_bottom: "",
  height_left: "", height_middle: "", height_right: "",
  diagonal_one: "", diagonal_two: "",
  frame_material: "", frame_profile: "", frame_color: "",
  light_type: "none", light_offset: "", light_temperature: "4000",
  power_x: "", power_y: "", power_control: "switch",
  wall_material: "", mounting: "", wall_notes: "", openings: "", notes: "",
  diagram: createDefaultDiagram(),
  rooms: [],
};

function createRoom(index = 0, diagram = createDefaultDiagram()) {
  return {
    id: globalThis.crypto?.randomUUID?.() || `room-${Date.now()}-${index}`,
    name: `Комната ${index + 1}`,
    diagram,
  };
}

function normalizeMeasurementData(data) {
  const source = data || {};
  const rooms = Array.isArray(source.rooms) && source.rooms.length
    ? source.rooms.map((room, index) => ({
      id: room.id || `room-${index + 1}`,
      name: String(room.name || `Комната ${index + 1}`),
      diagram: room.diagram || createDefaultDiagram(),
    }))
    : [createRoom(0, source.diagram || createDefaultDiagram())];
  return { ...EMPTY, ...source, rooms, diagram: rooms[0].diagram };
}

function storageKey(projectId) {
  return `crm.measurement-sheet.v1.${projectId}`;
}

function scanStorageKey(projectId) {
  return `crm.measurement-lidar-scan.v1.${projectId}`;
}

const lidarScannerDistributed = import.meta.env.VITE_LIDAR_SCANNER_DISTRIBUTED === "true";
const lidarScannerInstallUrl = String(import.meta.env.VITE_LIDAR_SCANNER_INSTALL_URL || "").trim();

function readPendingScan(projectId) {
  try { return JSON.parse(localStorage.getItem(scanStorageKey(projectId)) || "null"); } catch { return null; }
}

const SCAN_ELEMENT_DEFAULTS = {
  socket_single: { label: "Розетка", width: 68, height: 68, diameter: 68, count: 1 },
  socket_double: { label: "Двойная розетка", width: 139, height: 68, diameter: 68, count: 2, spacing: 71 },
  socket_triple: { label: "Тройная розетка", width: 210, height: 68, diameter: 68, count: 3, spacing: 71 },
  cut_circle: { label: "Круглый вырез", width: 68, height: 68, diameter: 68, count: 1 },
  cut_rect: { label: "Прямоугольный вырез", width: 100, height: 70, count: 1 },
  power: { label: "Вывод проводов", width: 60, height: 60, count: 1 },
};

function diagramFromScan(diagram, scanSession) {
  const source = scanSession.result || {};
  const wallWidth = Math.max(Number(diagram?.wall?.width || 2000), 100);
  const wallHeight = Math.max(Number(diagram?.wall?.height || 2600), 100);
  const contour = Array.isArray(source.wall?.contour) ? source.wall.contour.map((point) => ({
    x: Math.round(Number(point.x || 0) * wallWidth),
    y: Math.round((1 - Number(point.y || 0)) * wallHeight),
  })) : [];
  const previousElements = Array.isArray(diagram?.elements)
    ? diagram.elements.filter((element) => element.source_scan_session !== scanSession.id)
    : [];
  const scannedElements = (Array.isArray(source.elements) ? source.elements : []).map((element, index) => {
    const template = SCAN_ELEMENT_DEFAULTS[element.type] || SCAN_ELEMENT_DEFAULTS.cut_rect;
    const x = Math.round(Number(element.x || 0) * wallWidth);
    const y = Math.round((1 - Number(element.y || 0)) * wallHeight);
    const width = element.width ? Math.max(Math.round(Number(element.width) * wallWidth), 20) : template.width;
    const height = element.height ? Math.max(Math.round(Number(element.height) * wallHeight), 20) : template.height;
    const diameter = element.diameter
      ? Math.max(Math.round(Number(element.diameter) * Math.min(wallWidth, wallHeight)), 20)
      : template.diameter;
    return {
      ...template,
      id: `lidar-${scanSession.id}-${index}`,
      type: element.type,
      side: "wall",
      label: element.label || template.label,
      x,
      y,
      width,
      height,
      ...(diameter ? { diameter } : {}),
      horizontal_reference: "left",
      vertical_reference: "bottom",
      horizontal_distance: x,
      vertical_distance: y,
      confidence: Number(element.confidence || 0),
      needs_review: Number(element.confidence || 0) < 0.8,
      source_scan_session: scanSession.id,
      note: Number(element.confidence || 0) < 0.8 ? "Проверьте объект, распознавание неуверенное" : "Распознано LiDAR-сканером",
    };
  });
  return {
    ...createDefaultDiagram(),
    ...(diagram || {}),
    active_view: "wall",
    wall: { ...createDefaultDiagram().wall, ...(diagram?.wall || {}), ...(contour.length >= 3 ? { points: contour } : {}) },
    elements: [...previousElements, ...scannedElements],
  };
}

function readDraft(projectId) {
  try { return JSON.parse(localStorage.getItem(storageKey(projectId)) || "null"); } catch { return null; }
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (symbol) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[symbol]);
}

export default function MeasurementSheet({ project }) {
  const [form, setForm] = useState(() => normalizeMeasurementData(null));
  const [activeRoomId, setActiveRoomId] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [completeRequested, setCompleteRequested] = useState(false);
  const [pendingPhotos, setPendingPhotos] = useState([]);
  const [syncState, setSyncState] = useState(navigator.onLine ? "saved" : "offline");
  const [error, setError] = useState("");
  const [scanSession, setScanSession] = useState(() => readPendingScan(project.id));
  const [scanMessage, setScanMessage] = useState("");
  const [lidarSetupOpen, setLidarSetupOpen] = useState(false);
  const loadedRef = useRef(false);
  const syncingRef = useRef(false);
  const applyingScanRef = useRef(new Set());
  const formRef = useRef(form);

  useEffect(() => { formRef.current = form; }, [form]);

  async function loadPending() {
    setPendingPhotos(await listOfflineMeasurementPhotos(project.id));
  }

  useEffect(() => {
    loadedRef.current = false;
    const local = readDraft(project.id);
    const localForm = normalizeMeasurementData(local?.data);
    setForm(localForm);
    setActiveRoomId(localForm.rooms[0]?.id || null);
    setSheet(null);
    setScanSession(readPendingScan(project.id));
    setScanMessage("");
    setCompleteRequested(Boolean(local?.completeRequested));
    loadPending().catch(() => {});
    if (!navigator.onLine) {
      setSyncState("offline");
      loadedRef.current = true;
      return;
    }
    fetchMeasurementSheet(project.id)
      .then((remote) => {
        setSheet(remote);
        if (!local?.dirty && remote?.data) {
          const remoteForm = normalizeMeasurementData(remote.data);
          setForm(remoteForm);
          setActiveRoomId(remoteForm.rooms[0]?.id || null);
        }
      })
      .catch((requestError) => setError(extractApiErrorMessage(requestError, "Не удалось загрузить замер.")))
      .finally(() => { loadedRef.current = true; });
  }, [project.id]);

  async function syncNow(nextForm = form, complete = false) {
    if (!navigator.onLine) {
      localStorage.setItem(storageKey(project.id), JSON.stringify({ data: nextForm, dirty: true, completeRequested: complete, updatedAt: Date.now() }));
      setCompleteRequested(complete);
      setSyncState("offline");
      return;
    }
    if (syncingRef.current) return;
    syncingRef.current = true;
    const syncStartedAt = Date.now();
    let queuedDraft = null;
    setSyncState("syncing");
    try {
      let saved = await saveMeasurementSheet({ project: project.id, data: nextForm, is_complete: complete });
      const queued = await listOfflineMeasurementPhotos(project.id);
      if (queued.length) {
        const files = queued.map((item) => new File([item.blob], item.name, { type: item.type || item.blob.type }));
        saved = await uploadMeasurementPhotos(saved.id, files);
        await Promise.all(queued.map((item) => deleteOfflineMeasurementPhoto(item.id)));
        await loadPending();
      }
      setSheet(saved);
      setCompleteRequested(Boolean(saved.is_complete));
      const latestDraft = readDraft(project.id);
      if (latestDraft?.dirty && Number(latestDraft.updatedAt || 0) > syncStartedAt) {
        queuedDraft = latestDraft;
        setSyncState("pending");
      } else {
        localStorage.setItem(storageKey(project.id), JSON.stringify({ data: nextForm, dirty: false, completeRequested: Boolean(saved.is_complete), updatedAt: Date.now() }));
        setSyncState("saved");
      }
      setError("");
    } catch (requestError) {
      setSyncState("offline");
      setError(extractApiErrorMessage(requestError, "Замер сохранён на телефоне и будет отправлен позже."));
    } finally {
      syncingRef.current = false;
      if (queuedDraft) window.setTimeout(() => syncNow(queuedDraft.data, Boolean(queuedDraft.completeRequested)), 0);
    }
  }

  useEffect(() => {
    if (!loadedRef.current) return undefined;
    localStorage.setItem(storageKey(project.id), JSON.stringify({ data: form, dirty: true, completeRequested, updatedAt: Date.now() }));
    setSyncState(navigator.onLine ? "pending" : "offline");
    const timer = window.setTimeout(() => syncNow(form, completeRequested), 900);
    return () => window.clearTimeout(timer);
  }, [form, project.id, completeRequested]);

  useEffect(() => {
    const handleOnline = () => {
      const draft = readDraft(project.id);
      if (draft?.dirty) syncNow(form, Boolean(draft.completeRequested));
      else setSyncState("saved");
    };
    const handleOffline = () => setSyncState("offline");
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => { window.removeEventListener("online", handleOnline); window.removeEventListener("offline", handleOffline); };
  }, [form, project.id]);

  function change(key, value) {
    setForm((previous) => ({ ...previous, [key]: value }));
  }

  function addRoom() {
    setForm((previous) => {
      const room = createRoom(previous.rooms.length);
      setActiveRoomId(room.id);
      return { ...previous, rooms: [...previous.rooms, room] };
    });
  }

  function updateActiveRoom(patch) {
    setForm((previous) => {
      const rooms = previous.rooms.map((room) => room.id === activeRoomId ? { ...room, ...patch } : room);
      return { ...previous, rooms, diagram: rooms[0]?.diagram || previous.diagram };
    });
  }

  function removeRoom(roomId) {
    setForm((previous) => {
      if (previous.rooms.length <= 1) return previous;
      const rooms = previous.rooms.filter((room) => room.id !== roomId);
      if (activeRoomId === roomId) setActiveRoomId(rooms[0].id);
      return { ...previous, rooms, diagram: rooms[0]?.diagram || createDefaultDiagram() };
    });
  }

  async function applyCompletedScan(completedSession) {
    if (applyingScanRef.current.has(completedSession.id)) return;
    applyingScanRef.current.add(completedSession.id);
    try {
      const roomFound = formRef.current.rooms.some((room) => room.id === completedSession.room_id);
      if (!roomFound) {
        setScanMessage("Комната для этого сканирования уже удалена. Запустите новое сканирование.");
        return;
      }
      setForm((previous) => {
        const rooms = previous.rooms.map((room) => {
          if (room.id !== completedSession.room_id) return room;
          return { ...room, diagram: diagramFromScan(room.diagram, completedSession) };
        });
        return { ...previous, rooms, diagram: rooms[0]?.diagram || previous.diagram };
      });
      setActiveRoomId(completedSession.room_id);
      await markMeasurementScanApplied(completedSession.id);
      localStorage.removeItem(scanStorageKey(project.id));
      setScanSession({ ...completedSession, status: "applied" });
      const reviewCount = (completedSession.result?.elements || []).filter((element) => Number(element.confidence || 0) < 0.8).length;
      setScanMessage(reviewCount
        ? `Сканирование импортировано. Проверьте выделенные объекты: ${reviewCount}.`
        : "Сканирование импортировано. Теперь проставьте точные размеры.");
    } finally {
      applyingScanRef.current.delete(completedSession.id);
    }
  }

  useEffect(() => {
    if (!scanSession?.id || ["applied", "expired"].includes(scanSession.status)) return undefined;
    let cancelled = false;
    async function checkScan() {
      try {
        const current = await fetchMeasurementScanSession(scanSession.id);
        if (cancelled) return;
        setScanSession(current);
        localStorage.setItem(scanStorageKey(project.id), JSON.stringify(current));
        if (current.status === "completed") await applyCompletedScan(current);
        if (current.status === "expired") setScanMessage("Время сканирования истекло. Запустите его ещё раз.");
      } catch (requestError) {
        if (!cancelled) setScanMessage(extractApiErrorMessage(requestError, "Не удалось получить результат сканирования."));
      }
    }
    checkScan();
    const timer = window.setInterval(checkScan, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [scanSession?.id, scanSession?.status, project.id]);

  async function startLidarScan() {
    if (!activeRoom) return;
    if (!lidarScannerDistributed) {
      setLidarSetupOpen(true);
      return;
    }
    try {
      setScanMessage("Открываем LiDAR-сканер...");
      const created = await createMeasurementScanSession({
        project: project.id,
        room_id: activeRoom.id,
        room_name: activeRoom.name,
      });
      localStorage.setItem(scanStorageKey(project.id), JSON.stringify(created));
      setScanSession(created);
      window.location.assign(created.launch_url);
    } catch (requestError) {
      setScanMessage(extractApiErrorMessage(requestError, "Не удалось запустить LiDAR-сканер."));
    }
  }

  async function addPhotos(event) {
    const files = Array.from(event.target.files || []);
    await Promise.all(files.map((file) => addOfflineMeasurementPhoto(project.id, file)));
    await loadPending();
    event.target.value = "";
    if (navigator.onLine) syncNow(); else setSyncState("offline");
  }

  async function removePendingPhoto(id) {
    await deleteOfflineMeasurementPhoto(id);
    await loadPending();
  }

  function printSheet() {
    const regularRows = Object.entries(form).filter(([key, value]) => key !== "diagram" && key !== "rooms" && value).map(([key, value]) => `<tr><td>${escapeHtml(key.replaceAll("_", " "))}</td><td>${escapeHtml(value)}</td></tr>`);
    const roomRows = form.rooms.flatMap((room) => {
      const diagramElements = Array.isArray(room.diagram?.elements) ? room.diagram.elements : [];
      const drawingRows = diagramElements.map((element, index) => {
      const side = { wall: "Стена", front: "Лицевая сторона", back: "Задняя сторона" }[element.side] || element.side || "";
      if (element.type === "dimension") return `<tr><td>Размерная линия ${index + 1} · ${escapeHtml(side)}</td><td><strong>${escapeHtml(element.value)} мм</strong>; от (${escapeHtml(element.x1)}, ${escapeHtml(element.y1)}) до (${escapeHtml(element.x2)}, ${escapeHtml(element.y2)})${element.note ? `; ${escapeHtml(element.note)}` : ""}</td></tr>`;
      const references = `; ${element.horizontal_reference === "right" ? "справа" : "слева"} ${escapeHtml(element.horizontal_distance)} мм; ${element.vertical_reference === "top" ? "от потолка" : "от пола"} ${escapeHtml(element.vertical_distance)} мм`;
      if (element.type === "cut_circle" || element.type?.startsWith("socket")) return `<tr><td>${escapeHtml(element.label)} · ${escapeHtml(side)}</td><td>Ø ${escapeHtml(element.diameter)} мм${references}${Number(element.count || 1) > 1 ? `; количество ${escapeHtml(element.count)}; шаг ${escapeHtml(element.spacing)} мм` : ""}</td></tr>`;
      if (element.type === "cut_rect") return `<tr><td>${escapeHtml(element.label)} · ${escapeHtml(side)}</td><td>${escapeHtml(element.width)} × ${escapeHtml(element.height)} мм${references}</td></tr>`;
      return "";
      }).filter(Boolean);
      return [`<tr><td colspan="2" style="background:#eef2f6;font-size:16px">${escapeHtml(room.name)}</td></tr>`, ...drawingRows];
    });
    const rows = [...regularRows, ...roomRows].join("");
    const popup = window.open("", "_blank");
    if (!popup) return;
    popup.opener = null;
    popup.document.write(`<html><head><title>Замер ${escapeHtml(project.title)}</title><style>body{font:14px Arial;padding:28px;color:#111}h1{font-size:22px}table{width:100%;border-collapse:collapse}td{padding:8px;border:1px solid #bbb}td:first-child{width:38%;font-weight:700;text-transform:uppercase}</style></head><body><h1>Замер: №${escapeHtml(project.order_number_label || project.id)} · ${escapeHtml(project.title)}</h1><table>${rows}</table><p>Фотографий: ${(sheet?.photos?.length || 0) + pendingPhotos.length}</p></body></html>`);
    popup.document.close();
    popup.focus();
    popup.print();
  }

  const hasFrame = form.mirror_type === "frame" || form.mirror_type === "frame_light";
  const hasLight = form.mirror_type === "backlight" || form.mirror_type === "frontlight" || form.mirror_type === "frame_light";
  const photoCount = (sheet?.photos?.length || 0) + pendingPhotos.length;
  const activeRoom = form.rooms.find((room) => room.id === activeRoomId) || form.rooms[0];
  const allDiagramElements = form.rooms.flatMap((room) => Array.isArray(room.diagram?.elements) ? room.diagram.elements : []);
  const requiredDimensionCount = form.shape === "round" ? 1 : 2;
  const roomsWithoutDimensions = form.rooms.filter((room) => {
    const elements = Array.isArray(room.diagram?.elements) ? room.diagram.elements : [];
    return elements.filter((element) => element.type === "dimension" && Number(element.value) > 0).length < requiredDimensionCount;
  });
  const hasPowerPoint = allDiagramElements.some((element) => element.type === "power");
  const validationIssues = [
    ...roomsWithoutDimensions.map((room) => `На листе «${room.name}» добавьте минимум ${requiredDimensionCount} размер${requiredDimensionCount === 1 ? "" : "а"}`),
    ...(hasLight && !hasPowerPoint && (!form.power_x || !form.power_y) ? ["Добавьте на заднюю сторону точку вывода питания"] : []),
    ...(photoCount === 0 ? ["Добавьте хотя бы одну фотографию"] : []),
  ];
  const statusText = syncState === "offline" ? "Сохранено на телефоне" : syncState === "syncing" ? "Отправляем..." : syncState === "pending" ? "Есть изменения" : "Синхронизировано";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-slate-50 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-bold text-slate-600">
          {syncState === "offline" ? <CloudOff size={17} /> : <Cloud size={17} className="text-emerald-600" />}{statusText}
        </div>
        <Button type="button" variant="secondary" onClick={printSheet}><FileDown size={16} />Печать / PDF</Button>
      </div>
      <section className="rounded-[24px] border border-slate-200 bg-white p-3 sm:p-4">
        <div className="flex gap-2 overflow-x-auto pb-3 [scrollbar-width:none]">
          {form.rooms.map((room) => <button key={room.id} type="button" onClick={() => setActiveRoomId(room.id)} className={`shrink-0 rounded-full px-4 py-2 text-sm font-bold transition ${room.id === activeRoom?.id ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`}>{room.name}</button>)}
          <button type="button" onClick={addRoom} className="inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed border-slate-300 px-4 py-2 text-sm font-bold text-slate-600"><Plus size={15} />Добавить комнату</button>
        </div>
        <div className="flex items-end gap-2 border-t border-slate-100 pt-3">
          <Field label="Название комнаты"><Input value={activeRoom?.name || ""} onChange={(event) => updateActiveRoom({ name: event.target.value })} placeholder="Например, ванная" /></Field>
          {form.rooms.length > 1 ? <Button type="button" variant="secondary" onClick={() => removeRoom(activeRoom.id)} title="Удалить лист"><Trash2 size={16} /></Button> : null}
        </div>
      </section>
      {activeRoom ? <MeasurementCanvas key={activeRoom.id} value={activeRoom.diagram} onChange={(diagram) => updateActiveRoom({ diagram })} onStartLidar={startLidarScan} lidarStatus={scanMessage} /> : null}
      {hasFrame ? <Section title="Рамка"><div className="grid gap-3 sm:grid-cols-3"><Field label="Материал"><Input value={form.frame_material} onChange={(e)=>change("frame_material",e.target.value)} /></Field><Field label="Профиль"><Input value={form.frame_profile} onChange={(e)=>change("frame_profile",e.target.value)} /></Field><Field label="Цвет"><Input value={form.frame_color} onChange={(e)=>change("frame_color",e.target.value)} /></Field></div></Section> : null}
      {hasLight ? <Section title="Подсветка и электрика"><div className="grid gap-3 sm:grid-cols-3"><Field label="Тип"><Select value={form.light_type} onChange={(e)=>change("light_type",e.target.value)}><option value="rear">Задняя</option><option value="front">Лицевая</option></Select></Field><Field label="Отступ световой линии"><Input inputMode="decimal" value={form.light_offset} onChange={(e)=>change("light_offset",e.target.value)} /></Field><Field label="Температура"><Select value={form.light_temperature} onChange={(e)=>change("light_temperature",e.target.value)}><option value="3000">3000 K</option><option value="4000">4000 K</option><option value="6000">6000 K</option></Select></Field><Field label="Вывод питания X"><Input inputMode="decimal" value={form.power_x} onChange={(e)=>change("power_x",e.target.value)} /></Field><Field label="Вывод питания Y"><Input inputMode="decimal" value={form.power_y} onChange={(e)=>change("power_y",e.target.value)} /></Field><Field label="Управление"><Select value={form.power_control} onChange={(e)=>change("power_control",e.target.value)}><option value="switch">Выключатель</option><option value="sensor">Датчик</option><option value="dimmer">Диммер</option></Select></Field></div></Section> : null}
      <Section title="Монтаж"><div className="grid gap-3 sm:grid-cols-2"><Field label="Материал стены"><Input value={form.wall_material} onChange={(e)=>change("wall_material",e.target.value)} /></Field><Field label="Крепление"><Input value={form.mounting} onChange={(e)=>change("mounting",e.target.value)} /></Field></div><Field label="Неровности, препятствия, коммуникации"><textarea className="mt-1 min-h-24 w-full rounded-xl border border-slate-200 p-3 text-sm" value={form.wall_notes} onChange={(e)=>change("wall_notes",e.target.value)} /></Field></Section>
      <Section title="Фотографии"><div className="flex flex-wrap gap-2">{sheet?.photos?.map((photo)=><a key={photo.id} href={photo.url} target="_blank" rel="noreferrer" className="rounded-full bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">{photo.original_name}</a>)}{pendingPhotos.map((photo)=><span key={photo.id} className="inline-flex items-center gap-2 rounded-full bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">{photo.name}<button type="button" onClick={()=>removePendingPhoto(photo.id)}><Trash2 size={13}/></button></span>)}</div><div className="mt-3 flex flex-wrap gap-2"><label className="btn-hover inline-flex cursor-pointer items-center gap-2 rounded-full bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white"><Camera size={16}/>Снять или выбрать фото<input type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={addPhotos}/></label><label className="btn-hover inline-flex cursor-pointer items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold"><Paperclip size={16}/>Добавить файлы<input type="file" multiple className="hidden" onChange={addPhotos}/></label></div></Section>
      <Field label="Общий комментарий"><textarea className="mt-1 min-h-28 w-full rounded-xl border border-slate-200 p-3 text-sm" value={form.notes} onChange={(e)=>change("notes",e.target.value)} /></Field>
      {validationIssues.length ? <div className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900"><div className="font-black">До завершения замера:</div><ul className="mt-1 list-disc pl-5">{validationIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul></div> : null}
      {error ? <div className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800">{error}</div> : null}
      <Button type="button" className="w-full sm:w-auto" disabled={validationIssues.length > 0} onClick={() => { setCompleteRequested(true); syncNow(form, true); }}><CheckCircle2 size={17}/>{sheet?.is_complete || completeRequested ? "Замер завершён" : "Завершить замер"}</Button>
      <Modal open={lidarSetupOpen} title="Приложение CEH LiDAR не установлено" onClose={() => setLidarSetupOpen(false)} widthClassName="max-w-lg">
        <div className="space-y-4 text-sm leading-relaxed text-slate-600">
          <p>Safari не умеет работать с RoomPlan и LiDAR напрямую. Для сканирования на iPhone 15 Pro нужно отдельное приложение CEH LiDAR, установленное через TestFlight или Xcode.</p>
          <p className="rounded-2xl bg-amber-50 px-4 py-3 font-semibold text-amber-900">Сканер пока не опубликован для установки, поэтому CRM больше не открывает недействительный адрес в Safari.</p>
          {lidarScannerInstallUrl ? <a href={lidarScannerInstallUrl} target="_blank" rel="noreferrer" className="inline-flex rounded-full bg-slate-900 px-4 py-2.5 font-bold text-white">Установить CEH LiDAR</a> : null}
          <div><Button type="button" variant="secondary" onClick={() => setLidarSetupOpen(false)}>Понятно</Button></div>
        </div>
      </Modal>
    </div>
  );
}

function Field({ label, children }) { return <label className="block space-y-1.5"><Label>{label}</Label>{children}</label>; }
function Section({ title, children }) { return <section className="space-y-3 rounded-[24px] border border-slate-200 bg-white p-4"><h3 className="font-black text-slate-900">{title}</h3>{children}</section>; }
