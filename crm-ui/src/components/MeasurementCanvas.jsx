import React, { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Cable,
  Check,
  CircleDot,
  LampWallUp,
  MousePointer2,
  Mic,
  MicOff,
  Plus,
  Redo2,
  Ruler,
  SquareDashedMousePointer,
  Trash2,
  Undo2,
  Unplug,
  Waypoints,
  Wrench,
} from "lucide-react";

const CANVAS = { x: 54, y: 42, width: 892, height: 596 };
const VIEW_LABELS = { wall: "Стена", front: "Лицевая сторона", back: "Задняя сторона" };
const ELEMENT_TYPES = {
  socket_single: { label: "Розетка", width: 72, height: 72, count: 1 },
  socket_double: { label: "Двойная розетка", width: 144, height: 72, count: 2 },
  socket_triple: { label: "Тройная розетка", width: 216, height: 72, count: 3 },
  light: { label: "Светильник", width: 80, height: 80, count: 1 },
  power: { label: "Вывод питания", width: 60, height: 60, count: 1 },
  mounting: { label: "Крепёж", width: 300, height: 45, count: 1 },
  hole: { label: "Отверстие", width: 60, height: 60, count: 1 },
};

const TOOLS = [
  { id: "select", label: "Выбор", icon: MousePointer2 },
  { id: "wall", label: "Контур стены", icon: Waypoints },
  { id: "socket_single", label: "Розетка", icon: Unplug },
  { id: "socket_double", label: "2 розетки", icon: Unplug },
  { id: "socket_triple", label: "3 розетки", icon: Unplug },
  { id: "light", label: "Светильник", icon: LampWallUp },
  { id: "power", label: "Питание", icon: Cable },
  { id: "mounting", label: "Крепёж", icon: Wrench },
  { id: "hole", label: "Отверстие", icon: CircleDot },
];

export function createDefaultDiagram() {
  return {
    version: 1,
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
    wall: { ...fallback.wall, ...(value?.wall || {}) },
    product: { ...fallback.product, ...(value?.product || {}) },
    elements: Array.isArray(value?.elements) ? value.elements : [],
    specifications: { ...fallback.specifications, ...(value?.specifications || {}) },
  };
}

