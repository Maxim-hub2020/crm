import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Calendar,
  Check,
  Link,
  Copy,
  FileText,
  FolderOpen,
  Gift,
  History,
  LayoutGrid,
  List,
  ListTodo,
  Mail,
  MapPin,
  MessageSquare,
  Paperclip,
  Pencil,
  Phone,
  Plus,
  Search,
  Ticket,
  Trash2,
  Users,
  Wallet,
} from "lucide-react";
import { useLocation } from "react-router-dom";

import {
  createPayment,
  createClient,
  createProject,
  createProjectComment,
  createProjectYandexDiskFolder,
  createTask,
  deletePayment,
  deleteProject,
  deleteProjectComment,
  deleteTask,
  downloadProjectDocument,
  extractApiErrorMessage,
  fetchAddressSuggestions,
  fetchAccounts,
  fetchClients,
  fetchFinanceCategories,
  fetchPayments,
  fetchProjectActivity,
  fetchProjectComments,
  fetchProjectCustomFields,
  fetchProjects,
  fetchProjectStatusChecks,
  fetchProjectStatuses,
  fetchTasks,
  hasDadataAddressSuggestions,
  previewBonusPromo,
  updateClient,
  updatePayment,
  updateTask,
  updateProject,
  updateProjectComment,
  uploadProjectCustomFieldFile,
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
import ClientAddressFields from "../components/ClientAddressFields.jsx";
import { clientPhoneValidationError, formatRussianPhoneInput, normalizeOptionalClientPhone, phoneDigits, phoneSearchDigits } from "../utils/phone.js";

const VIEW_MODE_KEY = "crm_projects_view_mode";
const PROJECT_DRAG_HOLD_MS = 1500;
const PROJECT_DRAG_MOVE_CANCEL_PX = 12;

const DEFAULT_STATUS_OPTIONS = [
  { value: "active", label: "В работе", short: "Работа", color: "sky", is_default: true },
  { value: "closed", label: "Завершено", short: "Готово", color: "emerald", is_default: false },
  { value: "canceled", label: "Отменено", short: "Стоп", color: "rose", is_default: false },
];

const moneyFormatter = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
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
    object_lat: "",
    object_lon: "",
    apartment: "",
    entrance: "",
    floor: "",
    description: "",
    total_amount: "",
    bonus_promo_code: "",
    custom_fields: {},
    works_with_contract: false,
    status,
  };
}

function createEmptyPaymentForm() {
  return {
    category_kind: "",
    category: "",
    account: "",
    amount: "",
    comment: "",
    paid_at: todayDateValue(),
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

function createClientEditForm(client = {}) {
  return {
    name: client.name || client.client_name || "",
    contract_full_name: client.contract_full_name || "",
    phone: client.phone || client.client_phone || "",
    email: client.email || client.client_email || "",
    address: client.address || client.object_address || "",
    address_lat: client.address_lat || client.object_lat || "",
    address_lon: client.address_lon || client.object_lon || "",
    apartment: client.apartment || "",
    floor: client.floor || "",
    works_with_contract: Boolean(client.works_with_contract ?? client.worksWithContract),
  };
}

function buildProjectUpdatePayload(form) {
  return {
    title: form.title.trim(),
    client_name: form.client_name.trim(),
    client_phone: normalizeOptionalClientPhone(form.client_phone) || form.client_phone.trim(),
    client_email: form.client_email.trim(),
    object_address: form.object_address.trim(),
    object_lat: form.object_lat.trim() || null,
    object_lon: form.object_lon.trim() || null,
    apartment: form.apartment.trim(),
    entrance: form.entrance.trim(),
    floor: form.floor.trim(),
    description: form.description.trim(),
    categories: "",
    status: form.status,
    total_amount: cleanAmountValue(form.total_amount) || null,
    bonus_promo_code: normalizePromoCodeInput(form.bonus_promo_code),
    custom_fields: normalizeCustomFieldValues(form.custom_fields),
  };
}

function normalizeCustomFieldValues(values = {}) {
  if (!values || typeof values !== "object") return {};

  return Object.fromEntries(
    Object.entries(values)
      .map(([key, value]) => {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const cleanValue = {
            name: String(value.name || value.original_name || "").trim(),
            original_name: String(value.original_name || value.name || "").trim(),
            url: String(value.url || "").trim(),
            path: String(value.path || "").trim(),
            content_type: String(value.content_type || "").trim(),
            size: Number(value.size || 0) || 0,
          };
          return [String(key), cleanValue];
        }
        return [String(key), String(value ?? "").trim()];
      })
      .filter(([, value]) => {
        if (value && typeof value === "object") {
          return Boolean(value.name || value.original_name || value.url || value.path);
        }
        return Boolean(value);
      })
  );
}

function normalizeProjectForm(project, fallbackStatus = "active") {
  const clientInfo = project?.client_info || {};
  return {
    title: project?.title || "",
    client: project?.client || clientInfo.id || "",
    client_query: clientInfo.phone || project?.client_phone || clientInfo.name || project?.client_name || "",
    client_name: clientInfo.name || project?.client_name || "",
    client_phone: clientInfo.phone || project?.client_phone || "",
    client_email: clientInfo.email ?? project?.client_email ?? "",
    object_address: project?.object_address || clientInfo.address || "",
    object_lat: project?.object_lat || "",
    object_lon: project?.object_lon || "",
    apartment: project?.apartment || "",
    entrance: project?.entrance || "",
    floor: project?.floor || "",
    description: project?.description || "",
    total_amount: formatAmountInput(project?.total_amount || ""),
    bonus_promo_code: project?.bonus_promo_code || "",
    custom_fields: normalizeCustomFieldValues(project?.custom_fields || {}),
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

function ClientInfoTile({ icon: Icon, label, value, href, onClick }) {
  const content = (
    <>
      <Icon size={16} className="shrink-0 text-slate-400" />
      <div className="min-w-0">
        <div className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">{label}</div>
        <div className="mt-1 truncate text-sm font-semibold text-slate-800">{value || "Не указано"}</div>
      </div>
    </>
  );

  if (href && value) {
    return (
      <a className="flex items-center gap-3 rounded-2xl bg-slate-50 px-4 py-3 transition hover:bg-blue-50" href={href}>
        {content}
      </a>
    );
  }

  if (onClick && value) {
    return (
      <button
        type="button"
        className="flex w-full items-center gap-3 rounded-2xl bg-slate-50 px-4 py-3 text-left transition hover:bg-blue-50"
        onClick={onClick}
      >
        {content}
      </button>
    );
  }

  return <div className="flex items-center gap-3 rounded-2xl bg-slate-50 px-4 py-3">{content}</div>;
}

function cleanAmountValue(value) {
  const normalized = String(value || "").trim().replace(/\s+/g, "").replace(",", ".");
  const decimalMatch = normalized.match(/^(\d+)[.](\d{1,2})$/);
  const source = decimalMatch ? decimalMatch[1] : normalized;
  return source.replace(/\D/g, "");
}

function formatAmountInput(value) {
  const digits = cleanAmountValue(value);
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function normalizePromoCodeInput(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 5);
}

function projectDisplayName(project) {
  return project?.title || project?.client_name || `Проект #${project?.id || ""}`;
}

function projectOrderLabel(project) {
  if (project?.order_number_label) return project.order_number_label;
  if (project?.order_number) return String(project.order_number).padStart(4, "0");
  return "";
}

function normalizeSearchText(value) {
  return String(value || "").trim().toLowerCase();
}

function phoneHref(value) {
  const normalized = String(value || "").replace(/[^\d+]/g, "");
  return normalized ? `tel:${normalized}` : "";
}

function maxMessengerPhone(value) {
  const digits = phoneDigits(value);
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith("7")) return digits;
  return "";
}

function maxMessengerHref(project, form) {
  const clientName = String(form?.client_name || project?.client_name || "").trim();
  const clientPhone = String(form?.client_phone || project?.client_phone || "").trim();
  const maxPhone = maxMessengerPhone(clientPhone);
  const projectTitle = String(form?.title || project?.title || "").trim();
  const orderLabel = projectOrderLabel(project);
  const projectLabel = [orderLabel ? `№${orderLabel}` : "", projectTitle].filter(Boolean).join(" · ");
  const greeting = clientName ? `Здравствуйте, ${clientName}!` : "Здравствуйте!";
  const messageParts = [
    greeting,
    `Пишу по проекту${projectLabel ? ` ${projectLabel}` : ""}.`,
  ].filter(Boolean);
  const params = new URLSearchParams({
    phone: maxPhone,
    text: messageParts.join("\n"),
  });

  return maxPhone ? `https://web.max.ru/chat?${params.toString()}` : "";
}

function formatClientLookupInput(value) {
  const raw = String(value || "");
  const digits = phoneDigits(raw);
  if (digits.length === 1 && (digits === "7" || digits === "8")) {
    return "+7-";
  }
  return /[A-Za-zА-Яа-яЁё]/.test(raw) ? raw : formatRussianPhoneInput(raw);
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

function yandexRouteLinks(address, lat = "", lon = "") {
  const cleanAddress = cleanAddressForMaps(address);
  const cleanLat = String(lat || "").trim();
  const cleanLon = String(lon || "").trim();
  const latNumber = Number(cleanLat);
  const lonNumber = Number(cleanLon);
  const hasCoordinates = Number.isFinite(latNumber) && Number.isFinite(lonNumber);
  const destination = hasCoordinates ? `${cleanLat},${cleanLon}` : cleanAddress;
  if (!destination) return { webUrl: "", appUrls: [], hasCoordinates: false };

  const routeText = `~${destination}`;
  const params = new URLSearchParams({
    mode: "routes",
    rtext: routeText,
    rtt: "auto",
  });
  if (hasCoordinates) {
    params.set("ll", `${cleanLon},${cleanLat}`);
    params.set("z", "16");
  }
  if (cleanAddress) {
    params.set("text", cleanAddress);
  }

  const appUrls = [];
  appUrls.push(`yandexmaps://maps.yandex.ru/?${params.toString()}`);
  if (hasCoordinates) {
    const navigatorParams = new URLSearchParams({
      lat_to: cleanLat,
      lon_to: cleanLon,
    });
    if (cleanAddress) {
      navigatorParams.set("text", cleanAddress);
    }
    appUrls.push(`yandexnavi://build_route_on_map?${navigatorParams.toString()}`);
  }

  return {
    webUrl: `https://yandex.ru/maps/?${params.toString()}`,
    appUrls,
    hasCoordinates,
    destination,
    cleanAddress,
    lat: cleanLat,
    lon: cleanLon,
  };
}

function yandexRouteLinksWithOrigin(links, origin) {
  if (!links?.destination || !origin?.lat || !origin?.lon) return links;

  const routeText = `${origin.lat},${origin.lon}~${links.destination}`;
  const params = new URLSearchParams({
    mode: "routes",
    rtext: routeText,
    rtt: "auto",
  });
  if (links.hasCoordinates && links.lat && links.lon) {
    params.set("ll", `${links.lon},${links.lat}`);
    params.set("z", "16");
  }
  if (links.cleanAddress) {
    params.set("text", links.cleanAddress);
  }

  const appUrls = [`yandexmaps://maps.yandex.ru/?${params.toString()}`];
  if (links.hasCoordinates && links.lat && links.lon) {
    const navigatorParams = new URLSearchParams({
      lat_to: links.lat,
      lon_to: links.lon,
    });
    appUrls.push(`yandexnavi://build_route_on_map?${navigatorParams.toString()}`);
  }

  return {
    ...links,
    webUrl: `https://yandex.ru/maps/?${params.toString()}`,
    appUrls,
  };
}

function getCurrentRouteOrigin() {
  if (!navigator.geolocation) return Promise.resolve(null);

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          lat: String(position.coords.latitude),
          lon: String(position.coords.longitude),
        });
      },
      () => resolve(null),
      { enableHighAccuracy: false, maximumAge: 60000, timeout: 2500 }
    );
  });
}

function openYandexRouteLinks(links) {
  if (!links?.webUrl) return;

  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
  if (isMobile && links.hasCoordinates) {
    getCurrentRouteOrigin().then((origin) => {
      openPreparedYandexRouteLinks(origin ? yandexRouteLinksWithOrigin(links, origin) : links);
    });
    return;
  }

  openPreparedYandexRouteLinks(links);
}

function openPreparedYandexRouteLinks(links) {
  const appUrls = Array.isArray(links.appUrls) ? links.appUrls.filter(Boolean) : [];
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
  if (!isMobile || appUrls.length === 0) {
    window.open(links.webUrl, "_blank", "noopener,noreferrer");
    return;
  }

  let appOpened = false;
  const handleVisibilityChange = () => {
    if (document.hidden) appOpened = true;
  };

  document.addEventListener("visibilitychange", handleVisibilityChange, { once: true });
  window.location.href = appUrls[0];

  window.setTimeout(() => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    if (!appOpened) {
      window.location.href = links.webUrl;
    }
  }, 900);
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

const PROJECT_ACTIVITY_LABELS = {
  create: "Создание",
  update: "Изменение",
  delete: "Удаление",
  create_comment: "Комментарий",
  update_comment: "Изменение комментария",
  delete_comment: "Удаление комментария",
  create_payment: "Финансы",
  update_payment: "Изменение операции",
  delete_payment: "Удаление операции",
  create_task: "Задача",
  update_task: "Изменение задачи",
  delete_task: "Удаление задачи",
};

function projectActivityLabel(event) {
  return event?.title || PROJECT_ACTIVITY_LABELS[event?.action] || PROJECT_ACTIVITY_LABELS[event?.type] || "Событие";
}

function projectCheckToneClass(severity) {
  if (severity === "critical") return "bg-red-50 text-red-700 ring-red-100";
  if (severity === "warning") return "bg-amber-50 text-amber-700 ring-amber-100";
  return "bg-blue-50 text-blue-700 ring-blue-100";
}

function todayDateValue() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

function toDateInputValue(value) {
  if (!value) return todayDateValue();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10) || todayDateValue();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

function toPaymentDateTime(value) {
  return value ? `${value}T12:00:00` : undefined;
}

function isPastDateValue(value) {
  return Boolean(value && value < todayDateValue());
}

function isPaymentDateChanged(payment, nextDate) {
  if (!payment) return true;
  return toDateInputValue(payment.paid_at) !== nextDate;
}

function isFuturePayment(payment) {
  return toDateInputValue(payment?.paid_at) > todayDateValue();
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
  if (plannedAmount > 0) return Math.max(0, plannedAmount - projectReferralBonus(project));

  const rows = paymentsByProject.get(project.id) || [];
  return rows.reduce((sum, payment) => sum + paymentSignedAmount(payment), 0);
}

function projectReferralBonus(project) {
  const plannedAmount = Number(project?.total_amount || 0);
  const bonusAmount = Number(project?.referral_bonus_used || 0);
  if (plannedAmount <= 0 || bonusAmount <= 0) return 0;
  return Math.min(plannedAmount, bonusAmount);
}

function projectDiscountedAmount(project) {
  return Math.max(0, Number(project?.total_amount || 0) - projectReferralBonus(project));
}

function paymentOperationKind(payment) {
  if (payment?.category_type === "expense") return "expense";
  if (payment?.category_type === "income") return "income";
  return payment?.type === "refund" || payment?.type === "correction" ? "expense" : "income";
}

function paymentDisplaySignedAmount(payment) {
  const amount = Number(payment?.amount || 0);
  return paymentOperationKind(payment) === "expense" ? -amount : amount;
}

function paymentSignedAmount(payment) {
  if (isFuturePayment(payment)) return 0;
  return paymentDisplaySignedAmount(payment);
}

function buildProjectFinanceSummary(project, payments = []) {
  const projectTotal = projectDiscountedAmount(project);
  const currentPayments = payments.filter((payment) => !isFuturePayment(payment));
  const futurePayments = payments.length - currentPayments.length;

  const totals = currentPayments.reduce(
    (acc, payment) => {
      const amount = Number(payment?.amount || 0);
      if (paymentOperationKind(payment) === "expense") {
        acc.expenses += amount;
      } else {
        acc.income += amount;
      }
      return acc;
    },
    { income: 0, expenses: 0 }
  );

  return {
    projectTotal,
    income: totals.income,
    expenses: totals.expenses,
    balance: totals.income - totals.expenses,
    remainingToReceive: Math.max(0, projectTotal - totals.income),
    futurePayments,
  };
}

