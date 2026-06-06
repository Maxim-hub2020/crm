import React, { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  BadgeRussianRuble,
  CreditCard,
  FileText,
  LayoutGrid,
  List,
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
  deletePayment,
  deleteProject,
  deleteProjectComment,
  downloadProjectDocument,
  extractApiErrorMessage,
  fetchPayments,
  fetchProjectComments,
  fetchProjects,
  fetchProjectStatuses,
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

const CATEGORY_OPTIONS = [
  { value: "mirrors", label: "Зеркала" },
  { value: "furniture", label: "Мебель" },
  { value: "shower", label: "Душевые" },
];

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
    client_name: "",
    client_phone: "",
    client_email: "",
    object_address: "",
    description: "",
    categories: "mirrors",
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

function normalizeProjectForm(project, fallbackStatus = "active") {
  return {
    client_name: project?.client_name || "",
    client_phone: project?.client_phone || "",
    client_email: project?.client_email || "",
    object_address: project?.object_address || "",
    description: project?.description || "",
    categories: project?.categories || "mirrors",
    total_amount: project?.total_amount ? String(project.total_amount) : "",
    works_with_contract: Boolean(project?.works_with_contract),
    status: project?.status || fallbackStatus,
  };
}

function labelFor(options, value) {
  return options.find((option) => option.value === value)?.label || value;
}

function categoryBadges(csv) {
  const selected = new Set(
    (csv || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );

  return CATEGORY_OPTIONS.filter((item) => selected.has(item.value)).map((item) => item.label);
}

function formatMoney(value) {
  return moneyFormatter.format(Number(value || 0));
}

function normalizeSearchText(value) {
  return String(value || "").trim().toLowerCase();
}

function phoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
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

function ProjectKanbanCard({ project, amount, ageDays, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-[22px] border border-slate-200/90 bg-white px-4 py-4 text-left shadow-[0_10px_24px_rgba(15,23,42,0.06)] transition hover:-translate-y-0.5 hover:shadow-[0_14px_32px_rgba(15,23,42,0.08)]"
    >
      <div className="line-clamp-2 text-[1.02rem] font-black leading-6 tracking-tight text-slate-800">
        {project.client_name}
      </div>
      <div className="mt-1.5 text-sm text-slate-500">{project.client_phone || "Клиент не назначен"}</div>
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
  const [payments, setPayments] = useState([]);
  const [statusRows, setStatusRows] = useState(DEFAULT_STATUS_OPTIONS);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState(location.state?.q || "");
  const deferredQuery = useDeferredValue(query);
  const [viewMode, setViewMode] = useState(() => localStorage.getItem(VIEW_MODE_KEY) || "kanban");
  const [dragProjectId, setDragProjectId] = useState(null);

  const [openCreate, setOpenCreate] = useState(false);
  const [createForm, setCreateForm] = useState(createEmptyProjectForm());
  const [createSaving, setCreateSaving] = useState(false);
  const [createError, setCreateError] = useState("");

  const [activeProjectId, setActiveProjectId] = useState(null);
  const [detailForm, setDetailForm] = useState(createEmptyProjectForm());
  const [detailTab, setDetailTab] = useState("comments");
  const [detailSaving, setDetailSaving] = useState(false);
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
      const [projectRows, paymentRows, statusItems] = await Promise.all([
        fetchProjects(),
        fetchPayments(),
        fetchProjectStatuses(),
      ]);

      setProjects(projectRows);
      setPayments(paymentRows);
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
      setPayments([]);
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
    const map = new Map();

    for (const project of projects) {
      const digits = phoneDigits(project.client_phone);
      const fallbackKey = normalizeSearchText(project.client_name);
      const key = digits || fallbackKey;
      if (!key) continue;

      const current = map.get(key) || {
        key,
        client_name: project.client_name || "",
        client_phone: project.client_phone || "",
        client_email: project.client_email || "",
        object_address: project.object_address || "",
        works_with_contract: Boolean(project.works_with_contract),
        project_count: 0,
        latest_project_id: project.id,
        latest_project_name: project.client_name || "",
        updated_at: project.updated_at || project.created_at || "",
        searchText: "",
        phoneDigits: digits,
      };

      current.project_count += 1;

      const currentDate = new Date(current.updated_at || 0).getTime();
      const nextDate = new Date(project.updated_at || project.created_at || 0).getTime();
      if (nextDate >= currentDate) {
        current.client_name = project.client_name || current.client_name;
        current.client_phone = project.client_phone || current.client_phone;
        current.client_email = project.client_email || current.client_email;
        current.object_address = project.object_address || current.object_address;
        current.works_with_contract = Boolean(project.works_with_contract);
        current.latest_project_id = project.id;
        current.latest_project_name = project.client_name || current.latest_project_name;
        current.updated_at = project.updated_at || project.created_at || current.updated_at;
        current.phoneDigits = phoneDigits(project.client_phone) || current.phoneDigits;
      }

      current.searchText = normalizeSearchText(
        [
          current.client_name,
          current.client_phone,
          current.client_email,
          current.object_address,
          current.latest_project_name,
        ]
          .filter(Boolean)
          .join(" ")
      );
      map.set(key, current);
    }

    return Array.from(map.values()).sort((left, right) => (right.updated_at || "").localeCompare(left.updated_at || ""));
  }, [projects]);

  const createClientLookup = useMemo(() => {
    const textQuery = normalizeSearchText(`${createForm.client_name} ${createForm.client_phone}`);
    const digitsQuery = phoneDigits(createForm.client_phone || createForm.client_name);
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
  }, [clientDirectory, createForm.client_name, createForm.client_phone, openCreate]);

  const filteredProjects = useMemo(() => {
    const value = deferredQuery.trim().toLowerCase();
    if (!value) return projects;

    return projects.filter((project) =>
      [project.client_name, project.client_phone, project.object_address, project.description]
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

  const activeProjectPayments = useMemo(() => {
    if (!activeProjectId) return [];
    return paymentsByProject.get(activeProjectId) || [];
  }, [activeProjectId, paymentsByProject]);

  const activeProjectPaymentTotal = useMemo(
    () => activeProjectPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0),
    [activeProjectPayments]
  );

  useEffect(() => {
    if (!activeProject) {
      return;
    }

    setDetailForm(normalizeProjectForm(activeProject, defaultStatusValue));
    setDetailError("");
  }, [activeProject, defaultStatusValue]);

  useEffect(() => {
    if (!activeProjectId) {
      setComments([]);
      setCommentText("");
      setCommentError("");
      setPaymentForm(createEmptyPaymentForm());
      setPaymentError("");
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
      client_name: client.client_name || prev.client_name,
      client_phone: client.client_phone || prev.client_phone,
      client_email: client.client_email || prev.client_email,
      object_address: client.object_address || prev.object_address,
      works_with_contract: Boolean(client.works_with_contract),
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
  }

  async function submitCreate(event) {
    event.preventDefault();
    setCreateError("");
    setCreateSaving(true);

    try {
      if (!createForm.client_name.trim()) {
        setCreateError("Укажите клиента или название проекта.");
        return;
      }

      const created = await createProject({
        client_name: createForm.client_name.trim(),
        client_phone: createForm.client_phone.trim(),
        client_email: createForm.client_email.trim() || undefined,
        object_address: createForm.object_address.trim(),
        description: createForm.description.trim(),
        categories: createForm.categories,
        status: createForm.status,
        total_amount: createForm.total_amount.trim() ? createForm.total_amount.trim() : null,
        works_with_contract: createForm.works_with_contract,
      });

      setProjects((prev) => [created, ...prev]);
      closeCreateModal();
      openProject(created);
    } catch (error) {
      setCreateError(extractApiErrorMessage(error, "Не удалось создать проект."));
    } finally {
      setCreateSaving(false);
    }
  }

  async function submitProjectUpdate() {
    if (!activeProject) return;

    setDetailError("");
    setDetailSaving(true);

    try {
      if (!detailForm.client_name.trim()) {
        setDetailError("Укажите клиента или название проекта.");
        return;
      }

      const updated = await updateProject(activeProject.id, {
        client_name: detailForm.client_name.trim(),
        client_phone: detailForm.client_phone.trim(),
        client_email: detailForm.client_email.trim(),
        object_address: detailForm.object_address.trim(),
        description: detailForm.description.trim(),
        categories: detailForm.categories,
        status: detailForm.status,
        total_amount: detailForm.total_amount.trim() ? detailForm.total_amount.trim() : null,
        works_with_contract: detailForm.works_with_contract,
      });

      setProjects((prev) => prev.map((project) => (project.id === updated.id ? updated : project)));
    } catch (error) {
      setDetailError(extractApiErrorMessage(error, "Не удалось сохранить проект."));
    } finally {
      setDetailSaving(false);
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

  async function handleProjectDelete() {
    if (!activeProject) return;

    try {
      await deleteProject(activeProject.id);
      setProjects((prev) => prev.filter((project) => project.id !== activeProject.id));
      setPayments((prev) => prev.filter((payment) => payment.project !== activeProject.id));
      closeProject();
    } catch (error) {
      setDetailError(extractApiErrorMessage(error, "Не удалось удалить проект."));
    }
  }

  async function handleDocumentDownload(documentType = "contract") {
    if (!activeProject) return;

    if (documentType === "contract" && !detailForm.works_with_contract) {
      setDetailError("Сначала включите признак «Работает по договору» и сохраните проект.");
      return;
    }

    setDetailError("");
    setDocumentLoading(true);

    try {
      const { blob, headers } = await downloadProjectDocument(activeProject.id, documentType);
      const documentName = documentType === "contract" ? "dogovor" : "akt";
      const fallback = `${documentName}-${sanitizeFileName(activeProject.client_name)}.pdf`;
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
      message: `Проект «${activeProject.client_name}» будет удалён вместе с операциями и комментариями.`,
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

  function handleDrop(status) {
    if (!dragProjectId) return;
    moveProjectToStatus(dragProjectId, status).catch(() => {});
    setDragProjectId(null);
  }

  return (
    <div className="space-y-6">
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
        <div className="overflow-x-auto pb-3">
          <div className="grid min-w-max grid-flow-col auto-cols-[minmax(328px,396px)] gap-5">
          {statusOptions.map((status) => {
            const columnProjects = groupedProjects[status.value] || [];
            const columnTotal = columnProjects.reduce((sum, project) => {
              return sum + projectAmount(project, paymentsByProject);
            }, 0);

            return (
              <div
                key={status.value}
                className="flex min-h-[602px] flex-col overflow-hidden rounded-[28px] border border-slate-200/90 bg-white shadow-[0_14px_36px_rgba(15,23,42,0.05)]"
              >
                <ColumnHeader status={status} count={columnProjects.length} totalAmount={columnTotal} />

                <div
                  className="flex min-h-[468px] flex-1 flex-col gap-3 bg-[#fbfcff] px-3 py-3"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => handleDrop(status.value)}
                >
                  <div className="space-y-3">
                    {columnProjects.map((project) => {
                      const amount = projectAmount(project, paymentsByProject);
                      const ageDays = daysInWork(project.updated_at || project.created_at);

                      return (
                        <div
                          key={project.id}
                          draggable
                          onDragStart={() => setDragProjectId(project.id)}
                          onDragEnd={() => setDragProjectId(null)}
                        >
                          <ProjectKanbanCard
                            project={project}
                            amount={amount}
                            ageDays={ageDays}
                            onClick={() => openProject(project)}
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
                        <div className="text-2xl font-black tracking-tight text-slate-900">{project.client_name}</div>
                        <Badge className={statusBadgeClass(statusMeta?.color || project.status)}>
                          {labelFor(statusOptions, project.status)}
                        </Badge>
                      </div>

                      <div className="grid gap-3 text-sm text-slate-500 sm:grid-cols-2">
                        <div className="flex items-center gap-2">
                          <Phone size={16} />
                          {project.client_phone || "Телефон не указан"}
                        </div>
                        <div className="flex items-center gap-2">
                          <MapPin size={16} />
                          {project.object_address || "Адрес не указан"}
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {categoryBadges(project.categories).map((item) => (
                          <Badge key={`${project.id}-${item}`}>{item}</Badge>
                        ))}
                      </div>

                      {project.description && <div className="max-w-3xl text-sm leading-6 text-slate-600">{project.description}</div>}
                    </div>

                    <div className="grid min-w-[280px] gap-3 lg:grid-cols-3 xl:grid-cols-1">
                      <div className="rounded-[28px] bg-slate-50 px-5 py-4 ring-1 ring-slate-200/70">
                        <div className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Операций</div>
                        <div className="mt-2 text-2xl font-black text-slate-900">{rows.length}</div>
                      </div>
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
            <div className="space-y-2">
              <Label>Клиент / проект</Label>
              <Input
                required
                value={createForm.client_name}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, client_name: event.target.value }))}
                autoComplete="name"
                placeholder="Начните вводить имя или проект"
              />
            </div>
            <div className="space-y-2">
              <Label>Телефон</Label>
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
            <div className="space-y-2 md:col-span-2">
              <div className="rounded-[24px] border border-slate-200 bg-slate-50/80 p-3">
                <div className="flex items-center justify-between gap-3 px-1">
                  <div>
                    <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-400">Проверка клиента</div>
                    <div className="mt-1 text-sm font-semibold text-slate-600">
                      Поиск идет по телефону, имени и адресу среди уже созданных проектов.
                    </div>
                  </div>
                  {createClientLookup.queryReady ? (
                    <Badge className={createClientLookup.matches.length ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}>
                      {createClientLookup.matches.length ? `Найдено: ${createClientLookup.matches.length}` : "Новый"}
                    </Badge>
                  ) : null}
                </div>

                {createClientLookup.queryReady && (
                  <div className="mt-3 space-y-2">
                    {createClientLookup.matches.length > 0 ? (
                      createClientLookup.matches.map((client) => (
                        <button
                          key={client.key}
                          type="button"
                          onClick={() => applyClientFromSearch(client)}
                          className="w-full rounded-2xl border border-white bg-white px-4 py-3 text-left shadow-sm transition hover:border-blue-200 hover:bg-blue-50"
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
                      <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-500">
                        Клиент в базе не найден. При создании проекта он будет добавлен как новый.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>Адрес объекта</Label>
              <Input
                value={createForm.object_address}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, object_address: event.target.value }))}
              />
            </div>
            <div className="space-y-2">
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
            <div className="space-y-2">
              <Label>Категория</Label>
              <Select
                value={createForm.categories}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, categories: event.target.value }))}
              >
                {CATEGORY_OPTIONS.map((option) => (
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
            <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 md:col-span-2">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300 text-blue-600"
                checked={createForm.works_with_contract}
                onChange={(event) =>
                  setCreateForm((prev) => ({ ...prev, works_with_contract: event.target.checked }))
                }
              />
              <span>
                <span className="block text-sm font-bold text-slate-800">Работает по договору</span>
                <span className="text-xs text-slate-500">
                  Для таких клиентов можно сформировать договор из PDF-шаблона в разделе «Система».
                </span>
              </span>
            </label>
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
        title={activeProject ? `Карточка проекта — ${activeProject.client_name}` : "Карточка проекта"}
        onClose={closeProject}
        widthClassName="max-w-6xl"
        bodyClassName="max-h-[82vh] overflow-y-auto"
      >
        {activeProject && (
          <div className="space-y-6">
            <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_360px]">
              <div className="space-y-5">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Клиент / проект</Label>
                    <Input
                      value={detailForm.client_name}
                      onChange={(event) => setDetailForm((prev) => ({ ...prev, client_name: event.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Телефон</Label>
                    <Input
                      type="tel"
                      inputMode="numeric"
                      autoComplete="tel"
                      pattern="[0-9+()\\-\\s]*"
                      value={detailForm.client_phone}
                      onChange={(event) => setDetailForm((prev) => ({ ...prev, client_phone: event.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Email</Label>
                    <Input
                      value={detailForm.client_email}
                      onChange={(event) => setDetailForm((prev) => ({ ...prev, client_email: event.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Адрес объекта</Label>
                    <Input
                      value={detailForm.object_address}
                      onChange={(event) => setDetailForm((prev) => ({ ...prev, object_address: event.target.value }))}
                    />
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
                    <Label>Категория</Label>
                    <Select
                      value={detailForm.categories}
                      onChange={(event) => setDetailForm((prev) => ({ ...prev, categories: event.target.value }))}
                    >
                      {CATEGORY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label>Сумма проекта</Label>
                    <Input
                      value={detailForm.total_amount}
                      onChange={(event) => setDetailForm((prev) => ({ ...prev, total_amount: event.target.value }))}
                      placeholder="Например, 120000"
                    />
                  </div>
                  <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 md:col-span-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 text-blue-600"
                      checked={detailForm.works_with_contract}
                      onChange={(event) =>
                        setDetailForm((prev) => ({ ...prev, works_with_contract: event.target.checked }))
                      }
                    />
                    <span>
                      <span className="block text-sm font-bold text-slate-800">Работает по договору</span>
                      <span className="text-xs text-slate-500">
                        После сохранения можно сформировать договор по загруженному PDF-шаблону.
                      </span>
                    </span>
                  </label>
                </div>

                <div className="space-y-2">
                  <Label>Описание</Label>
                  <textarea
                    className="min-h-32 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10"
                    value={detailForm.description}
                    onChange={(event) => setDetailForm((prev) => ({ ...prev, description: event.target.value }))}
                  />
                </div>
              </div>

              <div className="space-y-4">
                <div className="rounded-[28px] bg-slate-900 px-5 py-5 text-white">
                  <div className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-300">Проект</div>
                  <div className="mt-3 text-2xl font-black">{activeProject.client_name}</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Badge className="bg-white/15 text-white">{labelFor(statusOptions, detailForm.status)}</Badge>
                    {categoryBadges(detailForm.categories).map((item) => (
                      <Badge key={`modal-${item}`} className="bg-white/15 text-white">
                        {item}
                      </Badge>
                    ))}
                    {detailForm.works_with_contract && <Badge className="bg-white/15 text-white">Договор</Badge>}
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                  <div className="rounded-[28px] bg-slate-50 px-5 py-4 ring-1 ring-slate-200/70">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Операций</div>
                        <div className="mt-2 text-2xl font-black text-slate-900">{activeProjectPayments.length}</div>
                      </div>
                      <CreditCard size={18} className="text-slate-400" />
                    </div>
                  </div>

                  <div className="rounded-[28px] bg-slate-50 px-5 py-4 ring-1 ring-slate-200/70">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Финансы</div>
                        <div className="mt-2 text-2xl font-black text-slate-900">{formatMoney(activeProjectPaymentTotal)}</div>
                      </div>
                      <BadgeRussianRuble size={18} className="text-slate-400" />
                    </div>
                  </div>

                  <div className="rounded-[28px] bg-slate-50 px-5 py-4 ring-1 ring-slate-200/70">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Комментариев</div>
                        <div className="mt-2 text-2xl font-black text-slate-900">{comments.length}</div>
                      </div>
                      <MessageSquare size={18} className="text-slate-400" />
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  {detailForm.works_with_contract ? (
                    <Button
                      type="button"
                      variant="secondary"
                      className="w-full justify-center"
                      onClick={() => handleDocumentDownload("contract")}
                      disabled={documentLoading}
                    >
                      <FileText size={16} />
                      {documentLoading ? "Формируем..." : "Сформировать договор"}
                    </Button>
                  ) : null}
                  <Button type="button" className="w-full justify-center" onClick={submitProjectUpdate} disabled={detailSaving}>
                    {detailSaving ? "Сохраняем..." : "Сохранить изменения"}
                  </Button>
                  <Button type="button" variant="danger" className="w-full justify-center" onClick={requestDeleteProject}>
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
            ) : (
              <div className="space-y-6">
                <div className="grid gap-4 md:grid-cols-3">
                  <StatCard icon={CreditCard} label="Операций" value={activeProjectPayments.length} dark />
                  <StatCard icon={Wallet} label="Сумма" value={formatMoney(activeProjectPaymentTotal)} />
                  <StatCard
                    icon={BadgeRussianRuble}
                    label="Проект"
                    value={detailForm.total_amount ? formatMoney(detailForm.total_amount) : "—"}
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
                            {activeProjectPayments.map((payment) => (
                              <tr key={payment.id} className="border-t border-slate-100">
                                <td className="py-4 text-slate-500">{formatDateTime(payment.paid_at)}</td>
                                <td className="py-4">
                                  <Badge>{labelFor(PAYMENT_TYPE_OPTIONS, payment.type)}</Badge>
                                </td>
                                <td className="py-4 font-semibold text-slate-900">{formatMoney(payment.amount)}</td>
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
                            ))}
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