function numberValue(value, fallback = 0) {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function snap(value) {
  return Math.round(value / 5) * 5;
}

export default function MeasurementCanvas({ value, onChange }) {
  const diagram = normalizeDiagram(value);
  const [view, setView] = useState(diagram.active_view || "wall");
  const [tool, setTool] = useState("select");
  const [selectedId, setSelectedId] = useState(null);
  const [history, setHistory] = useState([]);
  const [future, setFuture] = useState([]);
  const [draftPoints, setDraftPoints] = useState([]);
  const svgRef = useRef(null);
  const dragRef = useRef(null);

  const wallWidth = Math.max(numberValue(diagram.wall.width, 2000), 100);
  const wallHeight = Math.max(numberValue(diagram.wall.height, 2600), 100);
  const selected = diagram.elements.find((element) => element.id === selectedId) || null;

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

  function updateWall(key, nextValue) {
    updateDiagram({ wall: { ...diagram.wall, [key]: Math.max(numberValue(nextValue, 0), 0) } });
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

  function changeView(nextView) {
    setView(nextView);
    setSelectedId(null);
    onChange({ ...diagram, active_view: nextView });
    if (nextView === "back" && tool.startsWith("socket")) setTool("select");
  }

  function handleCanvasPointerDown(event) {
    if (event.target !== event.currentTarget && event.target.dataset.canvas !== "surface") return;
    const point = fromPointer(event);
    if (tool === "wall") {
      setDraftPoints((points) => [...points, point]);
      return;
    }
    if (tool === "select") {
      setSelectedId(null);
      return;
    }
    const template = ELEMENT_TYPES[tool];
    if (!template) return;
    const element = {
      id: globalThis.crypto?.randomUUID?.() || `element-${Date.now()}`,
      type: tool,
      side: view,
      label: template.label,
      x: point.x,
      y: point.y,
      width: template.width,
      height: template.height,
      count: template.count,
      spacing: 72,
      mounting_type: tool === "mounting" ? "Монтажная планка" : "",
      note: "",
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
    dragRef.current = { id: element.id, start: fromPointer(event), x: element.x, y: element.y, snapshot: diagram };
  }

  function handlePointerMove(event) {
    const drag = dragRef.current;
    if (!drag) return;
    const point = fromPointer(event);
    const movingElement = diagram.elements.find((element) => element.id === drag.id);
    const width = numberValue(movingElement?.width, 0);
    const height = numberValue(movingElement?.height, 0);
    const x = snap(clamp(drag.x + point.x - drag.start.x, 0, Math.max(wallWidth - width / 2, 0)));
    const y = snap(clamp(drag.y + point.y - drag.start.y, 0, Math.max(wallHeight - height / 2, 0)));
    updateElement(drag.id, { x, y }, false);
  }

  function endDrag() {
    if (!dragRef.current) return;
    setHistory((items) => [...items.slice(-29), dragRef.current.snapshot]);
    setFuture([]);
    dragRef.current = null;
  }

  function finishWall() {
    if (draftPoints.length < 3) return;
    updateDiagram({ wall: { ...diagram.wall, points: draftPoints } });
    setDraftPoints([]);
    setTool("select");
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

  const wallPoints = (draftPoints.length ? draftPoints : diagram.wall.points || []).map(toSvg);
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
          <button key={id} type="button" onClick={() => { setTool(id); setSelectedId(null); if (id !== "wall") setDraftPoints([]); }} className={`flex shrink-0 items-center gap-2 rounded-full border px-3 py-2 text-xs font-bold transition ${tool === id ? "border-sky-400 bg-sky-400 text-slate-950" : "border-white/10 bg-white/5 text-slate-300"}`}><Icon size={15} />{label}</button>
        ))}
      </div>

      {tool === "wall" ? <div className="flex items-center justify-between gap-3 bg-sky-400/10 px-4 py-3 text-xs text-sky-100"><span>Нажимайте по углам стены по порядку.</span><div className="flex gap-2"><button type="button" className="font-bold" onClick={() => setDraftPoints([])}>Сбросить</button><button type="button" disabled={draftPoints.length < 3} className="inline-flex items-center gap-1 rounded-full bg-sky-400 px-3 py-1.5 font-black text-slate-950 disabled:opacity-40" onClick={finishWall}><Check size={14} />Замкнуть</button></div></div> : null}

      <div className="bg-[#dce8ea] p-2 sm:p-4">
        <svg ref={svgRef} viewBox="0 0 1000 700" role="img" aria-label={`Схема: ${VIEW_LABELS[view]}`} className="block aspect-[10/7] w-full touch-none rounded-2xl bg-[#f7f4eb] shadow-inner" onPointerDown={handleCanvasPointerDown} onPointerMove={handlePointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
          <defs>
            <pattern id="minor-grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M 20 0 L 0 0 0 20" fill="none" stroke="#cbd5d1" strokeWidth="1" /></pattern>
            <pattern id="major-grid" width="100" height="100" patternUnits="userSpaceOnUse"><rect width="100" height="100" fill="url(#minor-grid)" /><path d="M 100 0 L 0 0 0 100" fill="none" stroke="#9fb3b4" strokeWidth="1.5" /></pattern>
          </defs>
          <rect data-canvas="surface" width="1000" height="700" fill="url(#major-grid)" />
          <rect data-canvas="surface" x={CANVAS.x} y={CANVAS.y} width={CANVAS.width} height={CANVAS.height} rx="8" fill="#fffdf6" fillOpacity="0.72" stroke="#82989a" strokeWidth="3" strokeDasharray={wallPolygon ? "8 8" : "0"} />
          {wallPolygon ? <polygon points={wallPolygon} fill="#e0eef0" fillOpacity="0.62" stroke="#0f172a" strokeWidth="5" strokeLinejoin="round" pointerEvents="none" /> : null}
          {wallPoints.map((point, index) => <circle key={`${point.x}-${point.y}-${index}`} cx={point.x} cy={point.y} r="8" fill="#38bdf8" stroke="#0f172a" strokeWidth="3" pointerEvents="none" />)}

          {view !== "wall" ? <ProductShape product={diagram.product} x={productTopLeft.x} y={productTopLeft.y} width={productWidth} height={productHeight} /> : null}
          {visibleElements.map((element) => <DiagramElement key={element.id} element={element} selected={element.id === selectedId} toSvg={toSvg} wallWidth={wallWidth} wallHeight={wallHeight} onPointerDown={(event) => startDrag(event, element)} />)}

          <Dimension x1={CANVAS.x} y1={CANVAS.y + CANVAS.height + 28} x2={CANVAS.x + CANVAS.width} y2={CANVAS.y + CANVAS.height + 28} label={`${wallWidth} мм`} />
          <Dimension x1={CANVAS.x - 28} y1={CANVAS.y + CANVAS.height} x2={CANVAS.x - 28} y2={CANVAS.y} label={`${wallHeight} мм`} vertical />
        </svg>
      </div>

      <VoiceSpecification
        view={view}
        items={diagram.specifications?.[view] || []}
        onChange={(items) => updateDiagram({ specifications: { ...diagram.specifications, [view]: items } })}
      />

      <div className="grid gap-4 border-t border-white/10 bg-slate-900 p-4 sm:grid-cols-2 sm:p-5">
        <EditorGroup title="Рабочая область">
          <NumberField label="Ширина стены" value={diagram.wall.width} onChange={(value) => updateWall("width", value)} />
          <NumberField label="Высота стены" value={diagram.wall.height} onChange={(value) => updateWall("height", value)} />
          {view !== "wall" ? <><NumberField label="Ширина изделия" value={diagram.product.width} onChange={(value) => updateProduct("width", value)} /><NumberField label="Высота изделия" value={diagram.product.height} onChange={(value) => updateProduct("height", value)} /><NumberField label="Изделие от левого края" value={diagram.product.x} onChange={(value) => updateProduct("x", value)} /><NumberField label="Изделие от пола" value={diagram.product.y} onChange={(value) => updateProduct("y", value)} /></> : null}
        </EditorGroup>
        <EditorGroup title={selected ? "Выбранный элемент" : "Как работать"}>
          {selected ? <>
            <TextField label="Название" value={selected.label} onChange={(value) => updateElement(selected.id, { label: value })} />
            <NumberField label="X от левого края" value={selected.x} onChange={(value) => updateElement(selected.id, { x: numberValue(value) })} />
            <NumberField label="Y от пола" value={selected.y} onChange={(value) => updateElement(selected.id, { y: numberValue(value) })} />
            <NumberField label={selected.type === "hole" ? "Диаметр" : "Ширина"} value={selected.width} onChange={(value) => updateElement(selected.id, { width: numberValue(value), ...(selected.type === "hole" ? { height: numberValue(value) } : {}) })} />
            {selected.type !== "hole" ? <NumberField label="Высота" value={selected.height} onChange={(value) => updateElement(selected.id, { height: numberValue(value) })} /> : null}
            {selected.type === "light" ? <><NumberField label="Количество светильников" value={selected.count} onChange={(value) => updateElement(selected.id, { count: Math.max(numberValue(value, 1), 1) })} /><NumberField label="Шаг между центрами" value={selected.spacing} onChange={(value) => updateElement(selected.id, { spacing: numberValue(value) })} /></> : null}
            {selected.type === "mounting" ? <TextField label="Тип крепежа" value={selected.mounting_type} onChange={(value) => updateElement(selected.id, { mounting_type: value })} /> : null}
            <TextField label="Комментарий" value={selected.note} onChange={(value) => updateElement(selected.id, { note: value })} />
          </> : <div className="col-span-2 space-y-2 text-sm leading-relaxed text-slate-400"><p>1. Выберите инструмент и коснитесь нужного места.</p><p>2. Перетаскивайте элемент пальцем.</p><p>3. Точные координаты и размеры задавайте в полях.</p><p>4. Крепёж и питание добавляйте на заднюю сторону.</p></div>}
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
  return <g onPointerDown={onPointerDown} className="cursor-grab active:cursor-grabbing">
    {selected ? <rect x={center.x - width / 2 - 8 - groupWidth / 2} y={center.y - height / 2 - 8} width={width + 16 + groupWidth} height={height + 16} rx="12" fill="none" stroke="#38bdf8" strokeWidth="3" strokeDasharray="8 6" /> : null}
    {element.type.startsWith("socket") ? <SocketSymbol center={center} width={width} height={height} count={element.count} stroke={stroke} /> : null}
    {element.type === "light" ? Array.from({ length: count }, (_, index) => <LightSymbol key={index} x={center.x - groupWidth / 2 + index * spacing} y={center.y} radius={Math.max(width / 2, 15)} stroke={stroke} />) : null}
    {element.type === "power" ? <PowerSymbol center={center} size={Math.max(width, height)} stroke={stroke} /> : null}
    {element.type === "mounting" ? <MountSymbol center={center} width={width} height={height} stroke={stroke} /> : null}
    {element.type === "hole" ? <circle cx={center.x} cy={center.y} r={Math.max(width / 2, 12)} fill="#fffdf6" stroke={stroke} strokeWidth="5" /> : null}
    <text x={center.x} y={center.y + height / 2 + 22} textAnchor="middle" fontSize="15" fontWeight="800" fill="#334155">{element.label}</text>
    {selected ? <><text x={center.x} y={center.y - height / 2 - 17} textAnchor="middle" fontSize="14" fontWeight="800" fill="#0369a1">X {Math.round(element.x)} · Y {Math.round(element.y)}</text></> : null}
  </g>;
}

function SocketSymbol({ center, width, height, count, stroke }) {
  const safeCount = Math.max(numberValue(count, 1), 1);
  const cellWidth = width / safeCount;
  return <g><rect x={center.x - width / 2} y={center.y - height / 2} width={width} height={height} rx={Math.min(height / 4, 12)} fill="#fffdf6" stroke={stroke} strokeWidth="5" />{Array.from({ length: safeCount }, (_, index) => { const x = center.x - width / 2 + cellWidth * (index + 0.5); return <g key={index}><circle cx={x} cy={center.y} r={Math.max(Math.min(cellWidth, height) * 0.24, 5)} fill="none" stroke={stroke} strokeWidth="3" /><circle cx={x - 4} cy={center.y} r="1.8" fill={stroke} /><circle cx={x + 4} cy={center.y} r="1.8" fill={stroke} /></g>; })}</g>;
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

function Dimension({ x1, y1, x2, y2, label, vertical = false }) {
  return <g stroke="#475569" fill="#334155" pointerEvents="none"><line x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth="2" /><line x1={x1 - (vertical ? 6 : 0)} y1={y1 - (vertical ? 0 : 6)} x2={x1 + (vertical ? 6 : 0)} y2={y1 + (vertical ? 0 : 6)} strokeWidth="2" /><line x1={x2 - (vertical ? 6 : 0)} y1={y2 - (vertical ? 0 : 6)} x2={x2 + (vertical ? 6 : 0)} y2={y2 + (vertical ? 0 : 6)} strokeWidth="2" /><text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 8} transform={vertical ? `rotate(-90 ${(x1 + x2) / 2} ${(y1 + y2) / 2})` : undefined} textAnchor="middle" fontSize="15" fontWeight="800">{label}</text></g>;
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