function paymentCategoryLabel(payment) {
  return payment?.category_name || "Без категории";
}

function paymentCategoryBadgeClass(payment) {
  if (payment?.category_type === "expense") return "bg-red-50 text-red-600";
  if (payment?.category_type === "income") return "bg-emerald-50 text-emerald-600";
  return "bg-slate-100 text-slate-600";
}

function paymentMatchesSearch(payment, rawQuery) {
  const query = normalizeSearchText(rawQuery);
  if (!query) return true;

  const kind = paymentOperationKind(payment) === "expense" ? "расход списание" : "доход поступление";
  const paymentType =
    {
      advance: "аванс предоплата",
      additional: "доплата дополнительный платеж",
      refund: "возврат",
      correction: "корректировка",
    }[payment?.type] || "";
  const searchableText = normalizeSearchText(
    [
      paymentCategoryLabel(payment),
      payment?.comment,
      payment?.account_name,
      kind,
      paymentType,
      isFuturePayment(payment) ? "запланировано будущая операция" : "проведено",
      formatDateTime(payment?.paid_at),
      formatMoney(payment?.amount),
      payment?.amount,
    ]
      .filter(Boolean)
      .join(" ")
  );
  if (searchableText.includes(query)) return true;

  const queryDigits = query.replace(/\D/g, "");
  if (!queryDigits) return false;
  const numericValues = [
    cleanAmountValue(payment?.amount),
    formatDateTime(payment?.paid_at).replace(/\D/g, ""),
  ];
  return numericValues.some((value) => value.includes(queryDigits));
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

function customFieldInputProps(field) {
  if (field.field_type === "date") {
    return { type: "date" };
  }
  if (field.field_type === "number") {
    return { inputMode: "decimal", placeholder: "Например, 120" };
  }
  if (field.field_type === "file") {
    return { placeholder: "Ссылка или название файла" };
  }
  return { placeholder: "Введите значение" };
}

function customFieldFileDisplay(value) {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    const name = value.name || value.original_name || "Файл";
    return {
      name,
      originalName: value.original_name || value.originalName || name,
      url: value.url || "",
      path: value.path || "",
      contentType: value.content_type || value.contentType || "",
      size: Number(value.size || 0) || 0,
    };
  }
  return { name: String(value), url: "", contentType: "", size: 0 };
}

function customFieldFileList(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map(customFieldFileDisplay).filter(Boolean);
}

function customFieldFilePayload(fileValue) {
  return {
    name: fileValue.name || fileValue.originalName || "Файл",
    original_name: fileValue.originalName || fileValue.name || "Файл",
    url: fileValue.url || "",
    path: fileValue.path || "",
    content_type: fileValue.contentType || "",
    size: fileValue.size || 0,
  };
}

function isPreviewableImage(fileValue) {
  if (!fileValue?.url) return false;
  const contentType = String(fileValue.contentType || "").toLowerCase();
  const name = String(fileValue.name || "").toLowerCase();
  return contentType.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(name);
}

function formatFileSize(bytes) {
  const size = Number(bytes || 0);
  if (!size) return "";
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} КБ`;
  return `${(size / (1024 * 1024)).toFixed(1).replace(".", ",")} МБ`;
}

function ProjectCustomFieldsGrid({ fields, values, onChange, projectId, onFileUpload, onFilePreview, uploadingFiles = {} }) {
  if (!fields.length) return null;

  return (
    <div className="rounded-[24px] border border-slate-100 bg-slate-50/70 p-4">
      <div className="grid gap-4 md:grid-cols-2">
        {fields.map((field) => {
          const fieldKey = String(field.id);
          const isFileField = field.field_type === "file";
          const fileValues = isFileField ? customFieldFileList(values?.[fieldKey]) : [];
          const uploadId = `project-custom-field-${projectId || "new"}-${fieldKey}`;
          const isUploading = Boolean(uploadingFiles[fieldKey]);

          if (isFileField) {
            const handleFileChange = (event) => {
              const files = Array.from(event.target.files || []);
              event.target.value = "";
              if (files.length && onFileUpload) {
                onFileUpload(fieldKey, files);
              }
            };

            return (
              <div key={field.id} className="space-y-2 md:col-span-2">
                <Label>{field.name}</Label>
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
                  {fileValues.length ? (
                    <div className="min-w-0 space-y-1">
                      {fileValues.map((fileValue, fileIndex) => {
                        const removeFile = () => {
                          const nextFiles = fileValues.filter((_, index) => index !== fileIndex);
                          onChange(fieldKey, nextFiles.length ? nextFiles.map(customFieldFilePayload) : "");
                        };

                        return (
                          <div key={`${fileValue.url || fileValue.name}-${fileIndex}`} className="flex min-w-0 items-center justify-between gap-2 rounded-xl bg-slate-50 px-2 py-1">
                            {fileValue.url && isPreviewableImage(fileValue) ? (
                              <button
                                type="button"
                                onClick={() => onFilePreview?.(fileValue)}
                                className="inline-flex min-w-0 items-center gap-2 text-left text-sm font-bold text-blue-600 hover:text-blue-700"
                              >
                                <FileText size={16} className="shrink-0" />
                                <span className="truncate">{fileValue.name}</span>
                              </button>
                            ) : fileValue.url ? (
                              <a
                                href={fileValue.url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex min-w-0 items-center gap-2 text-sm font-bold text-blue-600 hover:text-blue-700"
                              >
                                <FileText size={16} className="shrink-0" />
                                <span className="truncate">{fileValue.name}</span>
                              </a>
                            ) : (
                              <div className="inline-flex min-w-0 items-center gap-2 text-sm font-bold text-slate-700">
                                <FileText size={16} className="shrink-0" />
                                <span className="truncate">{fileValue.name}</span>
                              </div>
                            )}
                            <div className="flex shrink-0 items-center gap-1">
                              {fileValue.size ? (
                                <span className="hidden text-xs font-semibold text-slate-400 sm:inline">{formatFileSize(fileValue.size)}</span>
                              ) : null}
                              <button
                                type="button"
                                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                                onClick={removeFile}
                                aria-label="Убрать файл"
                              >
                                <Trash2 size={15} />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-sm font-semibold text-slate-400">Файлы не прикреплены</div>
                  )}

                  {projectId && onFileUpload ? (
                    <div className="flex shrink-0 gap-2">
                      <input id={uploadId} className="sr-only" type="file" multiple onChange={handleFileChange} />
                      <label
                        htmlFor={uploadId}
                        className={`inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-slate-900 text-white shadow-sm transition hover:bg-black ${
                          isUploading ? "pointer-events-none opacity-60" : ""
                        }`}
                        title={isUploading ? "Загружаем..." : "Прикрепить файлы"}
                        aria-label={isUploading ? "Загружаем файлы" : "Прикрепить файлы"}
                      >
                        <Paperclip size={16} />
                      </label>
                    </div>
                  ) : (
                    <div className="col-span-2 mt-1 rounded-2xl bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-500">
                      Файл можно прикрепить после создания проекта.
                    </div>
                  )}
                </div>
              </div>
            );
          }

          return (
            <div key={field.id} className="space-y-2">
              <Label>{field.name}</Label>
              <Input
                {...customFieldInputProps(field)}
                value={values?.[fieldKey] || ""}
                onChange={(event) => onChange(fieldKey, event.target.value)}
              />
            </div>
          );
        })}
      </div>
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

function ProjectKanbanCard({ project, amount, ageDays, showAgeDays = true, isDragging = false, onClick }) {
  const orderLabel = projectOrderLabel(project);
  const bonusUsed = projectReferralBonus(project);
  const plannedAmount = Number(project?.total_amount || 0);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full select-none rounded-[22px] border border-slate-200/90 bg-white px-4 py-4 text-left shadow-[0_10px_24px_rgba(15,23,42,0.06)] transition hover:-translate-y-0.5 hover:shadow-[0_14px_32px_rgba(15,23,42,0.08)] ${
        isDragging ? "scale-[0.98] cursor-grabbing opacity-55 ring-2 ring-blue-500" : "cursor-grab"
      }`}
    >
      <div className="flex items-start gap-2">
        {orderLabel ? (
          <span className="shrink-0 rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-black text-blue-600">
            №{orderLabel}
          </span>
        ) : null}
        <div className="line-clamp-2 text-[1.02rem] font-black leading-6 tracking-tight text-slate-800">
          {projectDisplayName(project)}
        </div>
      </div>
      <div className="mt-1.5 text-sm text-slate-500">{project.client_name || "Клиент не назначен"}</div>
      <div className="mt-4 flex items-end justify-between gap-3">
        <div>
          {bonusUsed > 0 ? (
            <div className="text-xs font-bold text-slate-400 line-through">{formatMoney(plannedAmount)} ₽</div>
          ) : null}
          <div className="text-[1.05rem] font-black tracking-tight text-blue-600">{formatMoney(amount)} ₽</div>
        </div>
        {showAgeDays ? (
          <span className={`rounded-full px-3 py-1 text-sm font-semibold ${ageBadgeClass(ageDays)}`}>
            {ageDays || 0} дн.
          </span>
        ) : null}
      </div>
    </button>
  );
}

function ProjectDragGhost({ project, amount, ageDays, left, top, width }) {
  const orderLabel = projectOrderLabel(project);
  const bonusUsed = projectReferralBonus(project);
  const plannedAmount = Number(project?.total_amount || 0);

  return (
    <div
      className="pointer-events-none fixed z-[70] rounded-[22px] border border-blue-300 bg-white/85 px-4 py-4 text-left shadow-[0_24px_60px_rgba(37,99,235,0.28)] ring-4 ring-blue-500/15 backdrop-blur-md"
      style={{
        left,
        top,
        width,
      }}
    >
      <div className="flex items-start gap-2">
        {orderLabel ? (
          <span className="shrink-0 rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-black text-blue-600">
            №{orderLabel}
          </span>
        ) : null}
        <div className="line-clamp-2 text-[1.02rem] font-black leading-6 tracking-tight text-slate-800">
          {projectDisplayName(project)}
        </div>
      </div>
      <div className="mt-1.5 text-sm text-slate-500">{project.client_name || "Клиент не назначен"}</div>
      <div className="mt-4 flex items-end justify-between gap-3">
        <div>
          {bonusUsed > 0 ? (
            <div className="text-xs font-bold text-slate-400 line-through">{formatMoney(plannedAmount)} ₽</div>
          ) : null}
          <div className="text-[1.05rem] font-black tracking-tight text-blue-600">{formatMoney(amount)} ₽</div>
        </div>
        <span className={`rounded-full px-3 py-1 text-sm font-semibold ${ageBadgeClass(ageDays)}`}>
          {ageDays || 0} дн.
        </span>
      </div>
    </div>
  );
}

