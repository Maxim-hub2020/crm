import React, { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Cable,
  CircleDot,
  LampWallUp,
  Minus,
  MousePointer2,
  Mic,
  MicOff,
  Plus,
  Redo2,
  Ruler,
  ScanLine,
  Trash2,
  Undo2,
  Unplug,
  Wrench,
} from "lucide-react";

const CANVAS = { x: 54, y: 42, width: 892, height: 596 };
const VIEW_LABELS = { wall: "Стена", front: "Лицевая сторона", back: "Задняя сторона" };
const ELEMENT_TYPES = {
  socket_single: { label: "Розетка", width: 68, height: 68, diameter: 68, count: 1, spacing: 71 },
  socket_double: { label: "Двойная розетка", width: 139, height: 68, diameter: 68, count: 2, spacing: 71 },
  socket_triple: { label: "Тройная розетка", width: 210, height: 68, diameter: 68, count: 3, spacing: 71 },
  light: { label: "Светильник", width: 80, height: 80, count: 1 },
  power: { label: "Вывод питания", width: 60, height: 60, count: 1 },
  mounting: { label: "Крепёж", width: 300, height: 45, count: 1 },
  cut_circle: { label: "Круглый вырез", width: 68, height: 68, diameter: 68, count: 1 },
  cut_rect: { label: "Прямоугольный вырез", width: 100, height: 70, count: 1 },
};

const TOOLS = [
  { id: "select", label: "Выбор", icon: MousePointer2 },
  { id: "line", label: "Линия с размером", icon: Minus },
  { id: "socket_single", label: "Розетка", icon: Unplug },
  { id: "socket_double", label: "2 розетки", icon: Unplug },
  { id: "socket_triple", label: "3 розетки", icon: Unplug },
  { id: "light", label: "Светильник", icon: LampWallUp },
  { id: "power", label: "Питание", icon: Cable },
  { id: "mounting", label: "Крепёж", icon: Wrench },
  { id: "cut_circle", label: "Круглый вырез", icon: CircleDot },
  { id: "cut_rect", label: "Прямоугольный вырез", icon: ScanLine },
];

export function createDefaultDiagram() {
  return {
    version: 2,
    active_view: "wall",
    wall: { width: 2000, height: 2600, points: [] },
    product: { width: 1000, height: 1800, x: 500, y: 400, shape: "rectangle" },
    elements: [],
    specifications: { wall: [], front: [], back: [] },
  };
}

function normalizeDiagram(value) {
  const fallback = createDefaultDiagram();
  return {
    ...fallback,
    ...(value || {}),
    version: 2,
    wall: { ...fallback.wall, ...(value?.wall || {}) },
    product: { ...fallback.product, ...(value?.product || {}) },
    elements: Array.isArray(value?.elements) ? value.elements.map((element) => {
      const referenceDefaults = {
        horizontal_reference: element.horizontal_reference || "left",
        vertical_reference: element.vertical_reference || "bottom",
        horizontal_distance: numberValue(element.horizontal_distance, numberValue(element.x)),
        vertical_distance: numberValue(element.vertical_distance, numberValue(element.y)),
      };
      if (element.type === "hole") {
        const diameter = numberValue(element.diameter, numberValue(element.width, 60));
        return { ...element, ...referenceDefaults, type: "cut_circle", diameter, width: diameter, height: diameter };
      }
      if (element.type?.startsWith("socket")) {
        const count = Math.max(numberValue(element.count, 1), 1);
        const diameter = numberValue(element.diameter, numberValue(element.height, 68));
        return { ...element, ...referenceDefaults, diameter, spacing: numberValue(element.spacing, 71), width: diameter + (count - 1) * numberValue(element.spacing, 71), height: diameter };
      }
      return element.type === "cut_circle" || element.type === "cut_rect" ? { ...element, ...referenceDefaults } : element;
    }) : [],
    specifications: { ...fallback.specifications, ...(value?.specifications || {}) },
  };
}

