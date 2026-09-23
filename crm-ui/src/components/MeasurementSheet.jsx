import React, { useEffect, useRef, useState } from "react";
import { Camera, CheckCircle2, Cloud, CloudOff, FileDown, Paperclip, Trash2 } from "lucide-react";

import { extractApiErrorMessage, fetchMeasurementSheet, saveMeasurementSheet, uploadMeasurementPhotos } from "../api";
import { Button, Input, Label, Select } from "./ui.jsx";
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
};

function storageKey(projectId) {
  return `crm.measurement-sheet.v1.${projectId}`;
}

function readDraft(projectId) {
  try { return JSON.parse(localStorage.getItem(storageKey(projectId)) || "null"); } catch { return null; }
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (symbol) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[symbol]);
}

export default function MeasurementSheet({ project }) {
  const [form, setForm] = useState(EMPTY);
  const [sheet, setSheet] = useState(null);
  const [completeRequested, setCompleteRequested] = useState(false);
  const [pendingPhotos, setPendingPhotos] = useState([]);
  const [syncState, setSyncState] = useState(navigator.onLine ? "saved" : "offline");
  const [error, setError] = useState("");
  const loadedRef = useRef(false);
  const syncingRef = useRef(false);

  async function loadPending() {
    setPendingPhotos(await listOfflineMeasurementPhotos(project.id));
  }

  useEffect(() => {
    loadedRef.current = false;
    const local = readDraft(project.id);
    setForm(local?.data ? { ...EMPTY, ...local.data } : EMPTY);
    setSheet(null);
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
        if (!local?.dirty && remote?.data) setForm({ ...EMPTY, ...remote.data });
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
    const rows = Object.entries(form).filter(([key, value]) => key !== "diagram" && value).map(([key, value]) => `<tr><td>${escapeHtml(key.replaceAll("_", " "))}</td><td>${escapeHtml(value)}</td></tr>`).join("");
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
  const validationIssues = [
    ...(!form.width_middle ? ["Укажите основную ширину"] : []),
    ...(!form.height_middle ? ["Укажите основную высоту"] : []),
    ...(hasLight && (!form.power_x || !form.power_y) ? ["Укажите координаты вывода питания"] : []),
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
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Конструкция"><Select value={form.mirror_type} onChange={(e) => { const value = e.target.value; setForm((previous) => ({ ...previous, mirror_type: value, light_type: value === "backlight" ? "rear" : value === "frontlight" ? "front" : previous.light_type })); }}><option value="plain">Обычное зеркало</option><option value="backlight">Задняя подсветка</option><option value="frontlight">Лицевая подсветка</option><option value="frame">С рамкой</option><option value="frame_light">Рамка и подсветка</option></Select></Field>
        <Field label="Форма"><Select value={form.shape} onChange={(e) => { const shape = e.target.value; setForm((previous) => ({ ...previous, shape, diagram: { ...createDefaultDiagram(), ...(previous.diagram || {}), product: { ...createDefaultDiagram().product, ...(previous.diagram?.product || {}), shape } } })); }}><option value="rectangle">Прямоугольник</option><option value="round">Круг</option><option value="oval">Овал</option><option value="arch">Арка</option><option value="custom">Произвольная</option></Select></Field>
      </div>
      <MeasurementCanvas value={form.diagram} onChange={(diagram) => change("diagram", diagram)} />
      <Section title="Размеры места установки, мм">
        <div className="grid gap-3 sm:grid-cols-3">{[["width_top","Ширина сверху"],["width_middle","Ширина по центру"],["width_bottom","Ширина снизу"],["height_left","Высота слева"],["height_middle","Высота по центру"],["height_right","Высота справа"],["diagonal_one","Диагональ 1"],["diagonal_two","Диагональ 2"]].map(([key,label]) => <Field key={key} label={label}><Input inputMode="decimal" value={form[key]} onChange={(e) => change(key,e.target.value)} /></Field>)}</div>
      </Section>
      {hasFrame ? <Section title="Рамка"><div className="grid gap-3 sm:grid-cols-3"><Field label="Материал"><Input value={form.frame_material} onChange={(e)=>change("frame_material",e.target.value)} /></Field><Field label="Профиль"><Input value={form.frame_profile} onChange={(e)=>change("frame_profile",e.target.value)} /></Field><Field label="Цвет"><Input value={form.frame_color} onChange={(e)=>change("frame_color",e.target.value)} /></Field></div></Section> : null}
      {hasLight ? <Section title="Подсветка и электрика"><div className="grid gap-3 sm:grid-cols-3"><Field label="Тип"><Select value={form.light_type} onChange={(e)=>change("light_type",e.target.value)}><option value="rear">Задняя</option><option value="front">Лицевая</option></Select></Field><Field label="Отступ световой линии"><Input inputMode="decimal" value={form.light_offset} onChange={(e)=>change("light_offset",e.target.value)} /></Field><Field label="Температура"><Select value={form.light_temperature} onChange={(e)=>change("light_temperature",e.target.value)}><option value="3000">3000 K</option><option value="4000">4000 K</option><option value="6000">6000 K</option></Select></Field><Field label="Вывод питания X"><Input inputMode="decimal" value={form.power_x} onChange={(e)=>change("power_x",e.target.value)} /></Field><Field label="Вывод питания Y"><Input inputMode="decimal" value={form.power_y} onChange={(e)=>change("power_y",e.target.value)} /></Field><Field label="Управление"><Select value={form.power_control} onChange={(e)=>change("power_control",e.target.value)}><option value="switch">Выключатель</option><option value="sensor">Датчик</option><option value="dimmer">Диммер</option></Select></Field></div></Section> : null}
      <Section title="Монтаж"><div className="grid gap-3 sm:grid-cols-2"><Field label="Материал стены"><Input value={form.wall_material} onChange={(e)=>change("wall_material",e.target.value)} /></Field><Field label="Крепление"><Input value={form.mounting} onChange={(e)=>change("mounting",e.target.value)} /></Field></div><Field label="Неровности, препятствия, коммуникации"><textarea className="mt-1 min-h-24 w-full rounded-xl border border-slate-200 p-3 text-sm" value={form.wall_notes} onChange={(e)=>change("wall_notes",e.target.value)} /></Field></Section>
      <Section title="Отверстия и вырезы"><textarea className="min-h-28 w-full rounded-xl border border-slate-200 p-3 text-sm" value={form.openings} onChange={(e)=>change("openings",e.target.value)} placeholder="Для каждого элемента: тип, размер, X от левого края, Y от верхнего края" /></Section>
      <Section title="Фотографии"><div className="flex flex-wrap gap-2">{sheet?.photos?.map((photo)=><a key={photo.id} href={photo.url} target="_blank" rel="noreferrer" className="rounded-full bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">{photo.original_name}</a>)}{pendingPhotos.map((photo)=><span key={photo.id} className="inline-flex items-center gap-2 rounded-full bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">{photo.name}<button type="button" onClick={()=>removePendingPhoto(photo.id)}><Trash2 size={13}/></button></span>)}</div><div className="mt-3 flex flex-wrap gap-2"><label className="btn-hover inline-flex cursor-pointer items-center gap-2 rounded-full bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white"><Camera size={16}/>Снять или выбрать фото<input type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={addPhotos}/></label><label className="btn-hover inline-flex cursor-pointer items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold"><Paperclip size={16}/>Добавить файлы<input type="file" multiple className="hidden" onChange={addPhotos}/></label></div></Section>
      <Field label="Общий комментарий"><textarea className="mt-1 min-h-28 w-full rounded-xl border border-slate-200 p-3 text-sm" value={form.notes} onChange={(e)=>change("notes",e.target.value)} /></Field>
      {validationIssues.length ? <div className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900"><div className="font-black">До завершения замера:</div><ul className="mt-1 list-disc pl-5">{validationIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul></div> : null}
      {error ? <div className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800">{error}</div> : null}
      <Button type="button" className="w-full sm:w-auto" disabled={validationIssues.length > 0} onClick={() => { setCompleteRequested(true); syncNow(form, true); }}><CheckCircle2 size={17}/>{sheet?.is_complete || completeRequested ? "Замер завершён" : "Завершить замер"}</Button>
    </div>
  );
}

function Field({ label, children }) { return <label className="block space-y-1.5"><Label>{label}</Label>{children}</label>; }
function Section({ title, children }) { return <section className="space-y-3 rounded-[24px] border border-slate-200 bg-white p-4"><h3 className="font-black text-slate-900">{title}</h3>{children}</section>; }
