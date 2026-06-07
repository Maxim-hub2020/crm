import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  BadgeRussianRuble,
  Calendar,
  Check,
  FileText,
  LayoutGrid,
  List,
  ListTodo,
  MapPin,
  MessageSquare,
  Phone,
  Plus,
  Search,
  Trash2,
  Wallet,
} from "lucide-react";
import { useLocation } from "react-router-dom";

import {
  createPayment,
  createProject,
  createProjectComment,
  createTask,
  deletePayment,
  deleteProject,
  deleteProjectComment,
  deleteTask,
  downloadProjectDocument,
  extractApiErrorMessage,
  fetchClients,
  fetchPayments,
  fetchProjectComments,
  fetchProjects,
  fetchProjectStatuses,
  fetchTasks,
  updateTask,
  updateProject,
} from "../api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Input,
  Label,
  Modal,
  Select,
} from "../components/ui.jsx";

const VIEW_MODE_KEY = "crm_projects_view_mode";

const DEFAULT_STATUS_OPTIONS = [
  { value: "active", label: "В работе", short: "Работа", color: "sky", is_default: true },
  { value: "closed", label: "Завершено", short: "Готово", color: "emerald", is_default: false },
  { value: "canceled", label: "Отменено", short: "Стоп", color: "rose", is_default: false },
];

const PAYMENT_TYPE_OPTIONS = [
  { value: "advance", label: "Аванс" },
  { value: "additional", label: "Доплата" },
  { value: "refund", label: "Возврат" },
  { value: "correction", label: "Корректировка" },
];

const PAYMENT_METHOD_OPTIONS = [
  { value: "transfer", label: "Перевод" },
  { value: "cash", label: "Наличные" },
  { value: "card", label: "Карта" },
  { value: "other", label: "Другое" },
];

const moneyFormatter = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function normalizeStatusOption(status) {
  return {
    value: status.code ?? status.value,
    label: status.name ?? status.label,
    short: status.short_name || status.short || status.name || status.label,
    color: status.color || "sky",
    is_default: Boolean(status.is_default),
  };
}

function createEmptyProjectForm(status = "active") {
  return {
    title: "",
    client: "",
    client_query: "",
    client_name: "",
    client_phone: "",
    client_email: "",
    object_address: "",
    description: "",
    total_amount: "",
    works_with_contract: false,
    status,
  };
}

function createEmptyPaymentForm() {
  return {
    type: "advance",
    amount: "",
    method: "transfer",
    comment: "",
    paid_at: "",
  };
}

function createEmptyTaskForm() {
  return {
    title: "",
    notes: "",
    due_date: "",
    priority: "medium",
  };
}

function buildProjectUpdatePayload(form) {
  return {
    title: form.title.trim(),
    client_name: form.client_name.trim(),
    client_phone: form.client_phone.trim(),
    client_email: form.client_email.trim(),
    object_address: form.object_address.trim(),
    description: form.description.trim(),
    categories: "",
    status: form.status,
    total_amount: form.total_amount.trim() ? form.total_amount.trim() : null,
  };
}

function normalizeProjectForm(project, fallbackStatus = "active") {
  return {
    title: project?.title || "",
    client: project?.client || project?.client_info?.id || "",
    client_query: project?.client_name || "",
    client_name: project?.client_name || "",
    client_phone: project?.client_phone || "",
    client_email: project?.client_email || "",
    object_address: project?.object_address || "",
    description: project?.description || "",
    total_amount: project?.total_amount ? String(project.total_amount) : "",
    works_with_contract: Boolean(project?.client_info?.works_with_contract ?? project?.works_with_contract),
    status: project?.status || fallbackStatus,
  };
}

function labelFor(options, value) {
  return options.find((option) => option.value === value)?.label || value;
}

function formatMoney(value) {
  return moneyFormatter.format(Number(value || 0));
}

function projectDisplayName(project) {
  return project?.title || project?.client_name || `Проект #${project?.id || ""}`;
}

function normalizeSearchText(value) {
  return String(value || "").trim().toLowerCase();
}

function phoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function phoneHref(value) {
  const normalized = String(value || "").replace(/[^\d+]/g, "");
  return normalized ? `tel:${normalized}` : "";
}