function numberValue(value, fallback = 0) {
  const prepared = String(value ?? "").replace(",", ".").trim();
  if (!prepared) return fallback;
  const parsed = Number(prepared);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function snap(value) {
  return Math.round(value / 5) * 5;
}

function optionalPositiveNumber(value) {
  return String(value ?? "").trim() === "" ? "" : Math.max(numberValue(value), 0);
}

export default function MeasurementCanvas({ value, onChange }) {
  const diagram = normalizeDiagram(value);
  const [view, setView] = useState(diagram.active_view || "wall");
  const [tool, setTool] = useState("select");
  const [selectedId, setSelectedId] = useState(null);
  const [history, setHistory] = useState([]);
  const [future, setFuture] = useState([]);
  const [draftLine, setDraftLine] = useState(null);
  const [snapTarget, setSnapTarget] = useState(null);
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const drawRef = useRef(null);
  const dimensionInputRef = useRef(null);

  const wallWidth = Math.max(numberValue(diagram.wall.width, 2000), 100);
  const wallHeight = Math.max(numberValue(diagram.wall.height, 2600), 100);
  const selected = diagram.elements.find((element) => element.id === selectedId) || null;

  useEffect(() => {
    if (selected?.type !== "dimension") return;
    const frame = requestAnimationFrame(() => {
      dimensionInputRef.current?.focus();
      dimensionInputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedId, selected?.type]);

  function commit(nextDiagram, remember = true) {
    if (remember) {
      setHistory((items) => [...items.slice(-29), diagram]);
      setFuture([]);
    }
    onChange({ ...nextDiagram, active_view: view });
  }

  function updateDiagram(patch, remember = true) {
    commit({ ...diagram, ...patch }, remember);
  }

  function updateProduct(key, nextValue) {
    updateDiagram({ product: { ...diagram.product, [key]: Math.max(numberValue(nextValue, 0), 0) } });
  }

  function updateElement(id, patch, remember = true) {
    updateDiagram({ elements: diagram.elements.map((element) => element.id === id ? { ...element, ...patch } : element) }, remember);
  }

  function toSvg(point) {
    return {
      x: CANVAS.x + (point.x / wallWidth) * CANVAS.width,
      y: CANVAS.y + CANVAS.height - (point.y / wallHeight) * CANVAS.height,
    };
  }

  function fromPointer(event) {
    const rect = svgRef.current.getBoundingClientRect();
    const svgX = ((event.clientX - rect.left) / rect.width) * 1000;
    const svgY = ((event.clientY - rect.top) / rect.height) * 700;
    return {
      x: snap(clamp(((svgX - CANVAS.x) / CANVAS.width) * wallWidth, 0, wallWidth)),
      y: snap(clamp(((CANVAS.y + CANVAS.height - svgY) / CANVAS.height) * wallHeight, 0, wallHeight)),
    };
  }

  function snapToLineEndpoint(point, excludeId = null) {
    let nearest = null;
    let nearestDistance = 18;
    const svgPoint = toSvg(point);
    diagram.elements.forEach((element) => {
      if (element.type !== "dimension" || element.side !== view || element.id === excludeId) return;
      [{ x: element.x1, y: element.y1 }, { x: element.x2, y: element.y2 }].forEach((candidate) => {
        const svgCandidate = toSvg(candidate);
        const distance = Math.hypot(svgCandidate.x - svgPoint.x, svgCandidate.y - svgPoint.y);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = { x: numberValue(candidate.x), y: numberValue(candidate.y) };
        }
      });
    });
    return nearest || point;
  }

  function changeView(nextView) {
    setView(nextView);
    setSelectedId(null);
    onChange({ ...diagram, active_view: nextView });
    if (nextView === "back" && tool.startsWith("socket")) setTool("select");
  }

  function handleCanvasPointerDown(event) {
    if (event.target !== event.currentTarget && event.target.dataset.canvas !== "surface") return;
    const rawPoint = fromPointer(event);
    if (tool === "line") {
      const point = snapToLineEndpoint(rawPoint);
      event.currentTarget.setPointerCapture?.(event.pointerId);
      drawRef.current = { start: point, snapshot: diagram };
      setDraftLine({ start: point, end: point });
      setSnapTarget(point.x !== rawPoint.x || point.y !== rawPoint.y ? point : null);
      return;
    }
    if (tool === "select") {
      setSelectedId(null);
      return;
    }
    const template = ELEMENT_TYPES[tool];
    if (!template) return;
    const point = rawPoint;
    const element = {
      id: globalThis.crypto?.randomUUID?.() || `element-${Date.now()}`,
      type: tool,
      side: view,
      label: template.label,
      x: point.x,
      y: point.y,
      width: template.width,
      height: template.height,
      diameter: template.diameter,
      count: template.count,
      spacing: template.spacing || 72,
      mounting_type: tool === "mounting" ? "Монтажная планка" : "",
      note: "",
      ...(tool === "cut_circle" || tool === "cut_rect" || tool.startsWith("socket") ? {
        horizontal_reference: "left",
        vertical_reference: "bottom",
        horizontal_distance: point.x,
        vertical_distance: point.y,
      } : {}),
    };
    commit({ ...diagram, elements: [...diagram.elements, element], active_view: view });
    setSelectedId(element.id);
    setTool("select");
  }

  function startDrag(event, element) {
    event.stopPropagation();
    setSelectedId(element.id);
    if (tool !== "select") return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = element.type === "dimension"
      ? { id: element.id, kind: "dimension", start: fromPointer(event), x1: element.x1, y1: element.y1, x2: element.x2, y2: element.y2, snapshot: diagram }
      : { id: element.id, kind: "element", start: fromPointer(event), x: element.x, y: element.y, snapshot: diagram };
  }

  function startEndpointDrag(event, element, endpoint) {
    event.stopPropagation();
    if (tool !== "select") return;
    setSelectedId(element.id);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { id: element.id, kind: "dimension-end", endpoint, snapshot: diagram };
  }

  function handlePointerMove(event) {
    if (drawRef.current) {
      const rawPoint = fromPointer(event);
      const point = snapToLineEndpoint(rawPoint);
      setDraftLine({ start: drawRef.current.start, end: point });
      setSnapTarget(point.x !== rawPoint.x || point.y !== rawPoint.y ? point : null);
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    const point = fromPointer(event);
    if (drag.kind === "dimension-end") {
      const snappedPoint = snapToLineEndpoint(point, drag.id);
      setSnapTarget(snappedPoint.x !== point.x || snappedPoint.y !== point.y ? snappedPoint : null);
      updateElement(drag.id, drag.endpoint === "start"
        ? { x1: snappedPoint.x, y1: snappedPoint.y }
        : { x2: snappedPoint.x, y2: snappedPoint.y }, false);
      return;
    }
    if (drag.kind === "dimension") {
      let dx = point.x - drag.start.x;
      let dy = point.y - drag.start.y;
      const movedStart = { x: drag.x1 + dx, y: drag.y1 + dy };
      const movedEnd = { x: drag.x2 + dx, y: drag.y2 + dy };
      const snappedStart = snapToLineEndpoint(movedStart, drag.id);
      const snappedEnd = snapToLineEndpoint(movedEnd, drag.id);
      if (snappedStart.x !== movedStart.x || snappedStart.y !== movedStart.y) {
        dx += snappedStart.x - movedStart.x;
        dy += snappedStart.y - movedStart.y;
        setSnapTarget(snappedStart);
      } else if (snappedEnd.x !== movedEnd.x || snappedEnd.y !== movedEnd.y) {
        dx += snappedEnd.x - movedEnd.x;
        dy += snappedEnd.y - movedEnd.y;
        setSnapTarget(snappedEnd);
      } else {
        setSnapTarget(null);
      }
      updateElement(drag.id, {
        x1: snap(clamp(drag.x1 + dx, 0, wallWidth)),
        y1: snap(clamp(drag.y1 + dy, 0, wallHeight)),
        x2: snap(clamp(drag.x2 + dx, 0, wallWidth)),
        y2: snap(clamp(drag.y2 + dy, 0, wallHeight)),
      }, false);
      return;
    }
    const movingElement = diagram.elements.find((element) => element.id === drag.id);
    const width = numberValue(movingElement?.width, 0);
    const height = numberValue(movingElement?.height, 0);
    const x = snap(clamp(drag.x + point.x - drag.start.x, 0, Math.max(wallWidth - width / 2, 0)));
    const y = snap(clamp(drag.y + point.y - drag.start.y, 0, Math.max(wallHeight - height / 2, 0)));
    updateElement(drag.id, { x, y }, false);
  }

  function endPointer(event) {
    if (drawRef.current) {
      if (event.type === "pointercancel") {
        drawRef.current = null;
        setDraftLine(null);
        setSnapTarget(null);
        return;
      }
      const start = drawRef.current.start;
      const end = snapToLineEndpoint(fromPointer(event));
      const measured = Math.round(Math.hypot(end.x - start.x, end.y - start.y));
      const snapshot = drawRef.current.snapshot;
      drawRef.current = null;
      setDraftLine(null);
      setSnapTarget(null);
      if (measured >= 5) {
        const element = {
          id: globalThis.crypto?.randomUUID?.() || `dimension-${Date.now()}`,
          type: "dimension",
          side: view,
          label: "Размер",
          x1: start.x,
          y1: start.y,
          x2: end.x,
          y2: end.y,
          value: "",
          note: "",
        };
        setHistory((items) => [...items.slice(-29), snapshot]);
        setFuture([]);
        onChange({ ...diagram, elements: [...diagram.elements, element], active_view: view });
        setSelectedId(element.id);
      }
      return;
    }
    if (!dragRef.current) return;
    setHistory((items) => [...items.slice(-29), dragRef.current.snapshot]);
    setFuture([]);
    dragRef.current = null;
    setSnapTarget(null);
  }

  function undo() {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory((items) => items.slice(0, -1));
    setFuture((items) => [diagram, ...items].slice(0, 30));
    onChange(previous);
  }

  function redo() {
    const next = future[0];
    if (!next) return;
    setFuture((items) => items.slice(1));
    setHistory((items) => [...items, diagram].slice(-30));
    onChange(next);
  }

  function removeSelected() {
    if (!selected) return;
    updateDiagram({ elements: diagram.elements.filter((element) => element.id !== selected.id) });
    setSelectedId(null);
  }

  const wallPoints = (diagram.wall.points || []).map(toSvg);
  const wallPolygon = wallPoints.length >= 2 ? wallPoints.map((point) => `${point.x},${point.y}`).join(" ") : "";
  const visibleElements = diagram.elements.filter((element) => element.side === view);
  const productTopLeft = toSvg({ x: diagram.product.x, y: diagram.product.y + diagram.product.height });
  const productWidth = (diagram.product.width / wallWidth) * CANVAS.width;
  const productHeight = (diagram.product.height / wallHeight) * CANVAS.height;

  return (
    <section className="overflow-hidden rounded-[26px] border border-slate-200 bg-slate-950 text-white shadow-xl">
      <div className="border-b border-white/10 bg-slate-900 px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-black"><Ruler size={18} className="text-sky-400" />Интерактивный замер</div>
            <p className="mt-1 text-xs text-slate-400">Все координаты сохраняются в миллиметрах</p>
          </div>
          <div className="flex items-center gap-1">
            <IconButton label="Отменить" disabled={!history.length} onClick={undo}><Undo2 size={17} /></IconButton>
            <IconButton label="Повторить" disabled={!future.length} onClick={redo}><Redo2 size={17} /></IconButton>
            <IconButton label="Удалить выбранное" disabled={!selected} onClick={removeSelected} danger><Trash2 size={17} /></IconButton>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-1 rounded-2xl bg-slate-800 p-1">
          {Object.entries(VIEW_LABELS).map(([id, label]) => <button key={id} type="button" onClick={() => changeView(id)} className={`rounded-xl px-2 py-2 text-xs font-bold transition ${view === id ? "bg-white text-slate-950" : "text-slate-400 hover:text-white"}`}>{label}</button>)}
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto border-b border-white/10 bg-slate-900/80 px-3 py-3 [scrollbar-width:none] sm:flex-wrap sm:px-5">
        {TOOLS.filter((item) => view !== "back" || !item.id.startsWith("socket")).map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" onClick={() => { setTool(id); setSelectedId(null); setDraftLine(null); drawRef.current = null; }} className={`flex shrink-0 items-center gap-2 rounded-full border px-3 py-2 text-xs font-bold transition ${tool === id ? "border-sky-400 bg-sky-400 text-slate-950" : "border-white/10 bg-white/5 text-slate-300"}`}><Icon size={15} />{label}</button>
        ))}
      </div>

      {tool === "line" ? <div className="bg-sky-400/10 px-4 py-3 text-xs text-sky-100"><span className="font-bold">Проведите линию пальцем или мышью.</span> Конец примагнитится к ближайшему концу другой линии.</div> : null}
      {tool === "cut_circle" || tool.startsWith("socket") ? <div className="bg-sky-400/10 px-4 py-3 text-xs text-sky-100">Коснитесь центра выреза. После добавления укажите точный диаметр и координаты.</div> : null}

      <div className="bg-[#dce8ea] p-2 sm:p-4">
        <svg ref={svgRef} viewBox="0 0 1000 700" role="img" aria-label={`Схема: ${VIEW_LABELS[view]}`} className="block aspect-[10/7] w-full touch-none rounded-2xl bg-[#f7f4eb] shadow-inner" onPointerDown={handleCanvasPointerDown} onPointerMove={handlePointerMove} onPointerUp={endPointer} onPointerCancel={endPointer}>
          <defs>
            <pattern id="minor-grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M 20 0 L 0 0 0 20" fill="none" stroke="#cbd5d1" strokeWidth="1" /></pattern>
            <pattern id="major-grid" width="100" height="100" patternUnits="userSpaceOnUse"><rect width="100" height="100" fill="url(#minor-grid)" /><path d="M 100 0 L 0 0 0 100" fill="none" stroke="#9fb3b4" strokeWidth="1.5" /></pattern>
            <marker id="measurement-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#0ea5e9" /></marker>
          </defs>
          <rect data-canvas="surface" width="1000" height="700" fill="url(#major-grid)" />
          <rect data-canvas="surface" x={CANVAS.x} y={CANVAS.y} width={CANVAS.width} height={CANVAS.height} rx="8" fill="#fffdf6" fillOpacity="0.72" stroke="#82989a" strokeWidth="3" strokeDasharray={wallPolygon ? "8 8" : "0"} />
          {wallPolygon ? <polygon points={wallPolygon} fill="#e0eef0" fillOpacity="0.62" stroke="#0f172a" strokeWidth="5" strokeLinejoin="round" pointerEvents="none" /> : null}
          {wallPoints.map((point, index) => <circle key={`${point.x}-${point.y}-${index}`} cx={point.x} cy={point.y} r="8" fill="#38bdf8" stroke="#0f172a" strokeWidth="3" pointerEvents="none" />)}

          {view !== "wall" ? <ProductShape product={diagram.product} x={productTopLeft.x} y={productTopLeft.y} width={productWidth} height={productHeight} /> : null}
          {visibleElements.map((element) => element.type === "dimension"
            ? <MeasurementLine key={element.id} element={element} selected={element.id === selectedId} toSvg={toSvg} onPointerDown={(event) => startDrag(event, element)} onEndpointPointerDown={(event, endpoint) => startEndpointDrag(event, element, endpoint)} />
            : <DiagramElement key={element.id} element={element} selected={element.id === selectedId} toSvg={toSvg} wallWidth={wallWidth} wallHeight={wallHeight} onPointerDown={(event) => startDrag(event, element)} />)}
          {draftLine ? <MeasurementLine element={{ type: "dimension", x1: draftLine.start.x, y1: draftLine.start.y, x2: draftLine.end.x, y2: draftLine.end.y, value: Math.round(Math.hypot(draftLine.end.x - draftLine.start.x, draftLine.end.y - draftLine.start.y)) }} selected toSvg={toSvg} draft /> : null}
          {snapTarget ? (() => { const point = toSvg(snapTarget); return <g pointerEvents="none"><circle cx={point.x} cy={point.y} r="14" fill="#22c55e" fillOpacity="0.2" stroke="#16a34a" strokeWidth="3" /><circle cx={point.x} cy={point.y} r="4" fill="#16a34a" /></g>; })() : null}

        </svg>
      </div>

      {selected?.type === "dimension" ? <div className="border-t border-sky-400/20 bg-sky-400/10 px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex-1 space-y-1"><span className="block text-xs font-black uppercase tracking-widest text-sky-200">Точный размер линии, мм</span><input ref={dimensionInputRef} type="number" inputMode="decimal" value={selected.value ?? ""} placeholder="Введите фактический размер" onChange={(event) => updateElement(selected.id, { value: optionalPositiveNumber(event.target.value) })} className="w-full rounded-2xl border-2 border-sky-400 bg-slate-950 px-4 py-3 text-xl font-black text-white outline-none placeholder:text-slate-600" /></label>
          <button type="button" onClick={() => { setSelectedId(null); setTool("line"); }} className="rounded-2xl bg-sky-400 px-5 py-3 text-sm font-black text-slate-950">Готово, рисовать дальше</button>
        </div>
      </div> : null}

      <VoiceSpecification
        view={view}
        items={diagram.specifications?.[view] || []}
        onChange={(items) => updateDiagram({ specifications: { ...diagram.specifications, [view]: items } })}
      />

      <div className="grid gap-4 border-t border-white/10 bg-slate-900 p-4 sm:grid-cols-2 sm:p-5">
        {view !== "wall" ? <EditorGroup title="Изделие">
          <NumberField label="Ширина изделия" value={diagram.product.width} onChange={(value) => updateProduct("width", value)} />
          <NumberField label="Высота изделия" value={diagram.product.height} onChange={(value) => updateProduct("height", value)} />
          <NumberField label="От левого края" value={diagram.product.x} onChange={(value) => updateProduct("x", value)} />
          <NumberField label="От пола" value={diagram.product.y} onChange={(value) => updateProduct("y", value)} />
        </EditorGroup> : null}
        <EditorGroup title={selected ? "Выбранный элемент" : "Как работать"}>
          {selected?.type === "dimension" ? <>
            <NumberField label="Размер линии" value={selected.value} onChange={(value) => updateElement(selected.id, { value: optionalPositiveNumber(value) })} />
            <NumberField label="Начало X" value={selected.x1} onChange={(value) => updateElement(selected.id, { x1: numberValue(value) })} />
            <NumberField label="Начало Y" value={selected.y1} onChange={(value) => updateElement(selected.id, { y1: numberValue(value) })} />
            <NumberField label="Конец X" value={selected.x2} onChange={(value) => updateElement(selected.id, { x2: numberValue(value) })} />
            <NumberField label="Конец Y" value={selected.y2} onChange={(value) => updateElement(selected.id, { y2: numberValue(value) })} />
            <TextField label="Комментарий к размеру" value={selected.note} onChange={(value) => updateElement(selected.id, { note: value })} />
          </> : selected ? <>
            <TextField label="Название" value={selected.label} onChange={(value) => updateElement(selected.id, { label: value })} />
            <NumberField label="X от левого края" value={selected.x} onChange={(value) => updateElement(selected.id, { x: numberValue(value) })} />
            <NumberField label="Y от пола" value={selected.y} onChange={(value) => updateElement(selected.id, { y: numberValue(value) })} />
            {selected.type === "cut_circle" || selected.type.startsWith("socket") ? <NumberField label={selected.type.startsWith("socket") ? "Диаметр каждого выреза" : "Диаметр выреза"} value={selected.diameter} onChange={(value) => { const diameter = Math.max(numberValue(value), 0); const count = Math.max(numberValue(selected.count, 1), 1); updateElement(selected.id, { diameter, width: diameter + (count - 1) * numberValue(selected.spacing, 71), height: diameter }); }} /> : <NumberField label="Ширина" value={selected.width} onChange={(value) => updateElement(selected.id, { width: numberValue(value) })} />}
            {selected.type !== "cut_circle" && !selected.type.startsWith("socket") ? <NumberField label="Высота" value={selected.height} onChange={(value) => updateElement(selected.id, { height: numberValue(value) })} /> : null}
            {selected.type.startsWith("socket") ? <><NumberField label="Количество вырезов" value={selected.count} onChange={(value) => { const count = Math.max(Math.round(numberValue(value, 1)), 1); updateElement(selected.id, { count, width: numberValue(selected.diameter, 68) + (count - 1) * numberValue(selected.spacing, 71) }); }} /><NumberField label="Шаг между центрами" value={selected.spacing} onChange={(value) => { const spacing = Math.max(numberValue(value), 0); updateElement(selected.id, { spacing, width: numberValue(selected.diameter, 68) + (Math.max(numberValue(selected.count, 1), 1) - 1) * spacing }); }} /></> : null}
            {selected.type === "cut_circle" || selected.type === "cut_rect" || selected.type.startsWith("socket") ? <>
              <ReferenceSideField label="Горизонтальный размер" value={selected.horizontal_reference || "left"} options={[{ value: "left", label: "От левой стены" }, { value: "right", label: "От правой стены" }]} onChange={(value) => updateElement(selected.id, { horizontal_reference: value })} />
              <NumberField label={selected.horizontal_reference === "right" ? "Размер справа" : "Размер слева"} value={selected.horizontal_distance} onChange={(value) => updateElement(selected.id, { horizontal_distance: optionalPositiveNumber(value) })} />
              <ReferenceSideField label="Вертикальный размер" value={selected.vertical_reference || "bottom"} options={[{ value: "bottom", label: "От пола" }, { value: "top", label: "От потолка" }]} onChange={(value) => updateElement(selected.id, { vertical_reference: value })} />
              <NumberField label={selected.vertical_reference === "top" ? "Размер от потолка" : "Размер от пола"} value={selected.vertical_distance} onChange={(value) => updateElement(selected.id, { vertical_distance: optionalPositiveNumber(value) })} />
            </> : null}
            {selected.type === "light" ? <><NumberField label="Количество светильников" value={selected.count} onChange={(value) => updateElement(selected.id, { count: Math.max(numberValue(value, 1), 1) })} /><NumberField label="Шаг между центрами" value={selected.spacing} onChange={(value) => updateElement(selected.id, { spacing: numberValue(value) })} /></> : null}
            {selected.type === "mounting" ? <TextField label="Тип крепежа" value={selected.mounting_type} onChange={(value) => updateElement(selected.id, { mounting_type: value })} /> : null}
            <TextField label="Комментарий" value={selected.note} onChange={(value) => updateElement(selected.id, { note: value })} />
          </> : <div className="col-span-2 space-y-2 text-sm leading-relaxed text-slate-400"><p>1. Проведите линию: её конец примагнитится к другой линии.</p><p>2. Тяните линию за середину, а её концы — за круглые точки.</p><p>3. Для розеток и вырезов выберите стороны отсчёта размеров.</p><p>4. Любой объект можно перетащить пальцем или мышью.</p></div>}
        </EditorGroup>
      </div>
    </section>
  );
}

function DiagramElement({ element, selected, toSvg, wallWidth, wallHeight, onPointerDown }) {
  const center = toSvg(element);
  const width = Math.max((numberValue(element.width, 60) / wallWidth) * CANVAS.width, 24);
  const height = Math.max((numberValue(element.height, 60) / wallHeight) * CANVAS.height, 24);
  const stroke = selected ? "#0284c7" : "#0f172a";
  const count = Math.max(numberValue(element.count, 1), 1);
  const spacing = Math.max((numberValue(element.spacing, 72) / wallWidth) * CANVAS.width, 22);
  const groupWidth = element.type === "light" ? spacing * (count - 1) : 0;
  const showsReferences = element.type === "cut_circle" || element.type === "cut_rect" || element.type.startsWith("socket");
  return <g onPointerDown={onPointerDown} className="cursor-grab active:cursor-grabbing">
    {showsReferences ? <CutoutReferenceDimensions element={element} center={center} /> : null}
    {selected ? <rect x={center.x - width / 2 - 8 - groupWidth / 2} y={center.y - height / 2 - 8} width={width + 16 + groupWidth} height={height + 16} rx="12" fill="none" stroke="#38bdf8" strokeWidth="3" strokeDasharray="8 6" /> : null}
    {element.type.startsWith("socket") ? <CutoutGroup center={center} diameter={Math.max((numberValue(element.diameter, 68) / wallWidth) * CANVAS.width, 18)} count={element.count} spacing={spacing} stroke={stroke} /> : null}
    {element.type === "light" ? Array.from({ length: count }, (_, index) => <LightSymbol key={index} x={center.x - groupWidth / 2 + index * spacing} y={center.y} radius={Math.max(width / 2, 15)} stroke={stroke} />) : null}
    {element.type === "power" ? <PowerSymbol center={center} size={Math.max(width, height)} stroke={stroke} /> : null}
    {element.type === "mounting" ? <MountSymbol center={center} width={width} height={height} stroke={stroke} /> : null}
    {element.type === "cut_circle" ? <g><circle cx={center.x} cy={center.y} r={Math.max(width / 2, 12)} fill="#fffdf6" stroke={stroke} strokeWidth="5" /><text x={center.x} y={center.y + 5} textAnchor="middle" fontSize="13" fontWeight="900" fill={stroke}>Ø{Math.round(numberValue(element.diameter, element.width))}</text></g> : null}
    {element.type === "cut_rect" ? <g><rect x={center.x - width / 2} y={center.y - height / 2} width={width} height={height} rx="4" fill="#fffdf6" stroke={stroke} strokeWidth="5" /><line x1={center.x - width / 2} y1={center.y - height / 2} x2={center.x + width / 2} y2={center.y + height / 2} stroke={stroke} strokeWidth="2" /><line x1={center.x + width / 2} y1={center.y - height / 2} x2={center.x - width / 2} y2={center.y + height / 2} stroke={stroke} strokeWidth="2" /></g> : null}
    <text x={center.x} y={center.y + height / 2 + 22} textAnchor="middle" fontSize="15" fontWeight="800" fill="#334155">{element.label}</text>
    {selected ? <><text x={center.x} y={center.y - height / 2 - 17} textAnchor="middle" fontSize="14" fontWeight="800" fill="#0369a1">X {Math.round(element.x)} · Y {Math.round(element.y)}</text></> : null}
  </g>;
}

function CutoutGroup({ center, diameter, count, spacing, stroke }) {
  const safeCount = Math.max(numberValue(count, 1), 1);
  const groupWidth = spacing * (safeCount - 1);
  return <g>{Array.from({ length: safeCount }, (_, index) => {
    const x = center.x - groupWidth / 2 + spacing * index;
    return <g key={index}><circle cx={x} cy={center.y} r={diameter / 2} fill="#fffdf6" stroke={stroke} strokeWidth="4" /><text x={x} y={center.y + 4} textAnchor="middle" fontSize="11" fontWeight="900" fill={stroke}>Ø</text></g>;
  })}</g>;
}

function CutoutReferenceDimensions({ element, center }) {
  const horizontalToRight = element.horizontal_reference === "right";
  const verticalToTop = element.vertical_reference === "top";
  const horizontalEdge = horizontalToRight ? CANVAS.x + CANVAS.width : CANVAS.x;
  const verticalEdge = verticalToTop ? CANVAS.y : CANVAS.y + CANVAS.height;
  const horizontalY = center.y + 34;
  const verticalX = center.x + 34;
  const horizontalLabel = `${Math.round(numberValue(element.horizontal_distance))} мм`;
  const verticalLabel = `${Math.round(numberValue(element.vertical_distance))} мм`;
  return <g pointerEvents="none">
    <line x1={center.x} y1={center.y} x2={center.x} y2={horizontalY} stroke="#0ea5e9" strokeWidth="1.8" strokeDasharray="5 4" />
    <line x1={horizontalEdge} y1={horizontalY} x2={center.x} y2={horizontalY} stroke="#0ea5e9" strokeWidth="2" markerStart="url(#measurement-arrow)" markerEnd="url(#measurement-arrow)" />
    <rect x={(horizontalEdge + center.x) / 2 - 34} y={horizontalY - 13} width="68" height="20" rx="6" fill="#fffdf6" />
    <text x={(horizontalEdge + center.x) / 2} y={horizontalY + 2} textAnchor="middle" fontSize="12" fontWeight="900" fill="#0369a1">{horizontalLabel}</text>
    <line x1={center.x} y1={center.y} x2={verticalX} y2={center.y} stroke="#0ea5e9" strokeWidth="1.8" strokeDasharray="5 4" />
    <line x1={verticalX} y1={verticalEdge} x2={verticalX} y2={center.y} stroke="#0ea5e9" strokeWidth="2" markerStart="url(#measurement-arrow)" markerEnd="url(#measurement-arrow)" />
    <g transform={`rotate(-90 ${verticalX} ${(verticalEdge + center.y) / 2})`}><rect x={verticalX - 34} y={(verticalEdge + center.y) / 2 - 13} width="68" height="20" rx="6" fill="#fffdf6" /><text x={verticalX} y={(verticalEdge + center.y) / 2 + 2} textAnchor="middle" fontSize="12" fontWeight="900" fill="#0369a1">{verticalLabel}</text></g>
  </g>;
}

function MeasurementLine({ element, selected, toSvg, onPointerDown, onEndpointPointerDown, draft = false }) {
  const start = toSvg({ x: numberValue(element.x1), y: numberValue(element.y1) });
  const end = toSvg({ x: numberValue(element.x2), y: numberValue(element.y2) });
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.max(Math.hypot(dx, dy), 1);
  const offsetX = (-dy / length) * 24;
  const offsetY = (dx / length) * 24;
  const dimensionStart = { x: start.x + offsetX, y: start.y + offsetY };
  const dimensionEnd = { x: end.x + offsetX, y: end.y + offsetY };
  const tickX = (-dy / length) * 7;
  const tickY = (dx / length) * 7;
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  const readableAngle = angle > 90 || angle < -90 ? angle + 180 : angle;
  const labelX = (dimensionStart.x + dimensionEnd.x) / 2;
  const labelY = (dimensionStart.y + dimensionEnd.y) / 2 - 8;
  const color = selected ? "#0284c7" : "#0f172a";
  const dimensionValue = numberValue(element.value);
  const dimensionLabel = dimensionValue > 0 ? `${Math.round(dimensionValue)} мм` : "Введите размер";
  const labelWidth = dimensionValue > 0 ? 84 : 116;
  return <g onPointerDown={onPointerDown} className={draft ? undefined : "cursor-grab active:cursor-grabbing"}>
    <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke={color} strokeWidth={selected ? 6 : 4} strokeLinecap="round" />
    <line x1={start.x} y1={start.y} x2={dimensionStart.x} y2={dimensionStart.y} stroke="#64748b" strokeWidth="2" />
    <line x1={end.x} y1={end.y} x2={dimensionEnd.x} y2={dimensionEnd.y} stroke="#64748b" strokeWidth="2" />
    <line x1={dimensionStart.x} y1={dimensionStart.y} x2={dimensionEnd.x} y2={dimensionEnd.y} stroke={selected ? "#0ea5e9" : "#475569"} strokeWidth="2.5" />
    <line x1={dimensionStart.x - tickX} y1={dimensionStart.y - tickY} x2={dimensionStart.x + tickX} y2={dimensionStart.y + tickY} stroke="#475569" strokeWidth="2.5" />
    <line x1={dimensionEnd.x - tickX} y1={dimensionEnd.y - tickY} x2={dimensionEnd.x + tickX} y2={dimensionEnd.y + tickY} stroke="#475569" strokeWidth="2.5" />
    <g transform={`rotate(${readableAngle} ${labelX} ${labelY})`}>
      <rect x={labelX - labelWidth / 2} y={labelY - 15} width={labelWidth} height="22" rx="7" fill="#fffdf6" stroke={selected ? "#38bdf8" : "#94a3b8"} />
      <text x={labelX} y={labelY + 1} textAnchor="middle" fontSize="14" fontWeight="900" fill={color}>{dimensionLabel}</text>
    </g>
    {selected && !draft ? <>
      <circle cx={start.x} cy={start.y} r="13" fill="#fffdf6" stroke="#0ea5e9" strokeWidth="4" className="cursor-crosshair" onPointerDown={(event) => onEndpointPointerDown?.(event, "start")} />
      <circle cx={end.x} cy={end.y} r="13" fill="#fffdf6" stroke="#0ea5e9" strokeWidth="4" className="cursor-crosshair" onPointerDown={(event) => onEndpointPointerDown?.(event, "end")} />
    </> : null}
  </g>;
}

function LightSymbol({ x, y, radius, stroke }) {
  return <g><circle cx={x} cy={y} r={radius * 0.65} fill="#fef3c7" stroke={stroke} strokeWidth="4" />{Array.from({ length: 8 }, (_, index) => { const angle = (Math.PI * 2 * index) / 8; return <line key={index} x1={x + Math.cos(angle) * radius * 0.82} y1={y + Math.sin(angle) * radius * 0.82} x2={x + Math.cos(angle) * radius * 1.16} y2={y + Math.sin(angle) * radius * 1.16} stroke={stroke} strokeWidth="3" />; })}</g>;
}

function PowerSymbol({ center, size, stroke }) {
  const radius = Math.max(size / 2, 15);
  return <g><circle cx={center.x} cy={center.y} r={radius} fill="#e0f2fe" stroke={stroke} strokeWidth="4" /><path d={`M ${center.x - radius * 0.42} ${center.y + radius * 0.18} L ${center.x - radius * 0.05} ${center.y - radius * 0.45} L ${center.x + radius * 0.02} ${center.y - radius * 0.08} L ${center.x + radius * 0.42} ${center.y - radius * 0.18} L ${center.x + radius * 0.02} ${center.y + radius * 0.48} L ${center.x - radius * 0.04} ${center.y + radius * 0.1} Z`} fill={stroke} /></g>;
}

function MountSymbol({ center, width, height, stroke }) {
  return <g><rect x={center.x - width / 2} y={center.y - height / 2} width={width} height={height} rx="5" fill="#dbe4e6" stroke={stroke} strokeWidth="4" /><circle cx={center.x - width * 0.35} cy={center.y} r="5" fill="#fffdf6" stroke={stroke} strokeWidth="3" /><circle cx={center.x + width * 0.35} cy={center.y} r="5" fill="#fffdf6" stroke={stroke} strokeWidth="3" /><path d={`M ${center.x - width * 0.16} ${center.y + height * 0.18} L ${center.x} ${center.y - height * 0.2} L ${center.x + width * 0.16} ${center.y + height * 0.18}`} fill="none" stroke={stroke} strokeWidth="4" /></g>;
}

function ProductShape({ product, x, y, width, height }) {
  if (product.shape === "round" || product.shape === "oval") return <ellipse cx={x + width / 2} cy={y + height / 2} rx={width / 2} ry={height / 2} fill="#d6f0f4" fillOpacity="0.78" stroke="#0f172a" strokeWidth="5" pointerEvents="none" />;
  if (product.shape === "arch") return <path d={`M ${x} ${y + height} L ${x} ${y + width / 2} A ${width / 2} ${width / 2} 0 0 1 ${x + width} ${y + width / 2} L ${x + width} ${y + height} Z`} fill="#d6f0f4" fillOpacity="0.78" stroke="#0f172a" strokeWidth="5" pointerEvents="none" />;
  return <rect x={x} y={y} width={width} height={height} rx={product.shape === "custom" ? 28 : 4} fill="#d6f0f4" fillOpacity="0.78" stroke="#0f172a" strokeWidth="5" pointerEvents="none" />;
}

function EditorGroup({ title, children }) {
  return <div className="grid grid-cols-2 gap-3 rounded-2xl border border-white/10 bg-white/5 p-3"><h4 className="col-span-2 text-xs font-black uppercase tracking-widest text-slate-400">{title}</h4>{children}</div>;
}

function NumberField({ label, value, onChange }) {
  return <label className="space-y-1"><span className="block text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}, мм</span><input type="number" inputMode="decimal" value={value ?? ""} onChange={(event) => onChange(event.target.value)} className="w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm font-bold text-white outline-none focus:border-sky-400" /></label>;
}

function TextField({ label, value, onChange }) {
  return <label className="col-span-2 space-y-1"><span className="block text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</span><input value={value ?? ""} onChange={(event) => onChange(event.target.value)} className="w-full rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm font-bold text-white outline-none focus:border-sky-400" /></label>;
}

function ReferenceSideField({ label, value, options, onChange }) {
  return <div className="col-span-2 space-y-1"><span className="block text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</span><div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-950 p-1">{options.map((option) => <button key={option.value} type="button" onClick={() => onChange(option.value)} className={`rounded-lg px-2 py-2 text-xs font-bold transition ${value === option.value ? "bg-sky-400 text-slate-950" : "text-slate-400 hover:text-white"}`}>{option.label}</button>)}</div></div>;
}

function IconButton({ label, children, danger = false, ...props }) {
  return <button type="button" title={label} aria-label={label} className={`rounded-full p-2 transition disabled:opacity-30 ${danger ? "bg-red-500/10 text-red-300 hover:bg-red-500/20" : "bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white"}`} {...props}>{children}</button>;
}

function packageTranscript(value) {
  const prepared = String(value || "")
    .replace(/\s+(?:следующий пункт|новый пункт|дальше|далее)\s*[:,.-]?\s*/gi, "\n")
    .replace(/(?:^|\s)(?:первый|первое|второй|второе|третий|третье|четв[её]ртый|четв[её]ртое|пятый|пятое)\s+пункт\s*[:,.-]?\s*/gi, "\n")
    .replace(/\s+-\s+/g, "\n");
  return prepared
    .split(/\n|[.!?;]+/)
    .map((part) => part.replace(/^\s*[,.:;-]+|\s+/g, " ").trim())
    .filter(Boolean)
    .map((text) => ({ id: globalThis.crypto?.randomUUID?.() || `note-${Date.now()}-${Math.random()}`, text: text.charAt(0).toUpperCase() + text.slice(1) }));
}

function VoiceSpecification({ view, items, onChange }) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [manualText, setManualText] = useState("");
  const [error, setError] = useState("");
  const recognitionRef = useRef(null);
  const finalTranscriptRef = useRef("");
  const interimTranscriptRef = useRef("");
  const itemsRef = useRef(items);
  const onChangeRef = useRef(onChange);

  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => () => recognitionRef.current?.abort?.(), []);

  function appendPackaged(text) {
    const packaged = packageTranscript(text);
    if (packaged.length) onChangeRef.current([...itemsRef.current, ...packaged]);
  }

  function startListening() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      setError("В этом браузере голосовой ввод недоступен. Добавьте пункты вручную.");
      return;
    }
    finalTranscriptRef.current = "";
    interimTranscriptRef.current = "";
    setInterim("");
    setError("");
    const recognition = new Recognition();
    recognition.lang = "ru-RU";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let nextInterim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const transcript = event.results[index][0]?.transcript || "";
        if (event.results[index].isFinal) finalTranscriptRef.current += ` ${transcript}`;
        else nextInterim += ` ${transcript}`;
      }
      interimTranscriptRef.current = nextInterim;
      setInterim(`${finalTranscriptRef.current} ${nextInterim}`.trim());
    };
    recognition.onerror = (event) => {
      if (event.error !== "aborted" && event.error !== "no-speech") setError("Не удалось распознать речь. Попробуйте ещё раз или добавьте пункт вручную.");
    };
    recognition.onend = () => {
      appendPackaged(`${finalTranscriptRef.current} ${interimTranscriptRef.current}`.trim());
      recognitionRef.current = null;
      finalTranscriptRef.current = "";
      interimTranscriptRef.current = "";
      setInterim("");
      setListening(false);
    };
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }

  function stopListening() {
    recognitionRef.current?.stop?.();
  }

  function addManual() {
    if (!manualText.trim()) return;
    appendPackaged(manualText);
    setManualText("");
  }

  function updateItem(id, text) {
    onChange(items.map((item) => (typeof item === "string" ? item : item.id) === id ? { ...(typeof item === "string" ? { id, text: item } : item), text } : item));
  }

  function removeItem(id) {
    onChange(items.filter((item) => (typeof item === "string" ? item : item.id) !== id));
  }

  function moveItem(index, direction) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= items.length) return;
    const next = [...items];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    onChange(next);
  }

  return <div className="border-t border-white/10 bg-slate-950 px-4 py-4 sm:px-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h4 className="text-sm font-black">Специфика: {VIEW_LABELS[view]}</h4>
        <p className="mt-1 text-xs text-slate-500">Надиктуйте всё подряд, после остановки речь станет отдельными пунктами.</p>
      </div>
      <button type="button" onClick={listening ? stopListening : startListening} className={`inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-black transition ${listening ? "bg-red-500 text-white" : "bg-sky-400 text-slate-950"}`}>{listening ? <MicOff size={17} /> : <Mic size={17} />}{listening ? "Закончить" : "Надиктовать"}</button>
    </div>
    {listening ? <div className="mt-3 rounded-2xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-100"><span className="mr-2 inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-red-400" />{interim || "Слушаю вас..."}</div> : null}
    {error ? <div className="mt-3 rounded-2xl bg-amber-400/10 px-4 py-3 text-xs text-amber-200">{error}</div> : null}
    <div className="mt-3 flex gap-2">
      <input value={manualText} onChange={(event) => setManualText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addManual(); } }} placeholder="Добавить пункт вручную" className="min-w-0 flex-1 rounded-xl border border-white/10 bg-slate-900 px-3 py-2.5 text-sm text-white outline-none placeholder:text-slate-600 focus:border-sky-400" />
      <button type="button" onClick={addManual} aria-label="Добавить пункт" className="rounded-xl bg-white/10 p-3 text-white transition hover:bg-white/15"><Plus size={18} /></button>
    </div>
    {items.length ? <ol className="mt-4 space-y-2">
      {items.map((rawItem, index) => {
        const item = typeof rawItem === "string" ? { id: rawItem, text: rawItem } : rawItem;
        return <li key={item.id || `${item.text}-${index}`} className="flex items-start gap-2 rounded-2xl border border-white/10 bg-white/5 p-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-400/15 text-xs font-black text-sky-300">{index + 1}</span>
          <textarea value={item.text} onChange={(event) => updateItem(item.id, event.target.value)} rows={1} className="min-h-8 flex-1 resize-y bg-transparent px-1 py-1 text-sm leading-relaxed text-slate-200 outline-none" />
          <div className="flex shrink-0 items-center">
            <IconButton label="Выше" disabled={index === 0} onClick={() => moveItem(index, -1)}><ArrowUp size={14} /></IconButton>
            <IconButton label="Ниже" disabled={index === items.length - 1} onClick={() => moveItem(index, 1)}><ArrowDown size={14} /></IconButton>
            <IconButton label="Удалить пункт" danger onClick={() => removeItem(item.id)}><Trash2 size={14} /></IconButton>
          </div>
        </li>;
      })}
    </ol> : <div className="mt-4 rounded-2xl border border-dashed border-white/10 px-4 py-5 text-center text-xs text-slate-600">Для этого чертежа пока нет пунктов.</div>}
  </div>;
}