export default function Projects() {
  const location = useLocation();

  const [projects, setProjects] = useState([]);
  const [clients, setClients] = useState([]);
  const [payments, setPayments] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [statusRows, setStatusRows] = useState(DEFAULT_STATUS_OPTIONS);
  const [financeCategories, setFinanceCategories] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [customFields, setCustomFields] = useState([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState(() => localStorage.getItem(VIEW_MODE_KEY) || "kanban");
  const [touchDragProjectId, setTouchDragProjectId] = useState(null);
  const [dragTargetStatus, setDragTargetStatus] = useState("");
  const [dragPreview, setDragPreview] = useState(null);
  const pointerDragRef = useRef(null);
  const suppressProjectClickRef = useRef(false);
  const handledOpenProjectStateRef = useRef("");
  const bodyDragStyleRef = useRef(null);
  const kanbanScrollRef = useRef(null);
  const kanbanPanRef = useRef(null);
  const kanbanPanBodyStyleRef = useRef(null);
  const dragAutoScrollRef = useRef(null);
  const dragAutoScrollFrameRef = useRef(null);

  const [openCreate, setOpenCreate] = useState(false);
  const [createForm, setCreateForm] = useState(createEmptyProjectForm());
  const [createSaving, setCreateSaving] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createBonusEnabled, setCreateBonusEnabled] = useState(false);
  const [createBonusPreview, setCreateBonusPreview] = useState(null);
  const [createBonusPreviewError, setCreateBonusPreviewError] = useState("");
  const [createBonusPreviewLoading, setCreateBonusPreviewLoading] = useState(false);

  const [activeProjectId, setActiveProjectId] = useState(null);
  const [detailForm, setDetailForm] = useState(createEmptyProjectForm());
  const [detailTab, setDetailTab] = useState("comments");
  const [detailBonusEnabled, setDetailBonusEnabled] = useState(false);
  const [detailAutosaveState, setDetailAutosaveState] = useState("idle");
  const detailSnapshotRef = useRef("");
  const detailAutosaveTimerRef = useRef(null);
  const detailAutosaveRequestRef = useRef(0);
  const [addressDetailsOpen, setAddressDetailsOpen] = useState(false);
  const [addressSuggestions, setAddressSuggestions] = useState([]);
  const [addressSuggestLoading, setAddressSuggestLoading] = useState(false);
  const [addressSuggestError, setAddressSuggestError] = useState("");
  const selectedAddressValueRef = useRef("");
  const loadedProjectIdRef = useRef(null);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [documentIdentityPrompt, setDocumentIdentityPrompt] = useState({ open: false, type: "contract", fullName: "" });
  const [documentIdentitySaving, setDocumentIdentitySaving] = useState(false);
  const [documentIdentityError, setDocumentIdentityError] = useState("");
  const [yandexDiskCreating, setYandexDiskCreating] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [customFieldUploads, setCustomFieldUploads] = useState({});
  const [customFieldPreview, setCustomFieldPreview] = useState(null);
  const [projectClientOpen, setProjectClientOpen] = useState(false);
  const [projectClientForm, setProjectClientForm] = useState(createClientEditForm());
  const [projectClientSaving, setProjectClientSaving] = useState(false);
  const [projectClientDetaching, setProjectClientDetaching] = useState(false);
  const [projectClientAttaching, setProjectClientAttaching] = useState(false);
  const [projectClientQuery, setProjectClientQuery] = useState("");
  const [projectNewClientName, setProjectNewClientName] = useState("");
  const [projectClientError, setProjectClientError] = useState("");

  const [comments, setComments] = useState([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [projectActivity, setProjectActivity] = useState([]);
  const [projectActivityLoading, setProjectActivityLoading] = useState(false);
  const [projectStatusChecks, setProjectStatusChecks] = useState(null);
  const [projectStatusChecksLoading, setProjectStatusChecksLoading] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [commentSaving, setCommentSaving] = useState(false);
  const [commentError, setCommentError] = useState("");
  const [editingCommentId, setEditingCommentId] = useState(null);
  const [editingCommentText, setEditingCommentText] = useState("");
  const [commentUpdating, setCommentUpdating] = useState(false);

  const [paymentForm, setPaymentForm] = useState(createEmptyPaymentForm());
  const [editingPaymentId, setEditingPaymentId] = useState(null);
  const [paymentSaving, setPaymentSaving] = useState(false);
  const [paymentError, setPaymentError] = useState("");
  const [paymentSearch, setPaymentSearch] = useState("");
  const deferredPaymentSearch = useDeferredValue(paymentSearch);

  const [taskForm, setTaskForm] = useState(createEmptyTaskForm());
  const [taskSaving, setTaskSaving] = useState(false);
  const [taskError, setTaskError] = useState("");

  const [confirmState, setConfirmState] = useState(null);
  const [confirmDeleting, setConfirmDeleting] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [confirmError, setConfirmError] = useState("");

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
  const terminalStatusValue = statusOptions[statusOptions.length - 1]?.value || "";

  const financeCategoryOptions = useMemo(
    () =>
      financeCategories
        .map((category) => ({
          id: category.id,
          value: String(category.id),
          label: category.name,
          type: category.type,
        })),
    [financeCategories]
  );
  const hasMultipleAccounts = accounts.length > 1;
  const singleAccountId = accounts.length === 1 ? String(accounts[0].id) : "";

  const paymentCategoryOptions = useMemo(
    () => financeCategoryOptions.filter((category) => category.type === paymentForm.category_kind),
    [financeCategoryOptions, paymentForm.category_kind]
  );
  async function reloadData({ silent = false } = {}) {
    if (!silent) {
      setLoading(true);
    }

    try {
      const [projectRows, clientRows, paymentRows, taskRows, statusItems, financeCategoryRows, accountRows, customFieldRows] = await Promise.all([
        fetchProjects(),
        fetchClients(),
        fetchPayments(),
        fetchTasks(),
        fetchProjectStatuses(),
        fetchFinanceCategories(),
        fetchAccounts(),
        fetchProjectCustomFields(),
      ]);

      setProjects(projectRows);
      setClients(clientRows);
      setPayments(paymentRows);
      setTasks(taskRows);
      setStatusRows(statusItems.length > 0 ? statusItems : DEFAULT_STATUS_OPTIONS);
      setFinanceCategories(financeCategoryRows);
      setAccounts(accountRows);
      setCustomFields(customFieldRows);
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

  async function reloadProjectActivity(projectId) {
    if (!projectId) {
      setProjectActivity([]);
      return;
    }

    setProjectActivityLoading(true);
    try {
      const response = await fetchProjectActivity(projectId);
      setProjectActivity(response.events || []);
    } catch {
      setProjectActivity([]);
    } finally {
      setProjectActivityLoading(false);
    }
  }

  async function reloadProjectStatusChecks(projectId) {
    if (!projectId) {
      setProjectStatusChecks(null);
      return;
    }

    setProjectStatusChecksLoading(true);
    try {
      const response = await fetchProjectStatusChecks(projectId);
      setProjectStatusChecks(response);
    } catch {
      setProjectStatusChecks(null);
    } finally {
      setProjectStatusChecksLoading(false);
    }
  }

  useEffect(() => {
    reloadData().catch(() => {
      setProjects([]);
      setClients([]);
      setPayments([]);
      setTasks([]);
      setStatusRows(DEFAULT_STATUS_OPTIONS);
      setFinanceCategories([]);
      setAccounts([]);
      setCustomFields([]);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    let active = true;
    const refreshProjects = () => {
      if (document.visibilityState !== "visible") return;
      void fetchProjects().then((rows) => {
        if (active) setProjects(rows);
      }).catch(() => {});
    };
    const interval = window.setInterval(refreshProjects, 15000);
    window.addEventListener("focus", refreshProjects);
    document.addEventListener("visibilitychange", refreshProjects);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshProjects);
      document.removeEventListener("visibilitychange", refreshProjects);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(VIEW_MODE_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    const state = location.state || {};
    const requestedProjectId = state.projectId;
    if (requestedProjectId) {
      const stateKey = `${location.key}:${requestedProjectId}:${state.tab || "comments"}`;
      const project = projects.find((item) => String(item.id) === String(requestedProjectId));
      if (project && handledOpenProjectStateRef.current !== stateKey) {
        handledOpenProjectStateRef.current = stateKey;
        openProject(project, state.tab || "comments");
        window.history.replaceState({}, document.title);
      }
      return;
    }

  }, [location.key, location.state, projects]);

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
        object_lat: client.address_lat || "",
        object_lon: client.address_lon || "",
        apartment: client.apartment || "",
        floor: client.floor || "",
        works_with_contract: Boolean(client.works_with_contract),
        project_count: client.project_count || 0,
        updated_at: client.updated_at || client.created_at || "",
        searchText: normalizeSearchText([client.name, client.phone, client.email, client.address].filter(Boolean).join(" ")),
        phoneDigits: phoneSearchDigits(client.phone),
      }))
      .sort((left, right) => (right.updated_at || "").localeCompare(left.updated_at || ""));
  }, [clients]);

  const createClientLookup = useMemo(() => {
    if (createForm.client) {
      return { queryReady: false, matches: [] };
    }

    const textQuery = normalizeSearchText(createForm.client_query || createForm.client_name || createForm.client_phone);
    const digitsQuery = phoneSearchDigits(createForm.client_query || createForm.client_phone);
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

  const filteredProjects = projects;

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

  const activeProjectClient = useMemo(() => {
    const clientId = activeProject?.client || activeProject?.client_info?.id || detailForm.client;
    if (!clientId) return activeProject?.client_info || null;
    return (
      clients.find((client) => String(client.id) === String(clientId)) ||
      activeProject?.client_info ||
      null
    );
  }, [activeProject, clients, detailForm.client]);

  const projectClientLookup = useMemo(() => {
    if (!activeProject || activeProjectClient?.id) {
      return { queryReady: false, matches: [] };
    }

    const textQuery = normalizeSearchText(projectClientQuery);
    const digitsQuery = phoneSearchDigits(projectClientQuery);
    const queryReady = textQuery.length >= 2 || digitsQuery.length >= 3;
    if (!queryReady) {
      return { queryReady: false, matches: [] };
    }

    const matches = clientDirectory
      .filter((client) => {
        const byPhone = digitsQuery.length >= 3 && client.phoneDigits.includes(digitsQuery);
        const byText = textQuery.length >= 2 && client.searchText.includes(textQuery);
        return byPhone || byText;
      })
      .slice(0, 6);

    return { queryReady: true, matches };
  }, [activeProject, activeProjectClient?.id, clientDirectory, projectClientQuery]);

  const projectClientQueryHasPhone = phoneDigits(projectClientQuery).length > 0;
  const projectClientCanCreate =
    projectClientLookup.queryReady && projectClientLookup.matches.length === 0 && projectClientQuery.trim().length > 0;

  const draggedProject = useMemo(
    () => projects.find((project) => project.id === dragPreview?.projectId) || null,
    [dragPreview?.projectId, projects]
  );

  const draggedProjectAmount = useMemo(
    () => (draggedProject ? projectAmount(draggedProject, paymentsByProject) : 0),
    [draggedProject, paymentsByProject]
  );

  const draggedProjectAgeDays = useMemo(
    () => (draggedProject ? daysInWork(draggedProject.updated_at || draggedProject.created_at) : 0),
    [draggedProject]
  );

  const activeProjectPayments = useMemo(() => {
    if (!activeProjectId) return [];
    return paymentsByProject.get(activeProjectId) || [];
  }, [activeProjectId, paymentsByProject]);

  const filteredActiveProjectPayments = useMemo(
    () => activeProjectPayments.filter((payment) => paymentMatchesSearch(payment, deferredPaymentSearch)),
    [activeProjectPayments, deferredPaymentSearch]
  );

  const editingPayment = useMemo(
    () => activeProjectPayments.find((payment) => payment.id === editingPaymentId) || null,
    [activeProjectPayments, editingPaymentId]
  );

  const activeProjectFinanceSummary = useMemo(
    () => buildProjectFinanceSummary(activeProject, activeProjectPayments),
    [activeProject, activeProjectPayments]
  );

  const routeLinks = useMemo(
    () => yandexRouteLinks(detailForm.object_address, detailForm.object_lat, detailForm.object_lon),
    [detailForm.object_address, detailForm.object_lat, detailForm.object_lon]
  );
  const maxMessageUrl = useMemo(
    () => maxMessengerHref(activeProject, detailForm),
    [activeProject, detailForm.client_name, detailForm.client_phone, detailForm.title]
  );
  const projectClientMaxUrl = useMemo(
    () =>
      maxMessengerHref(activeProject, {
        ...projectClientForm,
        client_name: projectClientForm.name,
        client_phone: projectClientForm.phone,
      }),
    [activeProject, projectClientForm.name, projectClientForm.phone]
  );
  const projectClientRouteLinks = useMemo(
    () =>
      yandexRouteLinks(
        projectClientForm.address || activeProjectClient?.address || "",
        projectClientForm.address_lat || activeProjectClient?.address_lat || "",
        projectClientForm.address_lon || activeProjectClient?.address_lon || ""
      ),
    [
      activeProjectClient?.address,
      activeProjectClient?.address_lat,
      activeProjectClient?.address_lon,
      projectClientForm.address,
      projectClientForm.address_lat,
      projectClientForm.address_lon,
    ]
  );

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

  useEffect(() => {
    if (!openCreate || !createBonusEnabled) {
      setCreateBonusPreview(null);
      setCreateBonusPreviewError("");
      setCreateBonusPreviewLoading(false);
      return;
    }

    const promoCode = normalizePromoCodeInput(createForm.bonus_promo_code);
    const totalAmount = cleanAmountValue(createForm.total_amount);

    if (!promoCode || promoCode.length < 5) {
      setCreateBonusPreview(null);
      setCreateBonusPreviewError("");
      setCreateBonusPreviewLoading(false);
      return;
    }

    if (!totalAmount) {
      setCreateBonusPreview(null);
      setCreateBonusPreviewError("Укажите сумму проекта, чтобы проверить промокод.");
      setCreateBonusPreviewLoading(false);
      return;
    }

    let cancelled = false;
    setCreateBonusPreviewLoading(true);
    setCreateBonusPreview(null);
    setCreateBonusPreviewError("");

    const timerId = window.setTimeout(async () => {
      try {
        const preview = await previewBonusPromo({
          bonus_promo_code: promoCode,
          total_amount: totalAmount,
          client: createForm.client || undefined,
          client_phone: createForm.client_phone || createForm.client_query || "",
        });
        if (!cancelled) {
          setCreateBonusPreview(preview);
          setCreateBonusPreviewError("");
        }
      } catch (error) {
        if (!cancelled) {
          setCreateBonusPreview(null);
          setCreateBonusPreviewError(extractApiErrorMessage(error, "Промокод не подходит или бонусов нет."));
        }
      } finally {
        if (!cancelled) {
          setCreateBonusPreviewLoading(false);
        }
      }
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [
    createForm.bonus_promo_code,
    createForm.client,
    createForm.client_phone,
    createForm.client_query,
    createForm.total_amount,
    createBonusEnabled,
    openCreate,
  ]);

  useEffect(() => {
    if (!activeProject) {
      loadedProjectIdRef.current = null;
      return;
    }

    const nextForm = normalizeProjectForm(activeProject, defaultStatusValue);
    const isNewProject = loadedProjectIdRef.current !== activeProject.id;
    if (isNewProject) {
      loadedProjectIdRef.current = activeProject.id;
      setDetailForm(nextForm);
      selectedAddressValueRef.current = nextForm.object_address.trim();
      setDetailAutosaveState("idle");
      setDetailError("");
      setProjectClientQuery("");
      setProjectNewClientName("");
      setDetailBonusEnabled(Boolean(nextForm.bonus_promo_code || Number(activeProject.referral_bonus_used || 0)));
    }
    detailSnapshotRef.current = JSON.stringify(buildProjectUpdatePayload(nextForm));
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
    if (payload.bonus_promo_code && payload.bonus_promo_code.length !== 5) {
      setDetailAutosaveState("idle");
      return;
    }
    if (payload.bonus_promo_code && !payload.total_amount) {
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
        if (Number(updated.referral_bonus_used || 0) || Number(updated.bonus_accrued_amount || 0)) {
          const refreshedClients = await fetchClients();
          setClients(refreshedClients);
        }
        detailSnapshotRef.current = JSON.stringify(buildProjectUpdatePayload(normalizeProjectForm(updated, defaultStatusValue)));
        reloadProjectStatusChecks(updated.id).catch(() => {});
        reloadProjectActivity(updated.id).catch(() => {});
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
      setProjectActivity([]);
      setProjectStatusChecks(null);
      setCommentText("");
      setCommentError("");
      setEditingCommentId(null);
      setEditingCommentText("");
      setPaymentForm(createEmptyPaymentForm());
      setEditingPaymentId(null);
      setPaymentError("");
      setTaskForm(createEmptyTaskForm());
      setTaskError("");
      return;
    }

    reloadComments(activeProjectId).catch(() => {});
    reloadProjectActivity(activeProjectId).catch(() => {});
    reloadProjectStatusChecks(activeProjectId).catch(() => {});
    setEditingCommentId(null);
    setEditingCommentText("");
    setEditingPaymentId(null);
    setPaymentForm(createEmptyPaymentForm());
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeProjectId || !addressDetailsOpen || !hasDadataAddressSuggestions()) {
      setAddressSuggestions([]);
      setAddressSuggestLoading(false);
      setAddressSuggestError("");
      return;
    }

    const query = detailForm.object_address.trim();
    if (query.length < 3) {
      setAddressSuggestions([]);
      setAddressSuggestLoading(false);
      setAddressSuggestError("");
      return;
    }
    if (query === selectedAddressValueRef.current) {
      setAddressSuggestions([]);
      setAddressSuggestLoading(false);
      setAddressSuggestError("");
      return;
    }

    let cancelled = false;
    setAddressSuggestLoading(true);
    const timerId = window.setTimeout(async () => {
      try {
        const suggestions = await fetchAddressSuggestions(query);
        if (!cancelled) {
          setAddressSuggestions(suggestions);
          setAddressSuggestError(suggestions.length ? "" : "Адрес не найден. Уточните улицу, дом или город.");
        }
      } catch (requestError) {
        if (!cancelled) {
          setAddressSuggestError(requestError?.message || "Не удалось загрузить подсказки Dadata.");
        }
      } finally {
        if (!cancelled) {
          setAddressSuggestLoading(false);
        }
      }
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [activeProjectId, addressDetailsOpen, detailForm.object_address]);

  function openCreateModal(status = defaultStatusValue) {
    setCreateError("");
    setCreateBonusEnabled(false);
    setCreateBonusPreview(null);
    setCreateBonusPreviewError("");
    setCreateBonusPreviewLoading(false);
    setCreateForm(createEmptyProjectForm(status));
    setOpenCreate(true);
  }

  function closeCreateModal() {
    setOpenCreate(false);
    setCreateError("");
    setCreateBonusEnabled(false);
    setCreateBonusPreview(null);
    setCreateBonusPreviewError("");
    setCreateBonusPreviewLoading(false);
    setCreateForm(createEmptyProjectForm(defaultStatusValue));
  }

  function applyClientFromSearch(client) {
    setCreateForm((prev) => ({
      ...prev,
      client: client.client_id || "",
      client_query: "",
      client_name: client.client_name || prev.client_name,
      client_phone: client.client_phone || prev.client_phone,
      client_email: client.client_email || prev.client_email,
      object_address: client.object_address || prev.object_address,
      object_lat: client.object_lat || prev.object_lat,
      object_lon: client.object_lon || prev.object_lon,
      apartment: client.apartment || prev.apartment,
      floor: client.floor || prev.floor,
      works_with_contract: Boolean(client.works_with_contract),
    }));
  }

  function clearCreateClientSelection() {
    setCreateForm((prev) => ({
      ...prev,
      client: "",
      client_query: "",
      client_name: "",
      client_phone: "",
      client_email: "",
      works_with_contract: false,
    }));
  }

  function handleCreateClientQuery(value) {
    const formattedValue = formatRussianPhoneInput(value);
    const digits = phoneDigits(formattedValue);
    setCreateForm((prev) => ({
      ...prev,
      client: "",
      client_query: formattedValue,
      client_phone: digits ? formattedValue : "",
      client_name: digits ? prev.client_name : "",
    }));
  }

  function openProject(project, tab = "comments") {
    setActiveProjectId(project.id);
    setDetailTab(tab);
    setPaymentSearch("");
  }

  function closeProject() {
    setActiveProjectId(null);
    setDetailTab("comments");
    setDetailError("");
    setCommentError("");
    setPaymentError("");
    setPaymentSearch("");
    setTaskError("");
    setTaskForm(createEmptyTaskForm());
    setDetailAutosaveState("idle");
    setDetailBonusEnabled(false);
    setYandexDiskCreating(false);
    setAddressDetailsOpen(false);
    setAddressSuggestions([]);
    setAddressSuggestError("");
    setCustomFieldUploads({});
    setCustomFieldPreview(null);
    setProjectClientOpen(false);
    setProjectClientError("");
    setProjectClientForm(createClientEditForm());
    setProjectClientDetaching(false);
    setProjectClientAttaching(false);
    setProjectClientQuery("");
    setProjectNewClientName("");
    selectedAddressValueRef.current = "";
    loadedProjectIdRef.current = null;
    detailSnapshotRef.current = "";
    window.clearTimeout(detailAutosaveTimerRef.current);
  }

  function applyUpdatedProject(updated) {
    const nextForm = normalizeProjectForm(updated, defaultStatusValue);
    setProjects((prev) => prev.map((project) => (project.id === updated.id ? updated : project)));
    if (updated.client_info) {
      setClients((prev) => {
        const exists = prev.some((client) => client.id === updated.client_info.id);
        return exists
          ? prev.map((client) => (client.id === updated.client_info.id ? updated.client_info : client))
          : [updated.client_info, ...prev];
      });
    }
    setDetailForm(nextForm);
    selectedAddressValueRef.current = nextForm.object_address.trim();
    detailSnapshotRef.current = JSON.stringify(buildProjectUpdatePayload(nextForm));
    setDetailAutosaveState("idle");
  }

  async function handleCustomFieldFileUpload(fieldId, files) {
    const fileList = Array.isArray(files) ? files : [files];
    if (!activeProject?.id || !fileList.some(Boolean)) return;

    const fieldKey = String(fieldId);
    setCustomFieldUploads((prev) => ({ ...prev, [fieldKey]: true }));
    setDetailError("");

    try {
      const result = await uploadProjectCustomFieldFile(activeProject.id, fieldKey, fileList);
      const updatedProject = result.project;

      if (updatedProject) {
        setProjects((prev) => prev.map((project) => (project.id === updatedProject.id ? updatedProject : project)));
        setDetailForm((prev) => ({
          ...prev,
          custom_fields: normalizeCustomFieldValues(updatedProject.custom_fields || {}),
        }));
      } else if (result.value) {
        setDetailForm((prev) => ({
          ...prev,
          custom_fields: {
            ...(prev.custom_fields || {}),
            [fieldKey]: result.value,
          },
        }));
      }

      setDetailAutosaveState("idle");
    } catch (error) {
      setDetailError(extractApiErrorMessage(error, "Не удалось прикрепить файл."));
    } finally {
      setCustomFieldUploads((prev) => {
        const next = { ...prev };
        delete next[fieldKey];
        return next;
      });
    }
  }

  function openProjectClientCard() {
    if (!activeProjectClient?.id) {
      setDetailError("Карточка клиента пока не найдена. Проверьте, что клиент привязан к проекту.");
      return;
    }

    setProjectClientForm(createClientEditForm(activeProjectClient));
    setProjectClientError("");
    setProjectClientOpen(true);
  }

  function closeProjectClientCard() {
    if (projectClientSaving) return;
    setProjectClientOpen(false);
    setProjectClientError("");
  }

  async function detachProjectClient() {
    if (!activeProject?.id || !activeProjectClient?.id || projectClientDetaching) return;

    setProjectClientDetaching(true);
    setDetailError("");
    setProjectClientError("");
    window.clearTimeout(detailAutosaveTimerRef.current);
    detailAutosaveRequestRef.current += 1;

    const payload = {
      ...buildProjectUpdatePayload(detailForm),
      client: null,
      client_name: "",
      client_phone: "",
      client_email: null,
    };

    try {
      const updated = await updateProject(activeProject.id, payload);
      applyUpdatedProject(updated);
      setProjectClientQuery("");
      setProjectNewClientName("");
      setProjectClientOpen(false);
    } catch (error) {
      setDetailError(extractApiErrorMessage(error, "Не удалось открепить клиента от проекта."));
    } finally {
      setProjectClientDetaching(false);
    }
  }

  async function attachProjectClient(client) {
    if (!activeProject?.id || !client?.client_id) return;

    setProjectClientAttaching(true);
    setDetailError("");
    window.clearTimeout(detailAutosaveTimerRef.current);
    detailAutosaveRequestRef.current += 1;

    const currentAddress = String(detailForm.object_address || "").trim();
    const clientAddress = String(client.object_address || "").trim();
    const shouldUseClientAddress = !currentAddress && Boolean(clientAddress);
    const nextAddress = currentAddress || clientAddress;
    const nextLat = shouldUseClientAddress ? String(client.object_lat || "").trim() : String(detailForm.object_lat || "").trim();
    const nextLon = shouldUseClientAddress ? String(client.object_lon || "").trim() : String(detailForm.object_lon || "").trim();
    const nextApartment = String(detailForm.apartment || "").trim() || String(client.apartment || "").trim();
    const nextFloor = String(detailForm.floor || "").trim() || String(client.floor || "").trim();
    const payload = {
      ...buildProjectUpdatePayload(detailForm),
      client: client.client_id,
      client_name: client.client_name || "",
      client_phone: normalizeOptionalClientPhone(client.client_phone) || "",
      client_email: client.client_email || null,
      object_address: nextAddress,
      object_lat: nextLat || null,
      object_lon: nextLon || null,
      apartment: nextApartment,
      floor: nextFloor,
    };

    try {
      const updated = await updateProject(activeProject.id, payload);
      applyUpdatedProject(updated);
      setProjectClientQuery("");
      setProjectNewClientName("");
    } catch (error) {
      setDetailError(extractApiErrorMessage(error, "Не удалось прикрепить клиента к проекту."));
    } finally {
      setProjectClientAttaching(false);
    }
  }

  async function createAndAttachProjectClient() {
    if (!activeProject?.id || projectClientAttaching) return;

    const hasPhone = Boolean(phoneDigits(projectClientQuery));
    const phoneError = hasPhone ? clientPhoneValidationError(projectClientQuery) : "";
    if (phoneError) {
      setDetailError(phoneError);
      return;
    }

    const inferredName = hasPhone ? "" : projectClientQuery.trim();
    const name = (projectNewClientName.trim() || inferredName).trim();
    if (!name) {
      setDetailError("Укажите имя нового клиента.");
      return;
    }

    setProjectClientAttaching(true);
    setDetailError("");
    window.clearTimeout(detailAutosaveTimerRef.current);
    detailAutosaveRequestRef.current += 1;

    try {
      const created = await createClient({
        name,
        phone: hasPhone ? normalizeOptionalClientPhone(projectClientQuery) : "",
        address: detailForm.object_address || null,
        address_lat: detailForm.object_lat || null,
        address_lon: detailForm.object_lon || null,
        apartment: detailForm.apartment.trim(),
        floor: detailForm.floor.trim(),
      });
      setClients((prev) => [created, ...prev.filter((client) => client.id !== created.id)]);
      await attachProjectClient({
        client_id: created.id,
        client_name: created.name || "",
        client_phone: created.phone || "",
        client_email: created.email || "",
        object_address: created.address || "",
        object_lat: created.address_lat || "",
        object_lon: created.address_lon || "",
        apartment: created.apartment || "",
        floor: created.floor || "",
      });
    } catch (error) {
      setDetailError(extractApiErrorMessage(error, "Не удалось создать и прикрепить клиента."));
      setProjectClientAttaching(false);
    }
  }

  async function submitProjectClient(event) {
    event.preventDefault();
    if (!activeProjectClient?.id) return;

    setProjectClientSaving(true);
    setProjectClientError("");

    try {
      if (!projectClientForm.name.trim()) {
        setProjectClientError("Укажите имя клиента.");
        return;
      }
      const phoneError = clientPhoneValidationError(projectClientForm.phone);
      if (phoneError) {
        setProjectClientError(phoneError);
        return;
      }

      const updated = await updateClient(activeProjectClient.id, {
        name: projectClientForm.name.trim(),
        contract_full_name: projectClientForm.contract_full_name.trim(),
        phone: normalizeOptionalClientPhone(projectClientForm.phone),
        email: projectClientForm.email.trim() || null,
        address: projectClientForm.address.trim() || null,
        address_lat: projectClientForm.address_lat || null,
        address_lon: projectClientForm.address_lon || null,
        apartment: projectClientForm.apartment.trim(),
        floor: projectClientForm.floor.trim(),
        works_with_contract: Boolean(projectClientForm.works_with_contract),
      });

      const previousClientAddress = String(activeProjectClient?.address || "").trim();
      const currentProjectAddress = String(detailForm.object_address || "").trim();
      const shouldSyncClientAddress =
        Boolean(activeProject?.id) && (!currentProjectAddress || currentProjectAddress === previousClientAddress);
      const syncedProjectAddress = shouldSyncClientAddress ? updated.address || "" : detailForm.object_address || "";
      const syncedProjectLat = shouldSyncClientAddress ? updated.address_lat || "" : detailForm.object_lat || "";
      const syncedProjectLon = shouldSyncClientAddress ? updated.address_lon || "" : detailForm.object_lon || "";
      const syncedProjectApartment = shouldSyncClientAddress ? updated.apartment || "" : detailForm.apartment || "";
      const syncedProjectFloor = shouldSyncClientAddress ? updated.floor || "" : detailForm.floor || "";

      setClients((prev) => prev.map((client) => (client.id === updated.id ? updated : client)));
      setProjects((prev) =>
        prev.map((project) => {
          const projectClientId = project.client || project.client_info?.id;
          if (String(projectClientId || "") !== String(updated.id)) {
            return project;
          }

          return {
            ...project,
            client: updated.id,
            client_info: updated,
            client_name: updated.name || "",
            client_phone: updated.phone || "",
            client_email: updated.email || "",
            object_address:
              project.id === activeProject?.id && shouldSyncClientAddress ? syncedProjectAddress : project.object_address || "",
            object_lat: project.id === activeProject?.id && shouldSyncClientAddress ? syncedProjectLat : project.object_lat || "",
            object_lon: project.id === activeProject?.id && shouldSyncClientAddress ? syncedProjectLon : project.object_lon || "",
            apartment: project.id === activeProject?.id && shouldSyncClientAddress ? syncedProjectApartment : project.apartment || "",
            floor: project.id === activeProject?.id && shouldSyncClientAddress ? syncedProjectFloor : project.floor || "",
            works_with_contract: Boolean(updated.works_with_contract),
          };
        })
      );
      setDetailForm((prev) => {
        const objectAddress = syncedProjectAddress;
        if (objectAddress) {
          selectedAddressValueRef.current = objectAddress.trim();
        }

        return {
          ...prev,
          client: updated.id,
          client_name: updated.name || "",
          client_phone: updated.phone || "",
          client_email: updated.email || "",
          object_address: objectAddress,
          object_lat: syncedProjectLat,
          object_lon: syncedProjectLon,
          apartment: syncedProjectApartment,
          floor: syncedProjectFloor,
          works_with_contract: Boolean(updated.works_with_contract),
        };
      });

      if (shouldSyncClientAddress) {
        const updatedProject = await updateProject(activeProject.id, {
          ...buildProjectUpdatePayload(detailForm),
          client: updated.id,
          client_name: updated.name || "",
          client_phone: normalizeOptionalClientPhone(updated.phone) || "",
          client_email: updated.email || null,
          object_address: syncedProjectAddress,
          object_lat: syncedProjectLat || null,
          object_lon: syncedProjectLon || null,
          apartment: syncedProjectApartment,
          floor: syncedProjectFloor,
        });
        applyUpdatedProject(updatedProject);
      }

      setProjectClientForm(createClientEditForm(updated));
      setProjectClientOpen(false);
    } catch (error) {
      setProjectClientError(extractApiErrorMessage(error, "Не удалось сохранить карточку клиента."));
    } finally {
      setProjectClientSaving(false);
    }
  }

  function applyAddressSuggestion(suggestion) {
    const selectedAddress = suggestion.value || suggestion.unrestrictedValue || detailForm.object_address;
    selectedAddressValueRef.current = selectedAddress.trim();
    setDetailForm((prev) => ({
      ...prev,
      object_address: selectedAddress || prev.object_address,
      object_lat: suggestion.lat || "",
      object_lon: suggestion.lon || "",
    }));
    setAddressSuggestions([]);
    setAddressSuggestLoading(false);
    setAddressSuggestError("");
  }

  function handlePaymentCategoryChange(categoryId) {
    const category = financeCategoryOptions.find((item) => item.value === categoryId);
    setPaymentForm((prev) => ({
      ...prev,
      category: categoryId,
      category_kind: category?.type || prev.category_kind,
    }));
  }

  function handlePaymentCategoryKindChange(categoryKind) {
    const firstCategory = financeCategoryOptions.find((category) => category.type === categoryKind);
    setPaymentForm((prev) => ({
      ...prev,
      category_kind: categoryKind,
      category: firstCategory ? firstCategory.value : "",
    }));
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
      const phoneError = clientPhoneValidationError(createForm.client_phone);
      if (phoneError) {
        setCreateError(phoneError);
        return;
      }
      const promoCode = createBonusEnabled ? normalizePromoCodeInput(createForm.bonus_promo_code) : "";
      if (promoCode && promoCode.length !== 5) {
        setCreateError("Промокод должен состоять из последних 5 цифр телефона.");
        return;
      }
      if (promoCode && !cleanAmountValue(createForm.total_amount)) {
        setCreateError("Укажите сумму проекта: бонусами можно покрыть до 10% стоимости.");
        return;
      }
      if (promoCode && createBonusPreviewLoading) {
        setCreateError("Проверяем промокод, подождите секунду.");
        return;
      }
      if (promoCode && createBonusPreviewError) {
        setCreateError(createBonusPreviewError);
        return;
      }
      if (promoCode && !createBonusPreview) {
        setCreateError("Проверьте промокод перед созданием проекта.");
        return;
      }

      const created = await createProject({
        title: createForm.title.trim(),
        client: createForm.client || undefined,
        client_name: createForm.client_name.trim(),
        client_phone: normalizeOptionalClientPhone(createForm.client_phone),
        client_email: createForm.client_email.trim() || undefined,
        object_address: createForm.object_address.trim(),
        object_lat: createForm.object_lat.trim() || undefined,
        object_lon: createForm.object_lon.trim() || undefined,
        apartment: createForm.apartment.trim(),
        entrance: createForm.entrance.trim(),
        floor: createForm.floor.trim(),
        description: createForm.description.trim(),
        categories: "",
        status: createForm.status,
        total_amount: cleanAmountValue(createForm.total_amount) || null,
        bonus_promo_code: promoCode,
        custom_fields: normalizeCustomFieldValues(createForm.custom_fields),
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
      if (created.bonus_promo_code || Number(created.referral_bonus_used || 0)) {
        const refreshedClients = await fetchClients();
        setClients(refreshedClients);
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
      reloadProjectActivity(activeProject.id).catch(() => {});
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
      if (editingCommentId === commentId) {
        setEditingCommentId(null);
        setEditingCommentText("");
      }
      if (activeProject) reloadProjectActivity(activeProject.id).catch(() => {});
    } catch (error) {
      setCommentError(extractApiErrorMessage(error, "Не удалось удалить комментарий."));
    }
  }

  function startCommentEdit(comment) {
    setCommentError("");
    setEditingCommentId(comment.id);
    setEditingCommentText(comment.text || "");
  }

  function cancelCommentEdit() {
    if (commentUpdating) return;
    setEditingCommentId(null);
    setEditingCommentText("");
  }

  async function submitCommentEdit(commentId) {
    const text = editingCommentText.trim();
    setCommentError("");

    if (!text) {
      setCommentError("Введите комментарий.");
      return;
    }

    setCommentUpdating(true);
    try {
      const updated = await updateProjectComment(commentId, { text });
      setComments((prev) => prev.map((comment) => (comment.id === updated.id ? updated : comment)));
      setEditingCommentId(null);
      setEditingCommentText("");
      if (activeProject) reloadProjectActivity(activeProject.id).catch(() => {});
    } catch (error) {
      setCommentError(extractApiErrorMessage(error, "Не удалось сохранить комментарий."));
    } finally {
      setCommentUpdating(false);
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
      if (!paymentForm.category_kind) {
        setPaymentError("Выберите тип операции: доход или расход.");
        return;
      }
      if (!paymentForm.category) {
        setPaymentError("Выберите категорию операции.");
        return;
      }
      if (!paymentForm.paid_at) {
        setPaymentError("Выберите дату операции.");
        return;
      }
      if (isPastDateValue(paymentForm.paid_at) && isPaymentDateChanged(editingPayment, paymentForm.paid_at)) {
        setPaymentError("Нельзя поставить операцию задним числом.");
        return;
      }
      if (hasMultipleAccounts && !paymentForm.account) {
        setPaymentError("Выберите счет для операции.");
        return;
      }

      const payload = {
        project: activeProject.id,
        category: paymentForm.category,
        account: hasMultipleAccounts ? paymentForm.account : singleAccountId || null,
        amount: paymentForm.amount.trim(),
        comment: paymentForm.comment.trim(),
        paid_at: toPaymentDateTime(paymentForm.paid_at),
      };

      if (editingPaymentId) {
        const updated = await updatePayment(editingPaymentId, payload);
        setPayments((prev) => prev.map((payment) => (payment.id === updated.id ? updated : payment)));
      } else {
        const created = await createPayment(payload);
        setPayments((prev) => [created, ...prev]);
      }
      const [refreshedProjects, refreshedClients] = await Promise.all([fetchProjects(), fetchClients()]);
      setProjects(refreshedProjects);
      setClients(refreshedClients);
      setPaymentForm(createEmptyPaymentForm());
      setEditingPaymentId(null);
      reloadProjectActivity(activeProject.id).catch(() => {});
      reloadProjectStatusChecks(activeProject.id).catch(() => {});
    } catch (error) {
      setPaymentError(extractApiErrorMessage(error, "Не удалось сохранить операцию."));
    } finally {
      setPaymentSaving(false);
    }
  }

  function startPaymentEdit(payment) {
    setDetailTab("finances");
    setPaymentError("");
    setEditingPaymentId(payment.id);
    const categoryKind = payment.category_type || (payment.type === "refund" || payment.type === "correction" ? "expense" : "income");
    setPaymentForm({
      category_kind: categoryKind,
      category: payment.category ? String(payment.category) : "",
      account: payment.account ? String(payment.account) : "",
      amount: payment.amount ? String(payment.amount) : "",
      comment: payment.comment || "",
      paid_at: toDateInputValue(payment.paid_at),
    });
  }

  function cancelPaymentEdit() {
    setEditingPaymentId(null);
    setPaymentForm(createEmptyPaymentForm());
    setPaymentError("");
  }

  async function handlePaymentDelete(paymentId) {
    try {
      await deletePayment(paymentId);
      setPayments((prev) => prev.filter((payment) => payment.id !== paymentId));
      if (editingPaymentId === paymentId) {
        cancelPaymentEdit();
      }
      if (activeProject) {
        reloadProjectActivity(activeProject.id).catch(() => {});
        reloadProjectStatusChecks(activeProject.id).catch(() => {});
      }
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
      reloadProjectActivity(activeProject.id).catch(() => {});
      reloadProjectStatusChecks(activeProject.id).catch(() => {});
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
      if (activeProject) {
        reloadProjectActivity(activeProject.id).catch(() => {});
        reloadProjectStatusChecks(activeProject.id).catch(() => {});
      }
    } catch (error) {
      setTaskError(extractApiErrorMessage(error, "Не удалось обновить задачу."));
    }
  }

  async function handleTaskDelete(taskId) {
    try {
      await deleteTask(taskId);
      setTasks((prev) => prev.filter((task) => task.id !== taskId));
      if (activeProject) {
        reloadProjectActivity(activeProject.id).catch(() => {});
        reloadProjectStatusChecks(activeProject.id).catch(() => {});
      }
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

  async function downloadDocumentFile(documentType) {
    if (!activeProject) return;
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

  async function handleDocumentDownload(documentType = "contract") {
    if (!activeProject) return;
    if (!detailForm.works_with_contract) {
      setDetailError("Включите «Работает по договору» в карточке клиента, затем сформируйте документ.");
      return;
    }
    if (!activeProjectClient?.id) {
      setDetailError("Сначала прикрепите к проекту карточку клиента.");
      return;
    }
    if (!String(activeProjectClient.contract_full_name || "").trim()) {
      const suggestedName = String(activeProjectClient.name || "").trim().split(/\s+/).length >= 2
        ? activeProjectClient.name
        : "";
      setDocumentIdentityError("");
      setDocumentIdentityPrompt({ open: true, type: documentType, fullName: suggestedName });
      return;
    }
    await downloadDocumentFile(documentType);
  }

  async function submitDocumentIdentity(event) {
    event.preventDefault();
    const fullName = documentIdentityPrompt.fullName.trim();
    if (!fullName) {
      setDocumentIdentityError("Укажите полное ФИО клиента.");
      return;
    }
    if (!activeProjectClient?.id) return;

    setDocumentIdentitySaving(true);
    setDocumentIdentityError("");
    try {
      const updated = await updateClient(activeProjectClient.id, { contract_full_name: fullName });
      setClients((prev) => prev.map((client) => (client.id === updated.id ? updated : client)));
      setProjects((prev) => prev.map((project) => {
        const clientId = project.client || project.client_info?.id;
        return String(clientId || "") === String(updated.id)
          ? { ...project, client_info: updated }
          : project;
      }));
      setProjectClientForm(createClientEditForm(updated));
      const documentType = documentIdentityPrompt.type;
      setDocumentIdentityPrompt({ open: false, type: "contract", fullName: "" });
      await downloadDocumentFile(documentType);
    } catch (error) {
      setDocumentIdentityError(extractApiErrorMessage(error, "Не удалось сохранить ФИО клиента."));
    } finally {
      setDocumentIdentitySaving(false);
    }
  }

  async function handleYandexDiskFolderCreate() {
    if (!activeProject?.id || yandexDiskCreating) return;

    setYandexDiskCreating(true);
    setDetailError("");
    try {
      const response = await createProjectYandexDiskFolder(activeProject.id);
      const updated = response.project;
      if (updated) {
        applyUpdatedProject(updated);
      }
      if (response.result?.error) {
        setDetailError(response.result.error);
      }
    } catch (error) {
      setDetailError(extractApiErrorMessage(error, "Не удалось создать папку проекта на Яндекс.Диске."));
    } finally {
      setYandexDiskCreating(false);
    }
  }

  function requestDeleteProject() {
    if (!activeProject) return;

    setConfirmText("");
    setConfirmError("");
    setConfirmState({
      kind: "project",
      title: "Удалить проект",
      message: `Точно удалить проект «${projectDisplayName(activeProject)}»? Это действие удалит проект вместе с операциями, задачами и комментариями.`,
    });
  }

  function requestDeletePayment(paymentId) {
    setConfirmText("");
    setConfirmError("");
    setConfirmState({
      kind: "payment",
      id: paymentId,
      title: "Удалить операцию",
      message: "Операция будет удалена из карточки проекта и из общего раздела финансов.",
    });
  }

  function requestDeleteComment(commentId) {
    setConfirmText("");
    setConfirmError("");
    setConfirmState({
      kind: "comment",
      id: commentId,
      title: "Удалить комментарий",
      message: "Комментарий исчезнет из ленты проекта.",
    });
  }

  function requestDeleteTask(taskId) {
    setConfirmText("");
    setConfirmError("");
    setConfirmState({
      kind: "task",
      id: taskId,
      title: "Удалить задачу",
      message: "Задача исчезнет из карточки проекта и из общего раздела задач.",
    });
  }

  async function submitDeleteConfirmation() {
    if (!confirmState) return;

    if (confirmState.kind === "project" && confirmText.trim().toLowerCase() !== "удалить") {
      setConfirmError("Введите слово «удалить», чтобы подтвердить удаление проекта.");
      return;
    }

    setConfirmError("");
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
      setConfirmText("");
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
        reloadProjectActivity(projectId).catch(() => {});
        reloadProjectStatusChecks(projectId).catch(() => {});
      }
    } catch (error) {
      setProjects((prev) =>
        prev.map((project) => (project.id === projectId ? { ...project, status: previousStatus } : project))
      );
      window.alert(extractApiErrorMessage(error, "Не удалось обновить статус проекта."));
    }
  }

  function setProjectDragTargetFromPoint(clientX, clientY) {
    const targetColumn = document.elementFromPoint(clientX, clientY)?.closest("[data-status-column]");
    const nextStatus = targetColumn?.getAttribute("data-status-column") || "";
    setDragTargetStatus((prev) => (prev === nextStatus ? prev : nextStatus));
  }

  function stopProjectDragAutoScroll() {
    dragAutoScrollRef.current = null;
    if (dragAutoScrollFrameRef.current) {
      window.cancelAnimationFrame(dragAutoScrollFrameRef.current);
      dragAutoScrollFrameRef.current = null;
    }
  }

  function runProjectDragAutoScroll() {
    dragAutoScrollFrameRef.current = null;
    const scrollState = dragAutoScrollRef.current;
    const scrollContainer = kanbanScrollRef.current;
    const drag = pointerDragRef.current;

    if (!scrollState || !scrollContainer || !drag?.dragging) {
      stopProjectDragAutoScroll();
      return;
    }

    const previousScrollLeft = scrollContainer.scrollLeft;
    scrollContainer.scrollLeft += scrollState.speed;
    if (scrollContainer.scrollLeft === previousScrollLeft) {
      stopProjectDragAutoScroll();
      return;
    }
    setProjectDragTargetFromPoint(drag.currentX, drag.currentY);
    dragAutoScrollFrameRef.current = window.requestAnimationFrame(runProjectDragAutoScroll);
  }

  function updateProjectDragAutoScroll(clientX) {
    const scrollContainer = kanbanScrollRef.current;
    if (!scrollContainer) {
      stopProjectDragAutoScroll();
      return;
    }

    const rect = scrollContainer.getBoundingClientRect();
    const edgeSize = Math.min(120, rect.width / 3);
    const maxSpeed = 26;
    let speed = 0;

    if (clientX < rect.left + edgeSize) {
      const distance = Math.max(0, clientX - rect.left);
      speed = -Math.ceil(((edgeSize - distance) / edgeSize) * maxSpeed);
    } else if (clientX > rect.right - edgeSize) {
      const distance = Math.max(0, rect.right - clientX);
      speed = Math.ceil(((edgeSize - distance) / edgeSize) * maxSpeed);
    }

    const canScrollLeft = scrollContainer.scrollLeft > 0;
    const canScrollRight = scrollContainer.scrollLeft + scrollContainer.clientWidth < scrollContainer.scrollWidth - 1;
    if ((speed < 0 && !canScrollLeft) || (speed > 0 && !canScrollRight) || speed === 0) {
      stopProjectDragAutoScroll();
      return;
    }

    dragAutoScrollRef.current = { speed };
    if (!dragAutoScrollFrameRef.current) {
      dragAutoScrollFrameRef.current = window.requestAnimationFrame(runProjectDragAutoScroll);
    }
  }

  function clearProjectDragHoldTimer(drag = pointerDragRef.current) {
    if (drag?.holdTimerId) {
      window.clearTimeout(drag.holdTimerId);
      drag.holdTimerId = null;
    }
  }

  function beginProjectDrag() {
    const drag = pointerDragRef.current;
    if (!drag || drag.dragging || drag.holdCancelled || drag.scrolling) return;

    clearProjectDragHoldTimer(drag);
    drag.dragging = true;
    drag.targetElement?.setPointerCapture?.(drag.pointerId);

    bodyDragStyleRef.current = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
      webkitUserSelect: document.body.style.webkitUserSelect,
    };
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";

    setTouchDragProjectId(drag.projectId);
    setDragPreview({
      projectId: drag.projectId,
      left: drag.currentX - drag.offsetX,
      top: drag.currentY - drag.offsetY,
      width: drag.width,
    });
    setProjectDragTargetFromPoint(drag.currentX, drag.currentY);
    updateProjectDragAutoScroll(drag.currentX);
  }

  function suppressProjectClickOnce() {
    suppressProjectClickRef.current = true;
    window.setTimeout(() => {
      suppressProjectClickRef.current = false;
    }, 120);
  }

  function startKanbanPanCursor() {
    if (kanbanPanBodyStyleRef.current) return;
    kanbanPanBodyStyleRef.current = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
      webkitUserSelect: document.body.style.webkitUserSelect,
    };
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";
  }

  function cleanupKanbanPan() {
    const previousBodyStyle = kanbanPanBodyStyleRef.current;
    if (previousBodyStyle) {
      document.body.style.cursor = previousBodyStyle.cursor;
      document.body.style.userSelect = previousBodyStyle.userSelect;
      document.body.style.webkitUserSelect = previousBodyStyle.webkitUserSelect;
    }
    kanbanPanBodyStyleRef.current = null;
    kanbanPanRef.current = null;
  }

  function handleKanbanPanPointerDown(event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (event.pointerType !== "mouse") return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("button, a, input, textarea, select, [data-project-card]")) return;

    const scrollContainer = kanbanScrollRef.current;
    if (!scrollContainer) return;

    kanbanPanRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: scrollContainer.scrollLeft,
      panning: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handleKanbanPanPointerMove(event) {
    const pan = kanbanPanRef.current;
    const scrollContainer = kanbanScrollRef.current;
    if (!pan || !scrollContainer || pan.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - pan.startX;
    const deltaY = event.clientY - pan.startY;

    if (!pan.panning) {
      if (Math.abs(deltaX) < 8) return;
      if (Math.abs(deltaY) > Math.abs(deltaX)) {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        cleanupKanbanPan();
        return;
      }
      pan.panning = true;
      startKanbanPanCursor();
    }

    event.preventDefault();
    scrollContainer.scrollLeft = pan.scrollLeft - deltaX;
  }

  function handleKanbanPanPointerEnd(event) {
    const pan = kanbanPanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    cleanupKanbanPan();
  }

  function handleProjectPointerDown(event, projectId) {
    if (event.pointerType === "mouse" && event.button !== 0) return;

    event.stopPropagation();
    if (event.pointerType === "mouse") {
      event.preventDefault();
    }
    const cardRect = event.currentTarget.getBoundingClientRect();
    pointerDragRef.current = {
      projectId,
      pointerId: event.pointerId,
      pointerType: event.pointerType || "mouse",
      targetElement: event.currentTarget,
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
      offsetX: event.clientX - cardRect.left,
      offsetY: event.clientY - cardRect.top,
      width: cardRect.width,
      dragging: false,
      holdCancelled: false,
      pointerMoved: false,
      scrolling: false,
      scrollLeft: kanbanScrollRef.current?.scrollLeft || 0,
      holdTimerId: window.setTimeout(beginProjectDrag, PROJECT_DRAG_HOLD_MS),
    };
    if (event.pointerType === "mouse") {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
  }

  function handleProjectPointerMove(event) {
    const drag = pointerDragRef.current;
    if (!drag) return;

    drag.currentX = event.clientX;
    drag.currentY = event.clientY;

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    const distance = Math.hypot(deltaX, deltaY);

    if (!drag.dragging) {
      if (distance > PROJECT_DRAG_MOVE_CANCEL_PX) {
        drag.pointerMoved = true;
      }

      if (drag.pointerType !== "mouse" && distance > PROJECT_DRAG_MOVE_CANCEL_PX) {
        clearProjectDragHoldTimer(drag);
        drag.holdCancelled = true;
        drag.scrolling = Math.abs(deltaX) >= Math.abs(deltaY);
        return;
      }

      if (drag.scrolling) {
        event.preventDefault();
        const scrollContainer = kanbanScrollRef.current;
        if (scrollContainer) {
          scrollContainer.scrollLeft = drag.scrollLeft - deltaX;
        }
      }

      if (drag.pointerType === "mouse" && drag.pointerMoved) {
        event.preventDefault();
      }
      return;
    }

    event.preventDefault();
    setDragPreview({
      projectId: drag.projectId,
      left: event.clientX - drag.offsetX,
      top: event.clientY - drag.offsetY,
      width: drag.width,
    });
    setProjectDragTargetFromPoint(event.clientX, event.clientY);
    updateProjectDragAutoScroll(event.clientX);
  }

  function cleanupProjectDrag() {
    clearProjectDragHoldTimer();
    const previousBodyStyle = bodyDragStyleRef.current;
    if (previousBodyStyle) {
      document.body.style.cursor = previousBodyStyle.cursor;
      document.body.style.userSelect = previousBodyStyle.userSelect;
      document.body.style.webkitUserSelect = previousBodyStyle.webkitUserSelect;
    }
    bodyDragStyleRef.current = null;
    pointerDragRef.current = null;
    stopProjectDragAutoScroll();
    setTouchDragProjectId(null);
    setDragTargetStatus("");
    setDragPreview(null);
  }

  function handleProjectPointerEnd(event) {
    const drag = pointerDragRef.current;
    if (!drag) return;

    event.currentTarget.releasePointerCapture?.(event.pointerId);

    if (!drag.dragging) {
      const shouldOpenProject = !drag.scrolling && !drag.holdCancelled && !drag.pointerMoved;
      cleanupProjectDrag();
      if (!shouldOpenProject) {
        suppressProjectClickOnce();
        return;
      }

      const project = projects.find((item) => item.id === drag.projectId);
      if (project) openProject(project);
      return;
    }

    event.preventDefault();
    suppressProjectClickOnce();

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
        <ProjectDragGhost
          project={draggedProject}
          amount={draggedProjectAmount}
          ageDays={draggedProjectAgeDays}
          left={dragPreview.left}
          top={dragPreview.top}
          width={dragPreview.width}
        />
      )}
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-end">
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
        <div
          ref={kanbanScrollRef}
          className="-mx-4 cursor-grab select-none overflow-x-auto px-4 pb-3 active:cursor-grabbing sm:mx-0 sm:px-0"
          onPointerDown={handleKanbanPanPointerDown}
          onPointerMove={handleKanbanPanPointerMove}
          onPointerUp={handleKanbanPanPointerEnd}
          onPointerCancel={handleKanbanPanPointerEnd}
          style={{ touchAction: "pan-x pan-y" }}
        >
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
                          data-project-card
                          onPointerDown={(event) => handleProjectPointerDown(event, project.id)}
                          onPointerMove={handleProjectPointerMove}
                          onPointerUp={handleProjectPointerEnd}
                          onPointerCancel={cleanupProjectDrag}
                          style={{ touchAction: "pan-x pan-y" }}
                        >
                          <ProjectKanbanCard
                            project={project}
                            amount={amount}
                            ageDays={ageDays}
                            showAgeDays={status.value !== terminalStatusValue}
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
            const total = projectAmount(project, paymentsByProject);
            const bonusUsed = projectReferralBonus(project);
            const plannedAmount = Number(project?.total_amount || 0);
            const latestPayment = rows[0];
            const statusMeta = statusMap.get(project.status);

            return (
              <Card key={project.id}>
                <CardBody className="p-6 sm:p-8">
                  <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
                    <div className="space-y-4">
                      <div className="flex flex-wrap items-center gap-3">
                        {projectOrderLabel(project) ? (
                          <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-black text-blue-600">
                            №{projectOrderLabel(project)}
                          </span>
                        ) : null}
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
                    </div>

                    <div className="grid min-w-[240px] gap-3 lg:grid-cols-2 xl:grid-cols-1">
                      <div className="rounded-[28px] bg-slate-50 px-5 py-4 ring-1 ring-slate-200/70">
                        <div className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Сумма</div>
                        {bonusUsed > 0 ? (
                          <div className="mt-2 text-sm font-bold text-slate-400 line-through">{formatMoney(plannedAmount)} ₽</div>
                        ) : null}
                        <div className={`${bonusUsed > 0 ? "mt-0.5" : "mt-2"} text-2xl font-black text-slate-900`}>
                          {formatMoney(total)} ₽
                        </div>
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
                        {paymentCategoryLabel(latestPayment)} • {formatMoney(latestPayment.amount)} ₽ • {formatDate(latestPayment.paid_at)}
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
              {selectedCreateClient ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-700">
                  <div className="min-w-0">
                    <div className="truncate text-base font-black">{selectedCreateClient.client_name || "Клиент без имени"}</div>
                    <div className="mt-0.5 text-xs font-bold text-blue-500">Выбран клиент</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {phoneHref(selectedCreateClient.client_phone) && (
                      <a
                        className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-black text-blue-600 shadow-sm transition hover:bg-blue-100"
                        href={phoneHref(selectedCreateClient.client_phone)}
                      >
                        <Phone size={13} />
                        Позвонить
                      </a>
                    )}
                    <button
                      type="button"
                      className="rounded-full bg-white/70 px-3 py-1.5 text-xs font-black text-slate-500 transition hover:bg-white hover:text-slate-800"
                      onClick={clearCreateClientSelection}
                    >
                      Сменить
                    </button>
                  </div>
                </div>
              ) : (
                <Input
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel"
                  value={createForm.client_query}
                  onChange={(event) => handleCreateClientQuery(event.target.value)}
                  onFocus={() => {
                    if (!createForm.client_query) handleCreateClientQuery("+7-");
                  }}
                  placeholder="Введите телефон клиента"
                />
              )}
            </div>
            {createClientLookup.queryReady && (
              <div className="space-y-2 md:col-span-2">
                {createClientLookup.matches.length > 0 ? (
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
                        value={createForm.client_phone}
                        onChange={(event) => {
                          const phone = formatRussianPhoneInput(event.target.value);
                          setCreateForm((prev) => ({ ...prev, client_phone: phone, client_query: phone || prev.client_query }));
                        }}
                        onFocus={() => {
                          if (!createForm.client_phone) {
                            setCreateForm((prev) => ({ ...prev, client_phone: "+7-", client_query: "+7-" }));
                          }
                        }}
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
                onChange={(event) => setCreateForm((prev) => ({ ...prev, total_amount: formatAmountInput(event.target.value) }))}
                inputMode="numeric"
                placeholder="Например, 120 000"
              />
            </div>
            <div className="space-y-3 md:col-span-2">
              <label className="flex items-center gap-3 rounded-2xl bg-slate-50 px-4 py-3 text-sm font-black text-slate-700 ring-1 ring-slate-200/70">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-blue-600"
                  checked={createBonusEnabled}
                  onChange={(event) => {
                    setCreateBonusEnabled(event.target.checked);
                    if (!event.target.checked) {
                      setCreateForm((prev) => ({ ...prev, bonus_promo_code: "" }));
                    }
                  }}
                />
                <span>Использовать бонусы / промокод</span>
              </label>
              {createBonusEnabled ? (
                <>
                  <Input
                    value={createForm.bonus_promo_code}
                    onChange={(event) => setCreateForm((prev) => ({ ...prev, bonus_promo_code: normalizePromoCodeInput(event.target.value) }))}
                    inputMode="numeric"
                    maxLength={5}
                    placeholder="Последние 5 цифр телефона"
                  />
                  {createBonusPreviewLoading ? (
                    <div className="rounded-2xl bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-500">
                      Проверяем промокод...
                    </div>
                  ) : null}
                  {createBonusPreviewError ? (
                    <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
                      {createBonusPreviewError}
                    </div>
                  ) : null}
                  {createBonusPreview ? (
                    <div className="rounded-2xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                      <div className="font-black">Промокод найден: {createBonusPreview.referrer_name}</div>
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        <span className="font-bold text-slate-400 line-through">
                          {formatMoney(createBonusPreview.original_total_amount)} ₽
                        </span>
                        <span className="text-lg font-black text-emerald-700">
                          {formatMoney(createBonusPreview.discounted_total_amount)} ₽
                        </span>
                        <span className="rounded-full bg-white px-3 py-1 text-xs font-black text-emerald-700">
                          Бонусами: −{formatMoney(createBonusPreview.redeem_amount)} ₽
                        </span>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>

          <ProjectCustomFieldsGrid
            fields={customFields}
            values={createForm.custom_fields}
            onChange={(fieldId, value) =>
              setCreateForm((prev) => ({
                ...prev,
                custom_fields: {
                  ...(prev.custom_fields || {}),
                  [fieldId]: value,
                },
              }))
            }
          />

          {createError && <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{createError}</div>}

          <div className="flex justify-end gap-3">
            <Button type="button" variant="secondary" onClick={closeCreateModal}>
              Отмена
            </Button>
            <Button type="submit" disabled={createSaving || createBonusPreviewLoading}>
              {createSaving ? "Создаём..." : createBonusPreviewLoading ? "Проверяем..." : "Создать"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(activeProject)}
        title={
          activeProject
            ? (projectOrderLabel(activeProject) ? `Проект №${projectOrderLabel(activeProject)}` : "Проект")
            : ""
        }
        headerContent={activeProject ? (
          <div className="grid min-w-0 flex-1 grid-cols-2 items-center gap-2 pr-2 sm:grid-cols-[auto_minmax(220px,1fr)_minmax(150px,0.55fr)_minmax(130px,0.45fr)] sm:gap-3 sm:pr-4">
            <div className="col-span-2 whitespace-nowrap text-base font-black uppercase tracking-tight text-slate-900 sm:col-span-1 sm:text-xl">
              №{projectOrderLabel(activeProject) || activeProject.id}
            </div>
            <Input
              className="col-span-2 h-10 min-w-0 py-2 font-bold sm:col-span-1"
              value={detailForm.title}
              onChange={(event) => setDetailForm((prev) => ({ ...prev, title: event.target.value }))}
              aria-label="Наименование проекта"
              placeholder="Наименование проекта"
            />
            <Select
              className="h-10 min-w-0 py-2 font-semibold"
              value={detailForm.status}
              onChange={(event) => setDetailForm((prev) => ({ ...prev, status: event.target.value }))}
              aria-label="Статус проекта"
            >
              {statusOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            <div className="relative min-w-0">
              <Input
                className="h-10 min-w-0 py-2 pr-7 font-black"
                value={detailForm.total_amount}
                onChange={(event) => setDetailForm((prev) => ({ ...prev, total_amount: formatAmountInput(event.target.value) }))}
                inputMode="numeric"
                aria-label="Стоимость проекта"
                placeholder="120 000"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-black text-slate-400">₽</span>
            </div>
          </div>
        ) : null}
        onClose={closeProject}
        widthClassName="max-w-6xl"
        bodyClassName="min-h-0 overflow-x-hidden bg-white"
        positionClassName="items-start"
        overlayClassName="bg-slate-950/25 backdrop-blur-sm backdrop-saturate-75"
      >
        {activeProject && (
          <div className="space-y-5">
            <div className="space-y-5">
              <div className="grid overflow-hidden rounded-[22px] border border-slate-200 bg-slate-50/70 md:grid-cols-[1.1fr_1.35fr]">
                <div className="min-w-0 border-b border-slate-200 p-4 md:border-b-0 md:border-r">
                  <div className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">Клиент</div>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <button
                      type="button"
                      className="min-w-0 text-left"
                      onClick={activeProjectClient?.id ? openProjectClientCard : undefined}
                      disabled={!activeProjectClient?.id}
                    >
                      <div className="truncate text-sm font-black text-slate-900 transition hover:text-blue-600 sm:text-base">
                        {detailForm.client_name || "Клиент не привязан"}
                      </div>
                      <div className="mt-1 truncate text-xs font-semibold text-slate-400">
                        {activeProjectClient?.id ? "Открыть карточку клиента" : "Выберите или создайте клиента ниже"}
                      </div>
                    </button>
                    <div className="flex shrink-0 items-center gap-2">
                      {phoneHref(detailForm.client_phone) ? (
                        <a
                          className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white text-blue-600 shadow-sm ring-1 ring-slate-200 transition hover:bg-blue-50"
                          href={phoneHref(detailForm.client_phone)}
                          title="Позвонить клиенту"
                          aria-label="Позвонить клиенту"
                        >
                          <Phone size={17} />
                        </a>
                      ) : null}
                      {maxMessageUrl ? (
                        <a
                          className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white text-blue-600 shadow-sm ring-1 ring-slate-200 transition hover:bg-blue-50"
                          href={maxMessageUrl}
                          title="Написать клиенту в MAX"
                          aria-label="Написать клиенту в MAX"
                        >
                          <MessageSquare size={17} />
                        </a>
                      ) : null}
                    </div>
                  </div>
                  {activeProjectClient?.id ? (
                    <div className="mt-3 space-y-3 border-t border-slate-200 pt-3">
                      <label className="flex cursor-pointer items-center gap-2 text-xs font-black text-slate-700">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-slate-300 text-blue-600 disabled:opacity-50"
                          checked={detailBonusEnabled || Boolean(Number(activeProject.referral_bonus_used || 0))}
                          disabled={Boolean(Number(activeProject.referral_bonus_used || 0))}
                          onChange={(event) => {
                            setDetailBonusEnabled(event.target.checked);
                            if (!event.target.checked) {
                              setDetailForm((prev) => ({ ...prev, bonus_promo_code: "" }));
                            }
                          }}
                        />
                        <span>Использовать бонусы / промокод</span>
                      </label>
                      {detailBonusEnabled || Boolean(Number(activeProject.referral_bonus_used || 0)) ? (
                        <Input
                          className="h-10 bg-white"
                          value={detailForm.bonus_promo_code}
                          onChange={(event) => setDetailForm((prev) => ({ ...prev, bonus_promo_code: normalizePromoCodeInput(event.target.value) }))}
                          inputMode="numeric"
                          maxLength={5}
                          disabled={Boolean(Number(activeProject.referral_bonus_used || 0))}
                          placeholder="Последние 5 цифр телефона"
                        />
                      ) : null}
                      <button
                        type="button"
                        className="text-xs font-bold text-red-500 transition hover:text-red-700 disabled:cursor-wait disabled:opacity-60"
                        onClick={detachProjectClient}
                        disabled={projectClientDetaching}
                      >
                        {projectClientDetaching ? "Открепляем..." : "Открепить клиента"}
                      </button>
                    </div>
                  ) : null}
                </div>

                <button
                  type="button"
                  className="group min-w-0 p-4 text-left transition hover:bg-white"
                  onClick={() => setAddressDetailsOpen(true)}
                >
                  <div className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">Адрес</div>
                  <div className="mt-2 flex items-center gap-3">
                    <div className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-700">
                      {detailForm.object_address || "Укажите адрес объекта"}
                    </div>
                    <span
                      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-blue-600 shadow-sm ring-1 ring-slate-200 transition group-hover:bg-blue-50"
                      onClick={(event) => {
                        if (!routeLinks.webUrl) return;
                        event.stopPropagation();
                        openYandexRouteLinks(routeLinks);
                      }}
                      title="Построить маршрут"
                    >
                      <MapPin size={17} />
                    </span>
                  </div>
                </button>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                {!activeProjectClient?.id ? (
                  <div className="space-y-2 rounded-[22px] border border-slate-200 bg-slate-50/70 p-4 md:col-span-2">
                    <Label>Выбрать клиента</Label>
                      <div className="mt-4 space-y-3">
                        <Input
                          type="text"
                          inputMode="search"
                          value={projectClientQuery}
                          onChange={(event) => {
                            setProjectClientQuery(formatClientLookupInput(event.target.value));
                            setProjectNewClientName("");
                          }}
                          placeholder="Введите имя или телефон клиента"
                        />
                        {projectClientLookup.queryReady && projectClientLookup.matches.length > 0 ? (
                          <div className="space-y-2">
                            {projectClientLookup.matches.map((client) => (
                              <button
                                key={client.key}
                                type="button"
                                onClick={() => attachProjectClient(client)}
                                disabled={projectClientAttaching}
                                className="flex w-full items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left shadow-sm transition hover:border-blue-200 hover:bg-blue-50 disabled:cursor-wait disabled:opacity-60"
                              >
                                <div className="min-w-0">
                                  <div className="truncate font-black text-slate-800">{client.client_name || "Клиент без имени"}</div>
                                  <div className="mt-1 truncate text-xs font-semibold text-slate-500">
                                    {client.client_phone || "телефон не указан"} • {client.object_address || "адрес не указан"}
                                  </div>
                                </div>
                                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-50 px-3 py-1 text-xs font-black text-blue-600">
                                  <Link size={13} />
                                  Выбрать
                                </span>
                              </button>
                            ))}
                          </div>
                        ) : null}
                        {projectClientCanCreate ? (
                          <div className="rounded-2xl bg-white px-3 py-3 ring-1 ring-slate-200">
                            <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-400">
                              Клиент не найден
                            </div>
                            <div className="mt-2 text-sm font-semibold text-slate-500">
                              Можно создать новую карточку и сразу привязать её к проекту.
                            </div>
                            <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                              {projectClientQueryHasPhone ? (
                                <Input
                                  value={projectNewClientName}
                                  onChange={(event) => setProjectNewClientName(event.target.value)}
                                  placeholder="Имя клиента"
                                />
                              ) : (
                                <div className="rounded-2xl bg-slate-50 px-4 py-3 text-sm font-black text-slate-800">
                                  {projectClientQuery.trim()}
                                </div>
                              )}
                              <Button
                                type="button"
                                className="justify-center"
                                onClick={createAndAttachProjectClient}
                                disabled={projectClientAttaching}
                              >
                                {projectClientAttaching ? "Прикрепляем..." : "Создать клиента"}
                              </Button>
                            </div>
                            {projectClientQueryHasPhone ? (
                              <div className="mt-2 text-xs font-semibold text-slate-400">
                                Телефон возьмём из поля клиента.
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                  </div>
                ) : null}

                {addressDetailsOpen ? (
                <div className="space-y-3 rounded-[22px] border border-slate-200 bg-slate-50/70 p-4 md:col-span-2">
                  <div className="flex items-center justify-between gap-3">
                    <Label>Адрес объекта</Label>
                    <button
                      type="button"
                      className="text-xs font-bold text-slate-400 transition hover:text-slate-700"
                      onClick={() => setAddressDetailsOpen(false)}
                    >
                      Скрыть
                    </button>
                  </div>
                  <div className="relative">
                    <Input
                      className="pr-14"
                      value={detailForm.object_address}
                      onClick={() => setAddressDetailsOpen(true)}
                      onFocus={() => setAddressDetailsOpen(true)}
                      onChange={(event) => {
                        selectedAddressValueRef.current = "";
                        setDetailForm((prev) => ({
                          ...prev,
                          object_address: event.target.value,
                          object_lat: "",
                          object_lon: "",
                        }));
                      }}
                      placeholder={hasDadataAddressSuggestions() ? "Начните вводить адрес" : "Адрес объекта"}
                    />
                    <button
                      type="button"
                      className="absolute right-2 top-1/2 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white text-blue-600 shadow-sm ring-1 ring-slate-200 transition hover:bg-blue-50 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-white"
                      disabled={!routeLinks.webUrl}
                      onClick={() => openYandexRouteLinks(routeLinks)}
                      title="Построить маршрут"
                      aria-label="Построить маршрут"
                    >
                      <MapPin size={18} />
                    </button>
                  </div>
                    <div className="mt-3 space-y-3 rounded-[18px] border border-slate-200 bg-white p-4 shadow-sm">
                      {hasDadataAddressSuggestions() && (addressSuggestLoading || addressSuggestions.length > 0 || addressSuggestError) ? (
                        <div className="space-y-2">
                          {addressSuggestLoading ? (
                            <div className="rounded-2xl bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-400">
                              Ищем адрес...
                            </div>
                          ) : null}
                          {addressSuggestions.length > 0 ? (
                            <div className="space-y-2">
                              {addressSuggestions.map((suggestion) => (
                                <button
                                  key={`${suggestion.value}-${suggestion.lat}-${suggestion.lon}`}
                                  type="button"
                                  className="w-full rounded-2xl bg-slate-50 px-3 py-2 text-left text-sm font-semibold text-slate-700 transition hover:bg-blue-50 hover:text-blue-700"
                                  onClick={() => applyAddressSuggestion(suggestion)}
                                >
                                  {suggestion.value}
                                </button>
                              ))}
                            </div>
                          ) : null}
                          {addressSuggestError && (
                            <div className="rounded-2xl bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-500">
                              {addressSuggestError}
                            </div>
                          )}
                        </div>
                      ) : null}

                      <div className="grid gap-3 sm:grid-cols-3">
                        <div className="space-y-2">
                          <Label>Квартира</Label>
                          <Input
                            value={detailForm.apartment}
                            onChange={(event) => setDetailForm((prev) => ({ ...prev, apartment: event.target.value }))}
                            placeholder="12"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Подъезд</Label>
                          <Input
                            value={detailForm.entrance}
                            onChange={(event) => setDetailForm((prev) => ({ ...prev, entrance: event.target.value }))}
                            placeholder="3"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Этаж</Label>
                          <Input
                            value={detailForm.floor}
                            onChange={(event) => setDetailForm((prev) => ({ ...prev, floor: event.target.value }))}
                            placeholder="7"
                          />
                        </div>
                      </div>

                    </div>
                </div>
                ) : null}
              </div>

              <div className={`grid gap-4 ${customFields.length ? "xl:grid-cols-[minmax(0,1fr)_minmax(420px,0.9fr)]" : ""}`}>
                <ProjectCustomFieldsGrid
                  fields={customFields}
                  values={detailForm.custom_fields}
                  projectId={activeProject.id}
                  onFileUpload={handleCustomFieldFileUpload}
                  onFilePreview={setCustomFieldPreview}
                  uploadingFiles={customFieldUploads}
                  onChange={(fieldId, value) =>
                    setDetailForm((prev) => ({
                      ...prev,
                      custom_fields: {
                        ...(prev.custom_fields || {}),
                        [fieldId]: value,
                      },
                    }))
                  }
                />

                <div className="rounded-[24px] border border-slate-200 bg-slate-50/70 p-4">
                  <div className="flex items-center gap-2 text-sm font-black text-slate-900">
                    <FolderOpen size={17} className="text-blue-600" />
                    Яндекс.Диск и документы
                  </div>
                  <div className="mt-1 flex items-center gap-3">
                    <div className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-400">
                      {activeProject.yandex_disk_path || "Папка проекта пока не создана"}
                    </div>
                    {activeProject.yandex_disk_web_url ? (
                      <button
                        type="button"
                        className="shrink-0 text-xs font-bold text-slate-400 transition hover:text-blue-600"
                        onClick={handleYandexDiskFolderCreate}
                        disabled={yandexDiskCreating}
                      >
                        {yandexDiskCreating ? "Создаём..." : "Пересоздать"}
                      </button>
                    ) : null}
                  </div>
                  {activeProject.yandex_disk_error ? (
                    <div className="mt-3 rounded-2xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
                      {activeProject.yandex_disk_error}
                    </div>
                  ) : null}
                  <div className="mt-4 grid gap-2 sm:grid-cols-3">
                    {activeProject.yandex_disk_web_url ? (
                      <Button
                        type="button"
                        variant="secondary"
                        className="justify-center px-3"
                        onClick={() => window.open(activeProject.yandex_disk_web_url, "_blank", "noopener,noreferrer")}
                      >
                        <FolderOpen size={16} />
                        Открыть папку
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="secondary"
                        className="justify-center px-3"
                        onClick={handleYandexDiskFolderCreate}
                        disabled={yandexDiskCreating}
                      >
                        <FolderOpen size={16} />
                        {yandexDiskCreating ? "Создаём..." : "Создать папку"}
                      </Button>
                    )}
                    {detailForm.works_with_contract ? (
                      <>
                        <Button
                          type="button"
                          variant="secondary"
                          className="justify-center px-3"
                          onClick={() => handleDocumentDownload("contract")}
                          disabled={documentLoading}
                        >
                          <FileText size={16} />
                          {documentLoading ? "Формируем..." : "Договор"}
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          className="justify-center px-3"
                          onClick={() => handleDocumentDownload("act")}
                          disabled={documentLoading}
                        >
                          <FileText size={16} />
                          {documentLoading ? "Формируем..." : "Акт"}
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>

            {detailError && <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{detailError}</div>}
            {projectStatusChecksLoading ? (
              <div className="rounded-[24px] bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-500">
                Проверяем проект...
              </div>
            ) : projectStatusChecks?.issues?.length ? (
              <div className="rounded-[24px] bg-white p-4 ring-1 ring-slate-200">
                <div className="flex items-center gap-2 text-sm font-black text-slate-900">
                  <AlertTriangle size={17} className="text-amber-500" />
                  Требует внимания перед закрытием
                </div>
                <div className="mt-3 grid gap-2 md:grid-cols-2">
                  {projectStatusChecks.issues.map((issue, index) => (
                    <div
                      key={`${issue.code || issue.title}-${index}`}
                      className={`rounded-2xl px-3 py-2 text-sm font-semibold ring-1 ${projectCheckToneClass(issue.severity)}`}
                    >
                      <div className="font-black">{issue.title}</div>
                      {issue.message ? <div className="mt-1 text-xs leading-5 opacity-80">{issue.message}</div> : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="no-scrollbar flex gap-2 overflow-x-auto border-b border-slate-200">
              <button
                type="button"
                className={`inline-flex shrink-0 items-center gap-2 border-b-2 px-4 py-3 text-sm font-bold transition ${
                  detailTab === "comments"
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-slate-400 hover:text-slate-700"
                }`}
                onClick={() => setDetailTab("comments")}
              >
                <MessageSquare size={16} />
                Комментарии
              </button>
              <button
                type="button"
                className={`inline-flex shrink-0 items-center gap-2 border-b-2 px-4 py-3 text-sm font-bold transition ${
                  detailTab === "tasks"
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-slate-400 hover:text-slate-700"
                }`}
                onClick={() => setDetailTab("tasks")}
              >
                <ListTodo size={16} />
                Задачи
              </button>
              <button
                type="button"
                className={`inline-flex shrink-0 items-center gap-2 border-b-2 px-4 py-3 text-sm font-bold transition ${
                  detailTab === "finances"
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-slate-400 hover:text-slate-700"
                }`}
                onClick={() => setDetailTab("finances")}
              >
                <Wallet size={16} />
                Финансы
              </button>
              <button
                type="button"
                className={`inline-flex shrink-0 items-center gap-2 border-b-2 px-4 py-3 text-sm font-bold transition ${
                  detailTab === "activity"
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-slate-400 hover:text-slate-700"
                }`}
                onClick={() => setDetailTab("activity")}
              >
                <History size={16} />
                Лента
              </button>
            </div>

            {detailTab === "comments" ? (
              <Card className="overflow-hidden border border-slate-200 shadow-none ring-0">
                <CardBody className="space-y-4 p-4 sm:p-5">
                  <div className="space-y-3">
                    {commentsLoading ? (
                      <div className="rounded-[20px] bg-slate-50 px-4 py-5 text-sm text-slate-500">Загружаем комментарии...</div>
                    ) : comments.length === 0 ? (
                      <div className="rounded-[20px] bg-slate-50 px-4 py-5 text-sm text-slate-500">
                        Пока нет комментариев.
                      </div>
                    ) : (
                      comments.map((comment) => (
                        <div key={comment.id} className="rounded-[20px] border border-slate-200 bg-slate-50/70 px-4 py-3">
                          <div className="flex items-start justify-between gap-4">
                            <div>
                              <div className="text-sm font-black text-slate-900">{comment.author_name || `Пользователь #${comment.author}`}</div>
                              <div className="mt-1 text-xs text-slate-400">{formatDateTime(comment.created_at)}</div>
                            </div>
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                className="rounded-full p-2 text-slate-400 transition hover:bg-white hover:text-blue-600"
                                onClick={() => startCommentEdit(comment)}
                                aria-label="Редактировать комментарий"
                              >
                                <Pencil size={16} />
                              </button>
                              <button
                                type="button"
                                className="rounded-full p-2 text-slate-400 transition hover:bg-white hover:text-red-600"
                                onClick={() => requestDeleteComment(comment.id)}
                                aria-label="Удалить комментарий"
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </div>
                          {editingCommentId === comment.id ? (
                            <div className="mt-3 space-y-3">
                              <textarea
                                className="min-h-24 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10"
                                value={editingCommentText}
                                onChange={(event) => setEditingCommentText(event.target.value)}
                              />
                              <div className="flex flex-wrap justify-end gap-2">
                                <Button type="button" variant="secondary" disabled={commentUpdating} onClick={cancelCommentEdit}>
                                  Отмена
                                </Button>
                                <Button type="button" disabled={commentUpdating} onClick={() => submitCommentEdit(comment.id)}>
                                  {commentUpdating ? "Сохраняем..." : "Сохранить"}
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-600">{comment.text}</div>
                          )}
                        </div>
                      ))
                    )}
                  </div>

                  <form className="border-t border-slate-100 pt-4" onSubmit={submitComment}>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                      <textarea
                        className="min-h-12 flex-1 resize-y rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10"
                        value={commentText}
                        onChange={(event) => setCommentText(event.target.value)}
                        placeholder="Написать комментарий..."
                      />
                      <Button type="submit" className="h-12 justify-center sm:shrink-0" disabled={commentSaving}>
                        {commentSaving ? "Сохраняем..." : "Отправить"}
                      </Button>
                    </div>
                    {commentError ? <div className="mt-3 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{commentError}</div> : null}
                  </form>
                </CardBody>
              </Card>
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
            ) : detailTab === "finances" ? (
              <div className="space-y-6">
                <Card className="border border-slate-100 shadow-none ring-0">
                  <CardHeader>
                    <div className="text-lg font-black tracking-tight text-slate-900">Деньги по проекту сейчас</div>
                    <div className="mt-1 text-sm text-slate-500">
                      Считаем только фактические операции на сегодня: поступления минус расходники.
                    </div>
                  </CardHeader>
                  <CardBody>
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                      <div className="rounded-[24px] border border-slate-100 bg-slate-50 p-4">
                        <div className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-400">Сумма проекта</div>
                        <div className="mt-3 text-2xl font-black tracking-tight text-slate-900">
                          {formatMoney(activeProjectFinanceSummary.projectTotal)} ₽
                        </div>
                        <div className="mt-1 text-xs font-semibold text-slate-400">
                          Осталось получить: {formatMoney(activeProjectFinanceSummary.remainingToReceive)} ₽
                        </div>
                      </div>
                      <div className="rounded-[24px] border border-emerald-100 bg-emerald-50 p-4">
                        <div className="text-[11px] font-black uppercase tracking-[0.18em] text-emerald-500">Аванс / оплаты</div>
                        <div className="mt-3 text-2xl font-black tracking-tight text-emerald-700">
                          {formatMoney(activeProjectFinanceSummary.income)} ₽
                        </div>
                        <div className="mt-1 text-xs font-semibold text-emerald-500">Поступило на проект</div>
                      </div>
                      <div className="rounded-[24px] border border-red-100 bg-red-50 p-4">
                        <div className="text-[11px] font-black uppercase tracking-[0.18em] text-red-500">Расходники</div>
                        <div className="mt-3 text-2xl font-black tracking-tight text-red-700">
                          {formatMoney(activeProjectFinanceSummary.expenses)} ₽
                        </div>
                        <div className="mt-1 text-xs font-semibold text-red-500">Уже списано по проекту</div>
                      </div>
                      <div
                        className={`rounded-[24px] border p-4 ${
                          activeProjectFinanceSummary.balance < 0
                            ? "border-red-200 bg-red-600 text-white"
                            : "border-slate-900 bg-slate-950 text-white"
                        }`}
                      >
                        <div className="text-[11px] font-black uppercase tracking-[0.18em] opacity-70">Сейчас в проекте</div>
                        <div className="mt-3 text-2xl font-black tracking-tight">
                          {activeProjectFinanceSummary.balance < 0 ? "− " : ""}
                          {formatMoney(Math.abs(activeProjectFinanceSummary.balance))} ₽
                        </div>
                        <div className="mt-1 text-xs font-semibold opacity-70">Фактический остаток денег</div>
                      </div>
                    </div>

                    {activeProjectFinanceSummary.futurePayments ? (
                      <div className="mt-4 rounded-2xl bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-700">
                        Запланированные будущие операции не входят в текущий остаток: {activeProjectFinanceSummary.futurePayments}
                      </div>
                    ) : null}
                  </CardBody>
                </Card>

                <Card className="border border-slate-100 shadow-none ring-0">
                  <CardHeader>
                    <div className="text-lg font-black tracking-tight text-slate-900">
                      {editingPaymentId ? "Редактировать операцию" : "Добавить операцию"}
                    </div>
                    <div className="mt-1 text-sm text-slate-500">
                      {editingPaymentId
                        ? "Изменения сразу обновят карточку проекта и общий раздел финансов."
                        : "Операция сразу появится в карточке проекта и в разделе финансов."}
                    </div>
                  </CardHeader>
                  <CardBody>
                    <form className="space-y-4" onSubmit={submitPayment}>
                      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                        <div className="space-y-2">
                          <Label>Доход / расход</Label>
                          <Select value={paymentForm.category_kind} onChange={(event) => handlePaymentCategoryKindChange(event.target.value)}>
                            <option value="">Выберите тип</option>
                            <option value="income">Доход</option>
                            <option value="expense">Расход</option>
                          </Select>
                        </div>
                        {paymentForm.category_kind ? (
                          <div className="space-y-2">
                            <Label>{paymentForm.category_kind === "expense" ? "Категория расхода" : "Категория дохода"}</Label>
                            <Select value={paymentForm.category} onChange={(event) => handlePaymentCategoryChange(event.target.value)}>
                              <option value="">Выберите категорию</option>
                              {paymentCategoryOptions.map((category) => (
                                <option key={category.value} value={category.value}>
                                  {category.label}
                                </option>
                              ))}
                            </Select>
                          </div>
                        ) : null}
                        <div className="space-y-2">
                          <Label>Сумма</Label>
                          <Input
                            value={paymentForm.amount}
                            onChange={(event) => setPaymentForm((prev) => ({ ...prev, amount: event.target.value }))}
                            placeholder="25000"
                          />
                        </div>
                        {hasMultipleAccounts ? (
                          <div className="space-y-2">
                            <Label>Счет</Label>
                            <Select
                              value={paymentForm.account}
                              onChange={(event) => setPaymentForm((prev) => ({ ...prev, account: event.target.value }))}
                            >
                              <option value="">Выберите счет</option>
                              {accounts.map((account) => (
                                <option key={account.id} value={account.id}>
                                  {account.name}
                                </option>
                              ))}
                            </Select>
                          </div>
                        ) : null}
                        <div className="space-y-2">
                          <Label>Дата</Label>
                          <Input
                            type="date"
                            min={editingPaymentId ? undefined : todayDateValue()}
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

                      <div className="flex flex-wrap gap-3">
                        <Button type="submit" disabled={paymentSaving}>
                          {paymentSaving ? "Сохраняем..." : editingPaymentId ? "Сохранить операцию" : "Добавить операцию"}
                        </Button>
                        {editingPaymentId ? (
                          <Button type="button" variant="secondary" onClick={cancelPaymentEdit}>
                            Отменить редактирование
                          </Button>
                        ) : null}
                      </div>
                    </form>
                  </CardBody>
                </Card>

                <Card className="border border-slate-100 shadow-none ring-0">
                  <CardHeader>
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                      <div>
                        <div className="text-lg font-black tracking-tight text-slate-900">Журнал операций</div>
                        <div className="mt-1 text-xs font-semibold text-slate-400">
                          {paymentSearch.trim()
                            ? `Найдено ${filteredActiveProjectPayments.length} из ${activeProjectPayments.length}`
                            : `${activeProjectPayments.length} операций`}
                        </div>
                      </div>
                      <div className="relative w-full md:max-w-sm">
                        <Search
                          size={17}
                          aria-hidden="true"
                          className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"
                        />
                        <Input
                          type="search"
                          value={paymentSearch}
                          onChange={(event) => setPaymentSearch(event.target.value)}
                          className="pl-11"
                          placeholder="Категория, сумма, дата, комментарий..."
                          aria-label="Поиск финансовых операций по проекту"
                        />
                      </div>
                    </div>
                  </CardHeader>
                  <CardBody>
                    {activeProjectPayments.length === 0 ? (
                      <div className="rounded-[24px] bg-slate-50 px-4 py-6 text-sm text-slate-500">
                        По этому проекту ещё нет операций.
                      </div>
                    ) : filteredActiveProjectPayments.length === 0 ? (
                      <div className="rounded-[24px] bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                        <div>По запросу «{paymentSearch.trim()}» операций не найдено.</div>
                        <Button type="button" variant="secondary" className="mt-4" onClick={() => setPaymentSearch("")}>
                          Очистить поиск
                        </Button>
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[760px] text-left text-sm">
                          <thead className="text-slate-400">
                            <tr>
                              <th className="pb-3 font-black uppercase tracking-[0.18em]">Дата</th>
                              <th className="pb-3 font-black uppercase tracking-[0.18em]">Тип</th>
                              <th className="pb-3 font-black uppercase tracking-[0.18em]">Сумма</th>
                              {hasMultipleAccounts ? <th className="pb-3 font-black uppercase tracking-[0.18em]">Счет</th> : null}
                              <th className="pb-3 font-black uppercase tracking-[0.18em]">Комментарий</th>
                              <th className="pb-3 text-right font-black uppercase tracking-[0.18em]">Действие</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredActiveProjectPayments.map((payment) => {
                              const signedAmount = paymentDisplaySignedAmount(payment);
                              const futurePayment = isFuturePayment(payment);
                              return (
                                <tr key={payment.id} className="border-t border-slate-100">
                                  <td className="py-4 text-slate-500">{formatDateTime(payment.paid_at)}</td>
                                  <td className="py-4">
                                    <Badge className={paymentCategoryBadgeClass(payment)}>{paymentCategoryLabel(payment)}</Badge>
                                    {futurePayment ? <Badge className="ml-2 bg-blue-50 text-blue-600">Запланировано</Badge> : null}
                                  </td>
                                  <td className={`py-4 font-semibold ${signedAmount < 0 ? "text-red-600" : "text-emerald-600"}`}>
                                    {signedAmount < 0 ? "−" : "+"} {formatMoney(Math.abs(signedAmount))} ₽
                                  </td>
                                  {hasMultipleAccounts ? <td className="py-4 text-slate-500">{payment.account_name || "—"}</td> : null}
                                  <td className="py-4 text-slate-500">{payment.comment || "—"}</td>
                                  <td className="py-4 text-right">
                                    <div className="flex justify-end gap-2">
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        className="h-10 w-10 px-0 text-blue-600 hover:bg-blue-50"
                                        onClick={() => startPaymentEdit(payment)}
                                        title="Редактировать"
                                        aria-label="Редактировать операцию"
                                      >
                                        <Pencil size={16} />
                                      </Button>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        className="h-10 w-10 px-0 text-red-600 hover:bg-red-50"
                                        onClick={() => requestDeletePayment(payment.id)}
                                        title="Удалить"
                                        aria-label="Удалить операцию"
                                      >
                                        <Trash2 size={16} />
                                      </Button>
                                    </div>
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
            ) : (
              <Card className="border border-slate-100 shadow-none ring-0">
                <CardHeader>
                  <div className="flex items-center gap-2 text-lg font-black tracking-tight text-slate-900">
                    <History size={18} />
                    Лента проекта
                  </div>
                  <div className="mt-1 text-sm text-slate-500">
                    Здесь собираются изменения карточки, комментарии, задачи и финансовые операции.
                  </div>
                </CardHeader>
                <CardBody>
                  {projectActivityLoading ? (
                    <div className="rounded-[24px] bg-slate-50 px-4 py-6 text-sm text-slate-500">
                      Загружаем ленту...
                    </div>
                  ) : projectActivity.length === 0 ? (
                    <div className="rounded-[24px] bg-slate-50 px-4 py-6 text-sm text-slate-500">
                      В ленте пока нет событий.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {projectActivity.map((event) => (
                        <div key={event.id || `${event.type}-${event.created_at}`} className="rounded-[24px] bg-slate-50 px-4 py-4 ring-1 ring-slate-100">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                              <div className="text-sm font-black text-slate-900">{projectActivityLabel(event)}</div>
                              {event.description ? (
                                <div className="mt-1 text-sm font-semibold leading-5 text-slate-600">{event.description}</div>
                              ) : null}
                            </div>
                            <div className="shrink-0 text-xs font-semibold text-slate-400">{formatDateTime(event.created_at)}</div>
                          </div>
                          <div className="mt-3 text-xs font-black uppercase tracking-[0.16em] text-slate-400">
                            {event.actor_name || "CRM"}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardBody>
              </Card>
            )}

            <div className="flex justify-center border-t border-slate-100 pt-5">
              <Button type="button" variant="danger" className="w-full justify-center sm:w-auto" onClick={requestDeleteProject}>
                <Trash2 size={16} />
                Удалить проект
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(customFieldPreview)}
        title={customFieldPreview?.name || "Просмотр файла"}
        onClose={() => setCustomFieldPreview(null)}
        widthClassName="max-w-5xl"
        bodyClassName="bg-slate-950/95 p-3 sm:p-5"
        positionClassName="items-center"
        overlayClassName="bg-slate-950/70 backdrop-blur-sm"
      >
        {customFieldPreview ? (
          <div className="space-y-4">
            <div className="overflow-hidden rounded-[24px] bg-black">
              <img
                src={customFieldPreview.url}
                alt={customFieldPreview.name || "Файл проекта"}
                className="mx-auto max-h-[68dvh] w-auto max-w-full object-contain"
              />
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="secondary" onClick={() => setCustomFieldPreview(null)}>
                Вернуться в CRM
              </Button>
              <Button type="button" onClick={() => window.open(customFieldPreview.url, "_blank", "noopener,noreferrer")}>
                Открыть оригинал
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={projectClientOpen && Boolean(activeProjectClient)}
        title={activeProjectClient?.name ? `Клиент · ${activeProjectClient.name}` : "Карточка клиента"}
        onClose={closeProjectClientCard}
        widthClassName="max-w-2xl"
      >
        <form className="space-y-5" onSubmit={submitProjectClient}>
          <div className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-slate-200">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="truncate text-xl font-black text-slate-950">
                  {activeProjectClient?.name || projectClientForm.name || "Клиент без имени"}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge className="gap-1.5 bg-blue-50 text-blue-700">
                    <Users size={13} />
                    {activeProjectClient?.project_count || 0} проект(ов)
                  </Badge>
                  <Badge className="gap-1.5 bg-emerald-50 text-emerald-700">
                    <Gift size={13} />
                    Бонусы {formatMoney(activeProjectClient?.bonus_balance || 0)} ₽
                  </Badge>
                  {activeProjectClient?.works_with_contract ? (
                    <Badge className="bg-slate-100 text-slate-700">Договор</Badge>
                  ) : null}
                </div>
              </div>

              <div className="flex shrink-0 gap-2">
                {phoneHref(activeProjectClient?.phone || projectClientForm.phone) ? (
                  <a
                    className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-blue-50 text-blue-600 ring-1 ring-blue-100 transition hover:bg-blue-100"
                    href={phoneHref(activeProjectClient?.phone || projectClientForm.phone)}
                    title="Позвонить клиенту"
                    aria-label="Позвонить клиенту"
                  >
                    <Phone size={18} />
                  </a>
                ) : null}
                {projectClientMaxUrl ? (
                  <a
                    className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-slate-950 text-white ring-1 ring-slate-950 transition hover:bg-slate-800"
                    href={projectClientMaxUrl}
                    title="Написать в MAX"
                    aria-label="Написать в MAX"
                  >
                    <MessageSquare size={18} />
                  </a>
                ) : null}
              </div>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <ClientInfoTile
                icon={Phone}
                label="Телефон"
                value={activeProjectClient?.phone || projectClientForm.phone}
                href={phoneHref(activeProjectClient?.phone || projectClientForm.phone)}
              />
              <ClientInfoTile
                icon={Mail}
                label="Email"
                value={activeProjectClient?.email || projectClientForm.email}
                href={(activeProjectClient?.email || projectClientForm.email) ? `mailto:${activeProjectClient?.email || projectClientForm.email}` : ""}
              />
              <div className="sm:col-span-2">
                <ClientInfoTile
                  icon={MapPin}
                  label="Адрес"
                  value={activeProjectClient?.address || projectClientForm.address}
                  onClick={projectClientRouteLinks.webUrl ? () => openYandexRouteLinks(projectClientRouteLinks) : null}
                />
              </div>
              <ClientInfoTile icon={MapPin} label="Квартира" value={activeProjectClient?.apartment || projectClientForm.apartment} />
              <ClientInfoTile icon={MapPin} label="Этаж" value={activeProjectClient?.floor || projectClientForm.floor} />
              <ClientInfoTile icon={Ticket} label="Промокод" value={activeProjectClient?.promo_code || "Недоступен без телефона"} />
              <ClientInfoTile icon={Wallet} label="Бонусный счёт" value={`${formatMoney(activeProjectClient?.bonus_balance || 0)} ₽`} />
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.18em] text-slate-400">
            <Pencil size={14} />
            Редактирование клиента
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label>Имя клиента</Label>
              <Input
                value={projectClientForm.name}
                onChange={(event) => setProjectClientForm((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="Иван Петров"
                autoComplete="name"
              />
            </div>
            {projectClientForm.works_with_contract ? (
              <div className="space-y-2 sm:col-span-2">
                <Label>ФИО для договора и акта</Label>
                <Input
                  value={projectClientForm.contract_full_name}
                  onChange={(event) => setProjectClientForm((prev) => ({ ...prev, contract_full_name: event.target.value }))}
                  placeholder="Иванов Иван Иванович"
                  autoComplete="name"
                />
              </div>
            ) : null}
            <div className="space-y-2">
              <Label>Телефон</Label>
              <Input
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                value={projectClientForm.phone}
                onChange={(event) => setProjectClientForm((prev) => ({ ...prev, phone: formatRussianPhoneInput(event.target.value) }))}
                onFocus={() => {
                  if (!projectClientForm.phone) setProjectClientForm((prev) => ({ ...prev, phone: "+7-" }));
                }}
                placeholder="+7..."
              />
            </div>
            <div className="space-y-2">
              <Label>Email</Label>
              <Input
                type="email"
                autoComplete="email"
                value={projectClientForm.email}
                onChange={(event) => setProjectClientForm((prev) => ({ ...prev, email: event.target.value }))}
                placeholder="client@example.ru"
              />
            </div>
            <ClientAddressFields
              form={projectClientForm}
              setForm={setProjectClientForm}
              addressLabel="Адрес клиента"
              addressPlaceholder="Начните вводить адрес клиента"
            />
          </div>

          <label className="flex items-start gap-3 rounded-[22px] bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-600 ring-1 ring-slate-200/70">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-600"
              checked={projectClientForm.works_with_contract}
              onChange={(event) =>
                setProjectClientForm((prev) => ({ ...prev, works_with_contract: event.target.checked }))
              }
            />
            <span>
              Работает по договору. Если включено, в проекте можно сформировать договор по загруженному шаблону.
            </span>
          </label>

          {projectClientError && <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{projectClientError}</div>}

          <div className="flex justify-end gap-3">
            <Button type="button" variant="secondary" onClick={closeProjectClientCard} disabled={projectClientSaving}>
              Отмена
            </Button>
            <Button type="submit" disabled={projectClientSaving}>
              {projectClientSaving ? "Сохраняем..." : "Сохранить клиента"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={documentIdentityPrompt.open}
        title="ФИО для документа"
        onClose={() => {
          if (!documentIdentitySaving) {
            setDocumentIdentityPrompt({ open: false, type: "contract", fullName: "" });
            setDocumentIdentityError("");
          }
        }}
        widthClassName="max-w-lg"
      >
        <form className="space-y-4" onSubmit={submitDocumentIdentity}>
          <p className="text-sm font-semibold leading-6 text-slate-600">
            В карточке клиента нет полного ФИО. Оно сохранится у клиента и будет использовано в договоре и акте.
          </p>
          <div className="space-y-2">
            <Label>Фамилия, имя и отчество</Label>
            <Input
              value={documentIdentityPrompt.fullName}
              onChange={(event) => setDocumentIdentityPrompt((prev) => ({ ...prev, fullName: event.target.value }))}
              placeholder="Иванов Иван Иванович"
              autoComplete="name"
              autoFocus
            />
          </div>
          {documentIdentityError ? (
            <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{documentIdentityError}</div>
          ) : null}
          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="secondary"
              disabled={documentIdentitySaving}
              onClick={() => setDocumentIdentityPrompt({ open: false, type: "contract", fullName: "" })}
            >
              Отмена
            </Button>
            <Button type="submit" disabled={documentIdentitySaving}>
              {documentIdentitySaving ? "Сохраняем..." : "Сохранить и сформировать"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(confirmState)}
        title={confirmState?.title || "Подтвердите действие"}
        onClose={() => {
          if (!confirmDeleting) {
            setConfirmState(null);
            setConfirmText("");
            setConfirmError("");
          }
        }}
        widthClassName="max-w-xl"
      >
        <div className="space-y-5">
          <div className="rounded-[24px] bg-slate-50 px-4 py-4 text-sm leading-6 text-slate-600">
            {confirmState?.message}
          </div>

          {confirmState?.kind === "project" ? (
            <div className="space-y-2">
              <Label>Для удаления скопируйте и введите слово</Label>
              <div className="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 px-3 py-2 text-sm text-slate-600 ring-1 ring-slate-200">
                <code className="select-all rounded-xl bg-white px-3 py-1.5 font-bold text-slate-900 ring-1 ring-slate-200">удалить</code>
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-2 text-xs font-bold text-blue-600 ring-1 ring-blue-100 transition hover:bg-blue-50"
                  onClick={() => navigator.clipboard?.writeText("удалить").catch(() => {})}
                >
                  <Copy size={14} />
                  Скопировать
                </button>
              </div>
              <Input
                value={confirmText}
                onChange={(event) => {
                  setConfirmText(event.target.value);
                  setConfirmError("");
                }}
                placeholder="удалить"
                autoComplete="off"
              />
              {confirmError && <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{confirmError}</div>}
            </div>
          ) : null}

          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="secondary"
              disabled={confirmDeleting}
              onClick={() => {
                setConfirmState(null);
                setConfirmText("");
                setConfirmError("");
              }}
            >
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