function cleanAddressForMaps(value) {
  const rawAddress = String(value || "").trim();
  if (!rawAddress) return "";

  const privateMarkers =
    /\b(кв\.?|квартира|ап\.?|апартаменты|офис|пом\.?|помещение|этаж|эт\.?|подъезд|парадная|домофон|код)\b/i;
  const withoutCommaParts = rawAddress
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && !privateMarkers.test(part))
    .join(", ");

  return withoutCommaParts
    .replace(
      /\s*(,?\s*(кв\.?|квартира|ап\.?|апартаменты|офис|пом\.?|помещение|этаж|эт\.?|подъезд|парадная|домофон|код)\s*[:№#-]?\s*[\wА-Яа-яЁё/-]+)+\s*$/gi,
      ""
    )
    .replace(/\s{2,}/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/,+$/g, "")
    .trim();
}

function yandexRouteUrl(address) {
  const cleanAddress = cleanAddressForMaps(address);
  if (!cleanAddress) return "";
  return `https://yandex.ru/maps/?mode=routes&rtext=~${encodeURIComponent(cleanAddress)}&rtt=auto`;
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("ru-RU");
}

function formatDeadline(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

function sanitizeFileName(value) {
  return String(value || "client")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

function filenameFromDisposition(headers, fallback) {
  const disposition = headers?.["content-disposition"] || headers?.["Content-Disposition"] || "";
  const encodedMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch?.[1]) {
    try {
      return decodeURIComponent(encodedMatch[1]);
    } catch {
      return fallback;
    }
  }

  const quotedMatch = disposition.match(/filename="?([^";]+)"?/i);
  return quotedMatch?.[1] || fallback;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function daysInWork(value) {
  if (!value) return 0;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 0;
  return Math.max(0, Math.ceil((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24)));
}

function projectAmount(project, paymentsByProject) {
  const plannedAmount = Number(project?.total_amount || 0);
  if (plannedAmount > 0) return plannedAmount;

  const rows = paymentsByProject.get(project.id) || [];
  return rows.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
}

function paymentSignedAmount(payment) {
  const amount = Number(payment?.amount || 0);
  return payment?.type === "refund" || payment?.type === "correction" ? -amount : amount;
}

function projectFinanceStats(rows) {
  return rows.reduce(
    (stats, payment) => {
      const signedAmount = paymentSignedAmount(payment);
      if (signedAmount >= 0) {
        stats.income += signedAmount;
      } else {
        stats.expense += Math.abs(signedAmount);
      }
      stats.margin = stats.income - stats.expense;
      stats.marginPercent = stats.income > 0 ? (stats.margin / stats.income) * 100 : 0;
      return stats;
    },
    { income: 0, expense: 0, margin: 0, marginPercent: 0 }
  );
}

function ageBadgeClass(days) {
  if (days >= 8) return "bg-red-50 text-red-600";
  if (days >= 4) return "bg-amber-50 text-amber-600";
  return "bg-slate-100 text-slate-500";
}

function statusBadgeClass(colorOrStatus) {
  if (colorOrStatus === "emerald" || colorOrStatus === "closed") return "bg-emerald-100 text-emerald-700";
  if (colorOrStatus === "rose" || colorOrStatus === "canceled") return "bg-rose-100 text-rose-700";
  if (colorOrStatus === "amber") return "bg-amber-100 text-amber-700";
  if (colorOrStatus === "violet") return "bg-violet-100 text-violet-700";
  if (colorOrStatus === "slate") return "bg-slate-100 text-slate-700";
  return "bg-sky-100 text-sky-700";
}

function autosaveStatusLabel(status) {
  if (status === "pending") return "Готовим автосохранение...";
  if (status === "saving") return "Сохраняем изменения...";
  if (status === "saved") return "Изменения сохранены автоматически";
  if (status === "error") return "Автосохранение не сработало";
  return "Изменения сохраняются автоматически";
}

function ModeButton({ active, icon: Icon, label, onClick }) {
  return (
    <Button
      type="button"
      variant={active ? "primary" : "secondary"}
      className="px-4"
      onClick={onClick}
    >
      <Icon size={16} />
      {label}
    </Button>
  );
}

function StatCard({ icon: Icon, label, value, dark = false }) {
  return (
    <div
      className={`rounded-[26px] px-5 py-4 ring-1 ${
        dark
          ? "bg-slate-900 text-white ring-slate-900"
          : "bg-slate-50 text-slate-900 ring-slate-200/70"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className={`text-[10px] font-black uppercase tracking-[0.2em] ${dark ? "text-slate-300" : "text-slate-400"}`}>
            {label}
          </div>
          <div className="mt-2 text-xl font-black tracking-tight">{value}</div>
        </div>
        <Icon size={18} className={dark ? "text-white/70" : "text-slate-400"} />
      </div>
    </div>
  );
}

function ProjectTaskRow({ task, onToggle, onDelete }) {
  const done = task.status === "done";

  return (
    <div className={`flex items-start gap-4 rounded-[22px] px-4 py-4 ${done ? "bg-emerald-50" : "bg-slate-50"}`}>
      <button
        type="button"
        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 transition ${
          done ? "border-emerald-500 bg-emerald-500 text-white" : "border-slate-300 text-transparent hover:border-blue-500"
        }`}
        onClick={() => onToggle(task)}
      >
        <Check size={15} />
      </button>
      <div className="min-w-0 flex-1">
        <div className={`font-black leading-5 ${done ? "text-slate-400 line-through" : "text-slate-900"}`}>
          {task.title}
        </div>
        {task.notes && <div className="mt-1.5 whitespace-pre-wrap text-sm leading-5 text-slate-500">{task.notes}</div>}
        {task.due_date && (
          <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-bold text-amber-600">
            <Calendar size={12} />
            {formatDeadline(task.due_date)}
          </div>
        )}
      </div>
      <button
        type="button"
        className="rounded-full p-2 text-slate-400 transition hover:bg-white hover:text-red-600"
        onClick={() => onDelete(task.id)}
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}

function EmptyColumn({ onCreate }) {
  return (
    <button
      type="button"
      onClick={onCreate}
      className="flex min-h-[108px] w-full items-center justify-center rounded-[22px] border border-dashed border-slate-200 bg-white/75 text-sm font-semibold text-slate-400 transition hover:border-slate-300 hover:bg-white hover:text-slate-700"
    >
      Добавить первый проект
    </button>
  );
}

function ColumnHeader({ status, count, totalAmount }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-5">
      <div className="flex items-center gap-3">
        <div className="text-[1.05rem] font-black tracking-tight text-slate-800">{status.label}</div>
        <span className="inline-flex min-w-8 items-center justify-center rounded-full bg-slate-100 px-2 py-1 text-xs font-bold text-slate-400">
          {count}
        </span>
      </div>
      <div className="pt-0.5 text-right text-[1.05rem] font-black tracking-tight text-slate-600">
        {formatMoney(totalAmount)} ₽
      </div>
    </div>
  );
}

function ProjectKanbanCard({ project, amount, ageDays, isDragging = false, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full select-none rounded-[22px] border border-slate-200/90 bg-white px-4 py-4 text-left shadow-[0_10px_24px_rgba(15,23,42,0.06)] transition hover:-translate-y-0.5 hover:shadow-[0_14px_32px_rgba(15,23,42,0.08)] ${
        isDragging ? "scale-[0.98] cursor-grabbing opacity-55 ring-2 ring-blue-500" : "cursor-grab"
      }`}
    >
      <div className="line-clamp-2 text-[1.02rem] font-black leading-6 tracking-tight text-slate-800">
        {projectDisplayName(project)}
      </div>
      <div className="mt-1.5 text-sm text-slate-500">{project.client_name || "Клиент не назначен"}</div>
      <div className="mt-4 flex items-end justify-between gap-3">
        <div className="text-[1.05rem] font-black tracking-tight text-blue-600">{formatMoney(amount)} ₽</div>
        <span className={`rounded-full px-3 py-1 text-sm font-semibold ${ageBadgeClass(ageDays)}`}>
          {ageDays || 0} дн.
        </span>
      </div>
    </button>
  );
}

export default function Projects() {
  const location = useLocation();

  const [projects, setProjects] = useState([]);
  const [clients, setClients] = useState([]);
  const [payments, setPayments] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [statusRows, setStatusRows] = useState(DEFAULT_STATUS_OPTIONS);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState(location.state?.q || "");
  const deferredQuery = useDeferredValue(query);
  const [viewMode, setViewMode] = useState(() => localStorage.getItem(VIEW_MODE_KEY) || "kanban");
  const [touchDragProjectId, setTouchDragProjectId] = useState(null);
  const [dragTargetStatus, setDragTargetStatus] = useState("");
  const [dragPreview, setDragPreview] = useState(null);
  const pointerDragRef = useRef(null);
  const suppressProjectClickRef = useRef(false);
  const bodyDragStyleRef = useRef(null);

  const [openCreate, setOpenCreate] = useState(false);
  const [createForm, setCreateForm] = useState(createEmptyProjectForm());
  const [createSaving, setCreateSaving] = useState(false);
  const [createError, setCreateError] = useState("");

  const [activeProjectId, setActiveProjectId] = useState(null);
  const [detailForm, setDetailForm] = useState(createEmptyProjectForm());
  const [detailTab, setDetailTab] = useState("comments");
  const [detailAutosaveState, setDetailAutosaveState] = useState("idle");
  const detailSnapshotRef = useRef("");
  const detailAutosaveTimerRef = useRef(null);
  const detailAutosaveRequestRef = useRef(0);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  const [comments, setComments] = useState([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [commentSaving, setCommentSaving] = useState(false);
  const [commentError, setCommentError] = useState("");

  const [paymentForm, setPaymentForm] = useState(createEmptyPaymentForm());
  const [paymentSaving, setPaymentSaving] = useState(false);
  const [paymentError, setPaymentError] = useState("");

  const [taskForm, setTaskForm] = useState(createEmptyTaskForm());
  const [taskSaving, setTaskSaving] = useState(false);
  const [taskError, setTaskError] = useState("");

  const [confirmState, setConfirmState] = useState(null);
  const [confirmDeleting, setConfirmDeleting] = useState(false);

  const statusOptions = useMemo(() => {
    const source = statusRows.length > 0 ? statusRows : DEFAULT_STATUS_OPTIONS;
    return source.map(normalizeStatusOption);
  }, [statusRows]);

  const defaultStatusValue = useMemo(() => {
    return statusOptions.find((status) => status.is_default)?.value || statusOptions[0]?.value || "active";
  }, [statusOptions]);

  const statusMap = useMemo(() => {
    return new Map(statusOptions.map((status) => [status.value, status]));
  }, [statusOptions]);

  async function reloadData({ silent = false } = {}) {
    if (!silent) {
      setLoading(true);
    }

    try {
      const [projectRows, clientRows, paymentRows, taskRows, statusItems] = await Promise.all([
        fetchProjects(),
        fetchClients(),
        fetchPayments(),
        fetchTasks(),
        fetchProjectStatuses(),
      ]);

      setProjects(projectRows);
      setClients(clientRows);
      setPayments(paymentRows);
      setTasks(taskRows);
      setStatusRows(statusItems.length > 0 ? statusItems : DEFAULT_STATUS_OPTIONS);
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }

  async function reloadComments(projectId) {
    if (!projectId) {
      setComments([]);
      return;
    }

    setCommentsLoading(true);
    try {
      const rows = await fetchProjectComments(projectId);
      setComments(rows);
    } catch {
      setComments([]);
    } finally {
      setCommentsLoading(false);
    }
  }

  useEffect(() => {
    reloadData().catch(() => {
      setProjects([]);
      setClients([]);
      setPayments([]);
      setTasks([]);
      setStatusRows(DEFAULT_STATUS_OPTIONS);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    localStorage.setItem(VIEW_MODE_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    if (location.state?.q) {
      setQuery(location.state.q);
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);

  useEffect(() => {
    if (!openCreate) {
      setCreateForm((prev) => ({
        ...prev,
        status: prev.status || defaultStatusValue,
      }));
    }
  }, [defaultStatusValue, openCreate]);

  const paymentsByProject = useMemo(() => {
    const map = new Map();

    for (const payment of payments) {
      if (!map.has(payment.project)) {
        map.set(payment.project, []);
      }
      map.get(payment.project).push(payment);
    }

    for (const rows of map.values()) {
      rows.sort((left, right) => (right.paid_at || "").localeCompare(left.paid_at || ""));
    }

    return map;
  }, [payments]);

  const clientDirectory = useMemo(() => {
    return clients
      .map((client) => ({
        key: client.id,
        client_id: client.id,
        client_name: client.name || "",
        client_phone: client.phone || "",
        client_email: client.email || "",
        object_address: client.address || "",
        works_with_contract: Boolean(client.works_with_contract),
        project_count: client.project_count || 0,
        updated_at: client.updated_at || client.created_at || "",
        searchText: normalizeSearchText([client.name, client.phone, client.email, client.address].filter(Boolean).join(" ")),
        phoneDigits: phoneDigits(client.phone),
      }))
      .sort((left, right) => (right.updated_at || "").localeCompare(left.updated_at || ""));
  }, [clients]);

  const createClientLookup = useMemo(() => {
    const textQuery = normalizeSearchText(createForm.client_query || createForm.client_name || createForm.client_phone);
    const digitsQuery = phoneDigits(createForm.client_query || createForm.client_phone);
    const queryReady = textQuery.length >= 2 || digitsQuery.length >= 3;

    if (!openCreate || !queryReady) {
      return { queryReady: false, matches: [] };
    }

    const matches = clientDirectory
      .filter((client) => {
        const byPhone = digitsQuery.length >= 3 && client.phoneDigits.includes(digitsQuery);
        const byText = textQuery.length >= 2 && client.searchText.includes(textQuery);
        return byPhone || byText;
      })
      .slice(0, 5);

    return { queryReady: true, matches };
  }, [clientDirectory, createForm.client_name, createForm.client_phone, createForm.client_query, openCreate]);

  const selectedCreateClient = useMemo(() => {
    if (!createForm.client) return null;
    return clientDirectory.find((client) => String(client.client_id) === String(createForm.client)) || null;
  }, [clientDirectory, createForm.client]);

  const filteredProjects = useMemo(() => {
    const value = deferredQuery.trim().toLowerCase();
    if (!value) return projects;

    return projects.filter((project) =>
      [project.title, project.client_name, project.client_phone, project.object_address, project.description]
        .filter(Boolean)
        .some((field) => field.toLowerCase().includes(value))
    );
  }, [deferredQuery, projects]);

  const groupedProjects = useMemo(() => {
    const groups = Object.fromEntries(statusOptions.map((status) => [status.value, []]));

    for (const project of filteredProjects) {
      const statusValue = groups[project.status] ? project.status : defaultStatusValue;
      if (!groups[statusValue]) {
        groups[statusValue] = [];
      }
      groups[statusValue].push(project);
    }

    return groups;
  }, [defaultStatusValue, filteredProjects, statusOptions]);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) || null,
    [activeProjectId, projects]
  );

  const draggedProject = useMemo(
    () => projects.find((project) => project.id === dragPreview?.projectId) || null,
    [dragPreview?.projectId, projects]
  );

  const activeProjectPayments = useMemo(() => {
    if (!activeProjectId) return [];
    return paymentsByProject.get(activeProjectId) || [];
  }, [activeProjectId, paymentsByProject]);

  const cleanRouteAddress = useMemo(() => cleanAddressForMaps(detailForm.object_address), [detailForm.object_address]);
  const routeUrl = useMemo(() => yandexRouteUrl(detailForm.object_address), [detailForm.object_address]);

  const activeProjectTasks = useMemo(() => {
    if (!activeProjectId) return [];

    return tasks
      .filter((task) => String(task.project || "") === String(activeProjectId))
      .sort((left, right) => {
        if (left.status !== right.status) {
          return left.status === "done" ? 1 : -1;
        }
        return (left.due_date || "9999-12-31").localeCompare(right.due_date || "9999-12-31");
      });
  }, [activeProjectId, tasks]);

  const activeProjectFinanceStats = useMemo(
    () => projectFinanceStats(activeProjectPayments),
    [activeProjectPayments]
  );

  const activeProjectPaymentTotal = useMemo(
    () => activeProjectFinanceStats.margin,
    [activeProjectFinanceStats]
  );

  const activeProjectMarginLabel = useMemo(
    () => `${formatMoney(activeProjectFinanceStats.margin)} ₽ / ${activeProjectFinanceStats.marginPercent.toFixed(0)}%`,
    [activeProjectFinanceStats]
  );

  useEffect(() => {
    if (!activeProject) {
      return;
    }

    const nextForm = normalizeProjectForm(activeProject, defaultStatusValue);
    setDetailForm(nextForm);
    detailSnapshotRef.current = JSON.stringify(buildProjectUpdatePayload(nextForm));
    setDetailAutosaveState("idle");
    setDetailError("");
  }, [activeProject, defaultStatusValue]);

  useEffect(() => {
    if (!activeProject) return;

    const payload = buildProjectUpdatePayload(detailForm);
    const payloadKey = JSON.stringify(payload);

    if (!detailSnapshotRef.current || payloadKey === detailSnapshotRef.current) {
      return;
    }

    if (!payload.title || !payload.client_name) {
      setDetailAutosaveState("idle");
      return;
    }

    setDetailAutosaveState("pending");
    window.clearTimeout(detailAutosaveTimerRef.current);

    detailAutosaveTimerRef.current = window.setTimeout(async () => {
      const requestId = detailAutosaveRequestRef.current + 1;
      detailAutosaveRequestRef.current = requestId;
      setDetailAutosaveState("saving");

      try {
        const updated = await updateProject(activeProject.id, payload);
        if (detailAutosaveRequestRef.current !== requestId) return;

        setProjects((prev) => prev.map((project) => (project.id === updated.id ? updated : project)));
        if (updated.client_info) {
          setClients((prev) => prev.map((client) => (client.id === updated.client_info.id ? updated.client_info : client)));
        }
        detailSnapshotRef.current = JSON.stringify(buildProjectUpdatePayload(normalizeProjectForm(updated, defaultStatusValue)));
        setDetailError("");
        setDetailAutosaveState("saved");
        window.setTimeout(() => {
          if (detailAutosaveRequestRef.current === requestId) {
            setDetailAutosaveState("idle");
          }
        }, 1400);
      } catch (error) {
        if (detailAutosaveRequestRef.current !== requestId) return;
        setDetailAutosaveState("error");
        setDetailError(extractApiErrorMessage(error, "Не удалось автоматически сохранить проект."));
      }
    }, 900);

    return () => window.clearTimeout(detailAutosaveTimerRef.current);
  }, [activeProject, defaultStatusValue, detailForm]);

  useEffect(() => {
    if (!activeProjectId) {
      setComments([]);
      setCommentText("");
      setCommentError("");
      setPaymentForm(createEmptyPaymentForm());
      setPaymentError("");
      setTaskForm(createEmptyTaskForm());
      setTaskError("");
      return;
    }

    reloadComments(activeProjectId).catch(() => {});
  }, [activeProjectId]);

  function openCreateModal(status = defaultStatusValue) {
    setCreateError("");
    setCreateForm(createEmptyProjectForm(status));
    setOpenCreate(true);
  }

  function closeCreateModal() {
    setOpenCreate(false);
    setCreateError("");
    setCreateForm(createEmptyProjectForm(defaultStatusValue));
  }

  function applyClientFromSearch(client) {
    setCreateForm((prev) => ({
      ...prev,
      client: client.client_id || "",
      client_query: client.client_phone || client.client_name || prev.client_query,
      client_name: client.client_name || prev.client_name,
      client_phone: client.client_phone || prev.client_phone,
      client_email: client.client_email || prev.client_email,
      object_address: client.object_address || prev.object_address,
      works_with_contract: Boolean(client.works_with_contract),
    }));
  }

  function handleCreateClientQuery(value) {
    const digits = phoneDigits(value);
    setCreateForm((prev) => ({
      ...prev,
      client: "",
      client_query: value,
      client_phone: digits ? value : prev.client_phone,
      client_name: digits ? prev.client_name : value,
    }));
  }

  function openProject(project, tab = "comments") {
    setActiveProjectId(project.id);
    setDetailTab(tab);
  }

  function closeProject() {
    setActiveProjectId(null);
    setDetailTab("comments");
    setDetailError("");
    setCommentError("");
    setPaymentError("");
    setTaskError("");
    setTaskForm(createEmptyTaskForm());
    setDetailAutosaveState("idle");
    detailSnapshotRef.current = "";
    window.clearTimeout(detailAutosaveTimerRef.current);
  }

  async function submitCreate(event) {
    event.preventDefault();
    setCreateError("");
    setCreateSaving(true);

    try {
      if (!createForm.title.trim()) {
        setCreateError("Укажите наименование проекта.");
        return;
      }

      if (!createForm.client_name.trim() && !createForm.client && !createForm.client_phone.trim()) {
        setCreateError("Выберите клиента или укажите имя для новой карточки клиента.");
        return;
      }

      const created = await createProject({
        title: createForm.title.trim(),
        client: createForm.client || undefined,
        client_name: createForm.client_name.trim(),
        client_phone: createForm.client_phone.trim(),
        client_email: createForm.client_email.trim() || undefined,
        object_address: createForm.object_address.trim(),
        description: createForm.description.trim(),
        categories: "",
        status: createForm.status,
        total_amount: createForm.total_amount.trim() ? createForm.total_amount.trim() : null,
      });

      setProjects((prev) => [created, ...prev]);
      if (created.client_info) {
        setClients((prev) => {
          const exists = prev.some((client) => client.id === created.client_info.id);
          return exists
            ? prev.map((client) => (client.id === created.client_info.id ? created.client_info : client))
            : [created.client_info, ...prev];
        });
      }
      closeCreateModal();
      openProject(created);
    } catch (error) {
      setCreateError(extractApiErrorMessage(error, "Не удалось создать проект."));
    } finally {
      setCreateSaving(false);
    }
  }

  async function submitComment(event) {
    event.preventDefault();
    if (!activeProject) return;

    setCommentError("");
    setCommentSaving(true);

    try {
      if (!commentText.trim()) {
        setCommentError("Введите комментарий.");
        return;
      }

      const created = await createProjectComment({
        project: activeProject.id,
        text: commentText.trim(),
      });

      setComments((prev) => [created, ...prev]);
      setCommentText("");
    } catch (error) {
      setCommentError(extractApiErrorMessage(error, "Не удалось добавить комментарий."));
    } finally {
      setCommentSaving(false);
    }
  }

  async function handleCommentDelete(commentId) {
    try {
      await deleteProjectComment(commentId);
      setComments((prev) => prev.filter((comment) => comment.id !== commentId));
    } catch (error) {
      setCommentError(extractApiErrorMessage(error, "Не удалось удалить комментарий."));
    }
  }

  async function submitPayment(event) {
    event.preventDefault();
    if (!activeProject) return;

    setPaymentError("");
    setPaymentSaving(true);

    try {
      if (!paymentForm.amount.trim()) {
        setPaymentError("Укажите сумму операции.");
        return;
      }

      const created = await createPayment({
        project: activeProject.id,
        type: paymentForm.type,
        amount: paymentForm.amount.trim(),
        method: paymentForm.method,
        comment: paymentForm.comment.trim(),
        paid_at: paymentForm.paid_at || undefined,
      });

      setPayments((prev) => [created, ...prev]);
      setPaymentForm(createEmptyPaymentForm());
    } catch (error) {
      setPaymentError(extractApiErrorMessage(error, "Не удалось сохранить операцию."));
    } finally {
      setPaymentSaving(false);
    }
  }

  async function handlePaymentDelete(paymentId) {
    try {
      await deletePayment(paymentId);
      setPayments((prev) => prev.filter((payment) => payment.id !== paymentId));
    } catch (error) {
      setPaymentError(extractApiErrorMessage(error, "Не удалось удалить операцию."));
    }
  }

  async function submitTask(event) {
    event.preventDefault();
    if (!activeProject) return;

    setTaskError("");
    setTaskSaving(true);

    try {
      if (!taskForm.title.trim()) {
        setTaskError("Укажите название задачи.");
        return;
      }

      const created = await createTask({
        project: activeProject.id,
        title: taskForm.title.trim(),
        notes: taskForm.notes.trim(),
        due_date: taskForm.due_date || null,
        priority: taskForm.priority,
      });

      setTasks((prev) => [created, ...prev]);
      setTaskForm(createEmptyTaskForm());
    } catch (error) {
      setTaskError(extractApiErrorMessage(error, "Не удалось создать задачу."));
    } finally {
      setTaskSaving(false);
    }
  }

  async function toggleProjectTask(task) {
    try {
      const updated = await updateTask(task.id, {
        status: task.status === "done" ? "open" : "done",
      });
      setTasks((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    } catch (error) {
      setTaskError(extractApiErrorMessage(error, "Не удалось обновить задачу."));
    }
  }

  async function handleTaskDelete(taskId) {
    try {
      await deleteTask(taskId);
      setTasks((prev) => prev.filter((task) => task.id !== taskId));
    } catch (error) {
      setTaskError(extractApiErrorMessage(error, "Не удалось удалить задачу."));
    }
  }

  async function handleProjectDelete() {
    if (!activeProject) return;

    try {
      await deleteProject(activeProject.id);
      setProjects((prev) => prev.filter((project) => project.id !== activeProject.id));
      setPayments((prev) => prev.filter((payment) => payment.project !== activeProject.id));
      setTasks((prev) => prev.filter((task) => String(task.project || "") !== String(activeProject.id)));
      closeProject();
    } catch (error) {
      setDetailError(extractApiErrorMessage(error, "Не удалось удалить проект."));
    }
  }

  async function handleDocumentDownload(documentType = "contract") {
    if (!activeProject) return;

    if (documentType === "contract" && !detailForm.works_with_contract) {
      setDetailError("Включите «Работает по договору» в карточке клиента, затем сформируйте договор.");
      return;
    }

    setDetailError("");
    setDocumentLoading(true);

    try {
      const { blob, headers } = await downloadProjectDocument(activeProject.id, documentType);
      const documentName = documentType === "contract" ? "dogovor" : "akt";
      const fallback = `${documentName}-${sanitizeFileName(projectDisplayName(activeProject))}.pdf`;
      saveBlob(blob, filenameFromDisposition(headers, fallback));
    } catch (error) {
      let message = extractApiErrorMessage(
        error,
        "Не удалось сформировать документ. Проверьте, что PDF-шаблон загружен в разделе «Система»."
      );

      const responseData = error?.response?.data;
      if (responseData instanceof Blob) {
        try {
          const parsed = JSON.parse(await responseData.text());
          message = parsed.detail || message;
        } catch {
          // Blob can be a non-JSON error page; fallback message is clearer for the CRM UI.
        }
      }

      setDetailError(message);
    } finally {
      setDocumentLoading(false);
    }
  }

  function requestDeleteProject() {
    if (!activeProject) return;

    setConfirmState({
      kind: "project",
      title: "Удалить проект",
      message: `Проект «${projectDisplayName(activeProject)}» будет удалён вместе с операциями и комментариями.`,
    });
  }

  function requestDeletePayment(paymentId) {
    setConfirmState({
      kind: "payment",
      id: paymentId,
      title: "Удалить операцию",
      message: "Операция будет удалена из карточки проекта и из общего раздела финансов.",
    });
  }

  function requestDeleteComment(commentId) {
    setConfirmState({
      kind: "comment",
      id: commentId,
      title: "Удалить комментарий",
      message: "Комментарий исчезнет из ленты проекта.",
    });
  }

  function requestDeleteTask(taskId) {
    setConfirmState({
      kind: "task",
      id: taskId,
      title: "Удалить задачу",
      message: "Задача исчезнет из карточки проекта и из общего раздела задач.",
    });
  }

  async function submitDeleteConfirmation() {
    if (!confirmState) return;

    setConfirmDeleting(true);
    try {
      if (confirmState.kind === "project") {
        await handleProjectDelete();
      } else if (confirmState.kind === "payment") {
        await handlePaymentDelete(confirmState.id);
      } else if (confirmState.kind === "comment") {
        await handleCommentDelete(confirmState.id);
      } else if (confirmState.kind === "task") {
        await handleTaskDelete(confirmState.id);
      }

      setConfirmState(null);
    } finally {
      setConfirmDeleting(false);
    }
  }

  async function moveProjectToStatus(projectId, nextStatus) {
    const target = projects.find((project) => project.id === projectId);
    if (!target || target.status === nextStatus) return;

    const previousStatus = target.status;
    setProjects((prev) =>
      prev.map((project) => (project.id === projectId ? { ...project, status: nextStatus } : project))
    );

    try {
      const updated = await updateProject(projectId, { status: nextStatus });
      setProjects((prev) => prev.map((project) => (project.id === projectId ? updated : project)));

      if (activeProjectId === projectId) {
        setDetailForm((prev) => ({ ...prev, status: nextStatus }));
      }
    } catch (error) {
      setProjects((prev) =>
        prev.map((project) => (project.id === projectId ? { ...project, status: previousStatus } : project))
      );
      window.alert(extractApiErrorMessage(error, "Не удалось обновить статус проекта."));
    }
  }

  function handleProjectPointerDown(event, projectId) {
    if (event.pointerType === "mouse" && event.button !== 0) return;

    event.preventDefault();
    pointerDragRef.current = {
      projectId,
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
      dragging: false,
    };
    bodyDragStyleRef.current = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
      webkitUserSelect: document.body.style.webkitUserSelect,
    };
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handleProjectPointerMove(event) {
    const drag = pointerDragRef.current;
    if (!drag) return;

    drag.currentX = event.clientX;
    drag.currentY = event.clientY;

    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.dragging && distance > 12) {
      drag.dragging = true;
      setTouchDragProjectId(drag.projectId);
    }

    if (drag.dragging) {
      event.preventDefault();
      setDragPreview({ projectId: drag.projectId, x: event.clientX, y: event.clientY });
      const targetColumn = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest("[data-status-column]");
      setDragTargetStatus(targetColumn?.getAttribute("data-status-column") || "");
    }
  }

  function cleanupProjectDrag() {
    const previousBodyStyle = bodyDragStyleRef.current;
    if (previousBodyStyle) {
      document.body.style.cursor = previousBodyStyle.cursor;
      document.body.style.userSelect = previousBodyStyle.userSelect;
      document.body.style.webkitUserSelect = previousBodyStyle.webkitUserSelect;
    }
    bodyDragStyleRef.current = null;
    pointerDragRef.current = null;
    setTouchDragProjectId(null);
    setDragTargetStatus("");
    setDragPreview(null);
  }

  function handleProjectPointerEnd(event) {
    const drag = pointerDragRef.current;
    if (!drag) return;

    event.currentTarget.releasePointerCapture?.(event.pointerId);

    if (!drag.dragging) {
      cleanupProjectDrag();
      const project = projects.find((item) => item.id === drag.projectId);
      if (project) {
        openProject(project);
      }
      return;
    }

    event.preventDefault();
    suppressProjectClickRef.current = true;
    window.setTimeout(() => {
      suppressProjectClickRef.current = false;
    }, 120);

    const targetColumn = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest("[data-status-column]");
    let nextStatus = targetColumn?.getAttribute("data-status-column") || "";

    if (!nextStatus) {
      const project = projects.find((item) => item.id === drag.projectId);
      const currentIndex = statusOptions.findIndex((status) => status.value === project?.status);
      const swipeDelta = event.clientX - drag.startX;

      if (currentIndex >= 0 && Math.abs(swipeDelta) > 90) {
        nextStatus = swipeDelta < 0 ? statusOptions[currentIndex + 1]?.value : statusOptions[currentIndex - 1]?.value;
      }
    }

    if (nextStatus) {
      moveProjectToStatus(drag.projectId, nextStatus).catch(() => {});
    }

    cleanupProjectDrag();
  }

  return (
    <div className="space-y-6">
      {dragPreview && draggedProject && (
        <div
          className="pointer-events-none fixed z-[70] max-w-[260px] rounded-2xl bg-slate-950 px-4 py-3 text-sm font-black text-white shadow-2xl ring-1 ring-white/20"
          style={{
            left: Math.max(12, Math.min(window.innerWidth - 280, dragPreview.x + 14)),
            top: Math.max(12, Math.min(window.innerHeight - 96, dragPreview.y + 14)),
          }}
        >
          <div className="text-[10px] uppercase tracking-[0.2em] text-blue-200">Перемещаем проект</div>
          <div className="mt-1 truncate">{projectDisplayName(draggedProject)}</div>
        </div>
      )}
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="relative w-full max-w-[420px]">
          <Search
            size={21}
            className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <Input
            className="h-14 rounded-[20px] border-slate-200/90 bg-white pl-14 pr-4 text-[1.02rem] shadow-[0_12px_28px_rgba(15,23,42,0.05)]"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск проектов..."
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 rounded-full bg-white p-1 shadow-sm ring-1 ring-slate-200/80">
            <ModeButton active={viewMode === "kanban"} icon={LayoutGrid} label="Канбан" onClick={() => setViewMode("kanban")} />
            <ModeButton active={viewMode === "list"} icon={List} label="Список" onClick={() => setViewMode("list")} />
          </div>

          <Button type="button" className="px-6" onClick={() => openCreateModal()}>
            <Plus size={16} />
            Создать проект
          </Button>
        </div>
      </div>

      {loading ? (
        <Card>
          <CardBody className="p-12 text-center text-sm text-slate-500">Загружаем проекты и операции...</CardBody>
        </Card>
      ) : viewMode === "kanban" ? (
        <div className="-mx-4 select-none overflow-x-auto px-4 pb-3 sm:mx-0 sm:px-0">
          <div className="grid snap-x snap-mandatory grid-flow-col auto-cols-[calc(100vw-2rem)] gap-5 sm:auto-cols-[minmax(360px,420px)]">
          {statusOptions.map((status) => {
            const columnProjects = groupedProjects[status.value] || [];
            const columnTotal = columnProjects.reduce((sum, project) => {
              return sum + projectAmount(project, paymentsByProject);
            }, 0);

            return (
              <div
                key={status.value}
                data-status-column={status.value}
                className={`flex min-h-[calc(100dvh-235px)] snap-start flex-col overflow-hidden rounded-[28px] border border-slate-200/90 bg-white shadow-[0_14px_36px_rgba(15,23,42,0.05)] transition ${
                  dragTargetStatus === status.value ? "scale-[1.01] ring-2 ring-blue-400" : touchDragProjectId ? "ring-2 ring-blue-100" : ""
                }`}
              >
                <ColumnHeader status={status} count={columnProjects.length} totalAmount={columnTotal} />

                <div
                  className="flex min-h-[calc(100dvh-365px)] flex-1 flex-col gap-3 bg-[#fbfcff] px-3 py-3"
                  data-status-column={status.value}
                >
                  <div className="space-y-3">
                    {columnProjects.map((project) => {
                      const amount = projectAmount(project, paymentsByProject);
                      const ageDays = daysInWork(project.updated_at || project.created_at);

                      return (
                        <div
                          key={project.id}
                          onPointerDown={(event) => handleProjectPointerDown(event, project.id)}
                          onPointerMove={handleProjectPointerMove}
                          onPointerUp={handleProjectPointerEnd}
                          onPointerCancel={cleanupProjectDrag}
                          style={{ touchAction: "none" }}
                        >
                          <ProjectKanbanCard
                            project={project}
                            amount={amount}
                            ageDays={ageDays}
                            isDragging={touchDragProjectId === project.id}
                            onClick={() => {
                              if (!suppressProjectClickRef.current) {
                                openProject(project);
                              }
                            }}
                          />
                        </div>
                      );
                    })}
                  </div>

                  {columnProjects.length === 0 && <EmptyColumn onCreate={() => openCreateModal(status.value)} />}
                </div>

                <div className="border-t border-slate-100 px-5 py-4">
                  <button
                    type="button"
                    className="flex w-full items-center justify-center gap-2 rounded-full px-4 py-2.5 text-[0.98rem] font-semibold text-slate-500 transition hover:bg-slate-50 hover:text-slate-800"
                    onClick={() => openCreateModal(status.value)}
                  >
                    <Plus size={18} />
                    Добавить проект
                  </button>
                </div>
              </div>
            );
          })}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredProjects.map((project) => {
            const rows = paymentsByProject.get(project.id) || [];
            const total = rows.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
            const latestPayment = rows[0];
            const statusMeta = statusMap.get(project.status);

            return (
              <Card key={project.id}>
                <CardBody className="p-6 sm:p-8">
                  <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
                    <div className="space-y-4">
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="text-2xl font-black tracking-tight text-slate-900">{projectDisplayName(project)}</div>
                        <Badge className={statusBadgeClass(statusMeta?.color || project.status)}>
                          {labelFor(statusOptions, project.status)}
                        </Badge>
                      </div>

                      <div className="grid gap-3 text-sm text-slate-500 sm:grid-cols-2">
                        {phoneHref(project.client_phone) ? (
                          <a
                            className="inline-flex items-center gap-2 font-semibold text-slate-700 transition hover:text-blue-600"
                            href={phoneHref(project.client_phone)}
                          >
                            <Phone size={16} />
                            {project.client_name || "Клиент без имени"}
                          </a>
                        ) : (
                          <div className="font-semibold text-slate-700">{project.client_name || "Клиент не указан"}</div>
                        )}
                        <div className="flex items-center gap-2">
                          <MapPin size={16} />
                          {project.object_address || "Адрес не указан"}
                        </div>
                      </div>

                      {project.description && <div className="max-w-3xl text-sm leading-6 text-slate-600">{project.description}</div>}
                    </div>

                    <div className="grid min-w-[240px] gap-3 lg:grid-cols-2 xl:grid-cols-1">
                      <div className="rounded-[28px] bg-slate-50 px-5 py-4 ring-1 ring-slate-200/70">
                        <div className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Сумма</div>
                        <div className="mt-2 text-2xl font-black text-slate-900">{formatMoney(total)}</div>
                      </div>
                      <Button type="button" className="justify-center" onClick={() => openProject(project)}>
                        <Plus size={16} />
                        Открыть карточку
                      </Button>
                    </div>
                  </div>

                  {latestPayment && (
                    <div className="mt-6 rounded-[28px] bg-slate-900 px-5 py-4 text-sm text-white">
                      <div className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-300">Последняя операция</div>
                      <div className="mt-3 font-semibold">
                        {labelFor(PAYMENT_TYPE_OPTIONS, latestPayment.type)} • {formatMoney(latestPayment.amount)} ₽ • {formatDate(latestPayment.paid_at)}
                      </div>
                    </div>
                  )}
                </CardBody>
              </Card>
            );
          })}

          {filteredProjects.length === 0 && (
            <Card>
              <CardBody className="p-12 text-center">
                <div className="text-lg font-black tracking-tight text-slate-900">Проекты не найдены</div>
                <div className="mt-2 text-sm text-slate-500">Измените запрос или создайте новый проект.</div>
              </CardBody>
            </Card>
          )}
        </div>
      )}

      <Modal open={openCreate} title="Создать проект" onClose={closeCreateModal}>
        <form className="space-y-5" onSubmit={submitCreate}>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <Label>Наименование проекта</Label>
              <Input
                required
                value={createForm.title}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, title: event.target.value }))}
                placeholder="Например, Кухня и зеркала на Ленина"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>Клиент</Label>
              <Input
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                pattern="[0-9+()\\-\\s]*"
                value={createForm.client_query}
                onChange={(event) => handleCreateClientQuery(event.target.value)}
                placeholder="Введите телефон клиента"
              />
            </div>
            {createClientLookup.queryReady && (
              <div className="space-y-2 md:col-span-2">
                {selectedCreateClient ? (
                  <div className="flex items-center justify-between gap-3 rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-700">
                    <span>Выбран клиент: {selectedCreateClient.client_name || "Клиент без имени"}</span>
                    {phoneHref(selectedCreateClient.client_phone) && (
                      <a
                        className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-xs font-black text-blue-600"
                        href={phoneHref(selectedCreateClient.client_phone)}
                      >
                        <Phone size={13} />
                        Позвонить
                      </a>
                    )}
                  </div>
                ) : createClientLookup.matches.length > 0 ? (
                  createClientLookup.matches.map((client) => (
                    <button
                      key={client.key}
                      type="button"
                      onClick={() => applyClientFromSearch(client)}
                      className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left shadow-sm transition hover:border-blue-200 hover:bg-blue-50"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-black text-slate-800">{client.client_name || "Клиент без имени"}</span>
                        <span className="text-xs font-bold text-blue-600">Выбрать</span>
                      </div>
                      <div className="mt-1 text-sm text-slate-500">
                        {client.client_phone || "телефон не указан"} • {client.object_address || "адрес не указан"} • проектов: {client.project_count}
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="space-y-3 rounded-2xl border border-dashed border-slate-200 bg-white px-4 py-3">
                    <div className="text-sm font-semibold text-slate-500">
                      Клиент в базе не найден. Заполните имя, и карточка клиента создастся вместе с проектом.
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <Input
                        value={createForm.client_name}
                        onChange={(event) => setCreateForm((prev) => ({ ...prev, client_name: event.target.value }))}
                        autoComplete="name"
                        placeholder="Имя клиента"
                      />
                      <Input
                        type="tel"
                        inputMode="numeric"
                        autoComplete="tel"
                        pattern="[0-9+()\\-\\s]*"
                        value={createForm.client_phone}
                        onChange={(event) => setCreateForm((prev) => ({ ...prev, client_phone: event.target.value }))}
                        placeholder="+7..."
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="space-y-2 md:col-span-2">
              <Label>Адрес объекта</Label>
              <Input
                value={createForm.object_address}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, object_address: event.target.value }))}
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>Статус</Label>
              <Select
                value={createForm.status}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, status: event.target.value }))}
              >
                {statusOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>Сумма проекта</Label>
              <Input
                value={createForm.total_amount}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, total_amount: event.target.value }))}
                placeholder="Например, 120000"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Комментарий / описание</Label>
            <textarea
              className="min-h-28 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10"
              value={createForm.description}
              onChange={(event) => setCreateForm((prev) => ({ ...prev, description: event.target.value }))}
            />
          </div>

          {createError && <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{createError}</div>}

          <div className="flex justify-end gap-3">
            <Button type="button" variant="secondary" onClick={closeCreateModal}>
              Отмена
            </Button>
            <Button type="submit" disabled={createSaving}>
              {createSaving ? "Создаём..." : "Создать"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(activeProject)}
        title={activeProject ? `Карточка проекта — ${projectDisplayName(activeProject)}` : "Карточка проекта"}
        onClose={closeProject}
        widthClassName="max-w-5xl"
        bodyClassName="min-h-0"
        positionClassName="items-start pt-4 sm:pt-6"
      >
        {activeProject && (
          <div className="space-y-4">
            <div className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2 md:col-span-2">
                  <Label>Наименование проекта</Label>
                  <Input
                    value={detailForm.title}
                    onChange={(event) => setDetailForm((prev) => ({ ...prev, title: event.target.value }))}
                  />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label>Клиент</Label>
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                    {phoneHref(detailForm.client_phone) ? (
                      <a
                        className="inline-flex items-center gap-2 text-base font-black text-slate-900 transition hover:text-blue-600"
                        href={phoneHref(detailForm.client_phone)}
                      >
                        <Phone size={17} />
                        {detailForm.client_name || "Клиент без имени"}
                      </a>
                    ) : (
                      <div className="text-base font-black text-slate-900">{detailForm.client_name || "Клиент не указан"}</div>
                    )}
                    <div className="mt-1 text-xs font-semibold text-slate-400">
                      {phoneHref(detailForm.client_phone) ? "Нажмите на имя, чтобы позвонить клиенту." : "Телефон клиента не указан."}
                    </div>
                  </div>
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label>Адрес объекта</Label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      value={detailForm.object_address}
                      onChange={(event) => setDetailForm((prev) => ({ ...prev, object_address: event.target.value }))}
                      placeholder="Адрес, квартира, этаж"
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      className="shrink-0"
                      disabled={!routeUrl}
                      onClick={() => window.open(routeUrl, "_blank", "noopener,noreferrer")}
                    >
                      <MapPin size={16} />
                      Маршрут
                    </Button>
                  </div>
                  {cleanRouteAddress && cleanRouteAddress !== detailForm.object_address.trim() && (
                    <div className="ml-1 text-xs font-semibold text-slate-400">
                      Для Яндекс Карт: {cleanRouteAddress}
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <Label>Статус</Label>
                  <Select
                    value={detailForm.status}
                    onChange={(event) => setDetailForm((prev) => ({ ...prev, status: event.target.value }))}
                  >
                    {statusOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Сумма проекта</Label>
                  <Input
                    value={detailForm.total_amount}
                    onChange={(event) => setDetailForm((prev) => ({ ...prev, total_amount: event.target.value }))}
                    placeholder="Например, 120000"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Описание</Label>
                <textarea
                  className="min-h-20 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10"
                  value={detailForm.description}
                  onChange={(event) => setDetailForm((prev) => ({ ...prev, description: event.target.value }))}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-[24px] bg-slate-50 px-4 py-3 ring-1 ring-slate-200/70">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Финансы</div>
                      <div className="mt-1 text-xl font-black text-slate-900">{formatMoney(activeProjectPaymentTotal)} ₽</div>
                    </div>
                    <BadgeRussianRuble size={18} className="text-slate-400" />
                  </div>
                </div>

                <div className="rounded-[24px] bg-slate-50 px-4 py-3 ring-1 ring-slate-200/70">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Комментариев</div>
                      <div className="mt-1 text-xl font-black text-slate-900">{comments.length}</div>
                    </div>
                    <MessageSquare size={18} className="text-slate-400" />
                  </div>
                </div>

                <div className="rounded-[24px] bg-slate-50 px-4 py-3 ring-1 ring-slate-200/70">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Задач</div>
                      <div className="mt-1 text-xl font-black text-slate-900">{activeProjectTasks.length}</div>
                    </div>
                    <ListTodo size={18} className="text-slate-400" />
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-3 rounded-[24px] bg-slate-50 px-4 py-3 ring-1 ring-slate-200/70 sm:flex-row sm:items-center sm:justify-between">
                <div className={`text-sm font-bold ${detailAutosaveState === "error" ? "text-red-600" : "text-slate-500"}`}>
                  {autosaveStatusLabel(detailAutosaveState)}
                </div>
                <div className="flex flex-wrap gap-2">
                  {detailForm.works_with_contract ? (
                    <Button
                      type="button"
                      variant="secondary"
                      className="justify-center"
                      onClick={() => handleDocumentDownload("contract")}
                      disabled={documentLoading}
                    >
                      <FileText size={16} />
                      {documentLoading ? "Формируем..." : "Сформировать договор"}
                    </Button>
                  ) : null}
                  <Button type="button" variant="danger" className="justify-center" onClick={requestDeleteProject}>
                    <Trash2 size={16} />
                    Удалить проект
                  </Button>
                </div>
              </div>
            </div>

            {detailError && <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{detailError}</div>}

            <div className="flex flex-wrap gap-2 rounded-[28px] bg-slate-100 p-1">
              <Button
                type="button"
                variant={detailTab === "comments" ? "primary" : "ghost"}
                className="px-4"
                onClick={() => setDetailTab("comments")}
              >
                <MessageSquare size={16} />
                Комментарии
              </Button>
              <Button
                type="button"
                variant={detailTab === "tasks" ? "primary" : "ghost"}
                className="px-4"
                onClick={() => setDetailTab("tasks")}
              >
                <ListTodo size={16} />
                Задачи
              </Button>
              <Button
                type="button"
                variant={detailTab === "finances" ? "primary" : "ghost"}
                className="px-4"
                onClick={() => setDetailTab("finances")}
              >
                <Wallet size={16} />
                Финансы
              </Button>
            </div>

            {detailTab === "comments" ? (
              <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_380px]">
                <Card className="border border-slate-100 shadow-none ring-0">
                  <CardHeader>
                    <div className="text-lg font-black tracking-tight text-slate-900">Лента комментариев</div>
                    <div className="mt-1 text-sm text-slate-500">Все заметки по проекту в одном месте.</div>
                  </CardHeader>
                  <CardBody className="space-y-4">
                    {commentsLoading ? (
                      <div className="rounded-[24px] bg-slate-50 px-4 py-6 text-sm text-slate-500">Загружаем комментарии...</div>
                    ) : comments.length === 0 ? (
                      <div className="rounded-[24px] bg-slate-50 px-4 py-6 text-sm text-slate-500">
                        Пока нет комментариев. Добавьте первый комментарий справа.
                      </div>
                    ) : (
                      comments.map((comment) => (
                        <div key={comment.id} className="rounded-[24px] border border-slate-100 bg-slate-50 px-4 py-4">
                          <div className="flex items-start justify-between gap-4">
                            <div>
                              <div className="text-sm font-black text-slate-900">{comment.author_name || `Пользователь #${comment.author}`}</div>
                              <div className="mt-1 text-xs text-slate-400">{formatDateTime(comment.created_at)}</div>
                            </div>
                            <button
                              type="button"
                              className="rounded-full p-2 text-slate-400 transition hover:bg-white hover:text-red-600"
                              onClick={() => requestDeleteComment(comment.id)}
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                          <div className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-600">{comment.text}</div>
                        </div>
                      ))
                    )}
                  </CardBody>
                </Card>

                <Card className="border border-slate-100 shadow-none ring-0">
                  <CardHeader>
                    <div className="text-lg font-black tracking-tight text-slate-900">Новый комментарий</div>
                  </CardHeader>
                  <CardBody>
                    <form className="space-y-4" onSubmit={submitComment}>
                      <div className="space-y-2">
                        <Label>Текст комментария</Label>
                        <textarea
                          className="min-h-40 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10"
                          value={commentText}
                          onChange={(event) => setCommentText(event.target.value)}
                          placeholder="Например: согласовали замер на пятницу, ждём предоплату..."
                        />
                      </div>

                      {commentError && <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{commentError}</div>}

                      <Button type="submit" disabled={commentSaving}>
                        {commentSaving ? "Сохраняем..." : "Добавить комментарий"}
                      </Button>
                    </form>
                  </CardBody>
                </Card>
              </div>
            ) : detailTab === "tasks" ? (
              <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_360px]">
                <Card className="border border-slate-100 shadow-none ring-0">
                  <CardHeader>
                    <div className="text-lg font-black tracking-tight text-slate-900">Задачи по проекту</div>
                    <div className="mt-1 text-sm text-slate-500">Все задачи из этой вкладки также отображаются в общем модуле задач.</div>
                  </CardHeader>
                  <CardBody className="space-y-3">
                    {activeProjectTasks.length === 0 ? (
                      <div className="rounded-[24px] bg-slate-50 px-4 py-6 text-sm text-slate-500">
                        По этому проекту пока нет задач. Добавьте первую задачу справа.
                      </div>
                    ) : (
                      activeProjectTasks.map((task) => (
                        <ProjectTaskRow
                          key={task.id}
                          task={task}
                          onToggle={toggleProjectTask}
                          onDelete={requestDeleteTask}
                        />
                      ))
                    )}
                  </CardBody>
                </Card>

                <Card className="border border-slate-100 shadow-none ring-0">
                  <CardHeader>
                    <div className="text-lg font-black tracking-tight text-slate-900">Новая задача</div>
                  </CardHeader>
                  <CardBody>
                    <form className="space-y-4" onSubmit={submitTask}>
                      <div className="space-y-2">
                        <Label>Что нужно сделать</Label>
                        <Input
                          value={taskForm.title}
                          onChange={(event) => setTaskForm((prev) => ({ ...prev, title: event.target.value }))}
                          placeholder="Например, согласовать дату замера"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Комментарий</Label>
                        <textarea
                          className="min-h-28 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10"
                          value={taskForm.notes}
                          onChange={(event) => setTaskForm((prev) => ({ ...prev, notes: event.target.value }))}
                          placeholder="Коротко опишите следующий шаг"
                        />
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
                        <div className="space-y-2">
                          <Label>Срок</Label>
                          <Input
                            type="date"
                            value={taskForm.due_date}
                            onChange={(event) => setTaskForm((prev) => ({ ...prev, due_date: event.target.value }))}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Приоритет</Label>
                          <Select
                            value={taskForm.priority}
                            onChange={(event) => setTaskForm((prev) => ({ ...prev, priority: event.target.value }))}
                          >
                            <option value="low">Низкий</option>
                            <option value="medium">Средний</option>
                            <option value="high">Высокий</option>
                          </Select>
                        </div>
                      </div>

                      {taskError && <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{taskError}</div>}

                      <Button type="submit" disabled={taskSaving}>
                        <Plus size={16} />
                        {taskSaving ? "Добавляем..." : "Добавить задачу"}
                      </Button>
                    </form>
                  </CardBody>
                </Card>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="grid gap-4 md:grid-cols-3">
                  <StatCard icon={Wallet} label="Доходы" value={`${formatMoney(activeProjectFinanceStats.income)} ₽`} />
                  <StatCard icon={BadgeRussianRuble} label="Расходы" value={`${formatMoney(activeProjectFinanceStats.expense)} ₽`} />
                  <StatCard
                    icon={BadgeRussianRuble}
                    label="Маржа"
                    value={activeProjectMarginLabel}
                  />
                </div>

                <Card className="border border-slate-100 shadow-none ring-0">
                  <CardHeader>
                    <div className="text-lg font-black tracking-tight text-slate-900">Добавить операцию</div>
                    <div className="mt-1 text-sm text-slate-500">Операция сразу появится в карточке проекта и в разделе финансов.</div>
                  </CardHeader>
                  <CardBody>
                    <form className="space-y-4" onSubmit={submitPayment}>
                      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                        <div className="space-y-2">
                          <Label>Тип</Label>
                          <Select
                            value={paymentForm.type}
                            onChange={(event) => setPaymentForm((prev) => ({ ...prev, type: event.target.value }))}
                          >
                            {PAYMENT_TYPE_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label>Сумма</Label>
                          <Input
                            value={paymentForm.amount}
                            onChange={(event) => setPaymentForm((prev) => ({ ...prev, amount: event.target.value }))}
                            placeholder="25000"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Способ оплаты</Label>
                          <Select
                            value={paymentForm.method}
                            onChange={(event) => setPaymentForm((prev) => ({ ...prev, method: event.target.value }))}
                          >
                            {PAYMENT_METHOD_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label>Дата</Label>
                          <Input
                            type="datetime-local"
                            value={paymentForm.paid_at}
                            onChange={(event) => setPaymentForm((prev) => ({ ...prev, paid_at: event.target.value }))}
                          />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label>Комментарий к операции</Label>
                        <Input
                          value={paymentForm.comment}
                          onChange={(event) => setPaymentForm((prev) => ({ ...prev, comment: event.target.value }))}
                          placeholder="Например: предоплата по замеру"
                        />
                      </div>

                      {paymentError && <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{paymentError}</div>}

                      <Button type="submit" disabled={paymentSaving}>
                        {paymentSaving ? "Сохраняем..." : "Добавить операцию"}
                      </Button>
                    </form>
                  </CardBody>
                </Card>

                <Card className="border border-slate-100 shadow-none ring-0">
                  <CardHeader>
                    <div className="text-lg font-black tracking-tight text-slate-900">Журнал операций</div>
                  </CardHeader>
                  <CardBody>
                    {activeProjectPayments.length === 0 ? (
                      <div className="rounded-[24px] bg-slate-50 px-4 py-6 text-sm text-slate-500">
                        По этому проекту ещё нет операций.
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[760px] text-left text-sm">
                          <thead className="text-slate-400">
                            <tr>
                              <th className="pb-3 font-black uppercase tracking-[0.18em]">Дата</th>
                              <th className="pb-3 font-black uppercase tracking-[0.18em]">Тип</th>
                              <th className="pb-3 font-black uppercase tracking-[0.18em]">Сумма</th>
                              <th className="pb-3 font-black uppercase tracking-[0.18em]">Способ</th>
                              <th className="pb-3 font-black uppercase tracking-[0.18em]">Комментарий</th>
                              <th className="pb-3 text-right font-black uppercase tracking-[0.18em]">Действие</th>
                            </tr>
                          </thead>
                          <tbody>
                            {activeProjectPayments.map((payment) => {
                              const signedAmount = paymentSignedAmount(payment);
                              return (
                                <tr key={payment.id} className="border-t border-slate-100">
                                  <td className="py-4 text-slate-500">{formatDateTime(payment.paid_at)}</td>
                                  <td className="py-4">
                                    <Badge>{labelFor(PAYMENT_TYPE_OPTIONS, payment.type)}</Badge>
                                  </td>
                                  <td className={`py-4 font-semibold ${signedAmount < 0 ? "text-red-600" : "text-emerald-600"}`}>
                                    {signedAmount < 0 ? "−" : "+"} {formatMoney(Math.abs(signedAmount))} ₽
                                  </td>
                                  <td className="py-4 text-slate-500">{labelFor(PAYMENT_METHOD_OPTIONS, payment.method)}</td>
                                  <td className="py-4 text-slate-500">{payment.comment || "—"}</td>
                                  <td className="py-4 text-right">
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      className="px-3 text-red-600 hover:bg-red-50"
                                      onClick={() => requestDeletePayment(payment.id)}
                                    >
                                      <Trash2 size={16} />
                                      Удалить
                                    </Button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </CardBody>
                </Card>
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(confirmState)}
        title={confirmState?.title || "Подтвердите действие"}
        onClose={() => !confirmDeleting && setConfirmState(null)}
        widthClassName="max-w-xl"
      >
        <div className="space-y-5">
          <div className="rounded-[24px] bg-slate-50 px-4 py-4 text-sm leading-6 text-slate-600">
            {confirmState?.message}
          </div>

          <div className="flex justify-end gap-3">
            <Button type="button" variant="secondary" disabled={confirmDeleting} onClick={() => setConfirmState(null)}>
              Отмена
            </Button>
            <Button type="button" variant="danger" disabled={confirmDeleting} onClick={submitDeleteConfirmation}>
              {confirmDeleting ? "Удаляем..." : "Удалить"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
