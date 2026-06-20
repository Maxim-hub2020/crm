import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  Camera,
  Calendar,
  Check,
  Copy,
  FileText,
  Gift,
  LayoutGrid,
  List,
  ListTodo,
  MapPin,
  MessageSquare,
  Pencil,
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
  fetchAddressSuggestions,
  fetchAccounts,
  fetchClients,
  fetchFinanceCategories,
  fetchPayments,
  fetchProjectComments,
  fetchProjectCustomFields,
  fetchProjects,
  fetchProjectStatuses,
  fetchTasks,
  hasDadataAddressSuggestions,
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
import { clientPhoneValidationError, normalizeOptionalClientPhone, phoneDigits } from "../utils/phone.js";

const VIEW_MODE_KEY = "crm_projects_view_mode";

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
    phone: client.phone || client.client_phone || "",
    email: client.email || client.client_email || "",
    address: client.address || client.object_address || "",
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

function customFieldValueSearchText(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return [value.name, value.original_name, value.url, value.content_type].filter(Boolean).join(" ");
  }
  return String(value || "");
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

function yandexRouteUrl(address, lat = "", lon = "") {
  const cleanAddress = cleanAddressForMaps(address);
  const cleanLat = String(lat || "").trim();
  const cleanLon = String(lon || "").trim();
  const destination = cleanLat && cleanLon ? `${cleanLat},${cleanLon}` : cleanAddress;
  if (!destination) return "";
  return `https://yandex.ru/maps/?mode=routes&rtext=~${encodeURIComponent(destination)}&ruri=~&rtt=auto`;
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

function isFuturePayment(payment) {
  return toDateInputValue(payment?.paid_at) > todayDateValue();
}

function projectSearchText(project, statusMap) {
  const status = statusMap.get(project.status);
  return normalizeSearchText(
    [
      project.title,
      projectOrderLabel(project),
      project.order_number,
      project.client_name,
      project.client_phone,
      project.client_email,
      project.object_address,
      project.bonus_promo_code,
      project.apartment,
      project.entrance,
      project.floor,
      project.description,
      ...Object.values(project.custom_fields || {}).map(customFieldValueSearchText),
      status?.label,
      status?.short,
    ]
      .filter(Boolean)
      .join(" ")
  );
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
  return rows.reduce((sum, payment) => sum + paymentSignedAmount(payment), 0);
}

function paymentDisplaySignedAmount(payment) {
  const amount = Number(payment?.amount || 0);
  if (payment?.category_type === "expense") return -amount;
  if (payment?.category_type === "income") return amount;
  return payment?.type === "refund" || payment?.type === "correction" ? -amount : amount;
}

function paymentSignedAmount(payment) {
  if (isFuturePayment(payment)) return 0;
  return paymentDisplaySignedAmount(payment);
}

function paymentCategoryLabel(payment) {
  return payment?.category_name || "Без категории";
}

function paymentCategoryBadgeClass(payment) {
  if (payment?.category_type === "expense") return "bg-red-50 text-red-600";
  if (payment?.category_type === "income") return "bg-emerald-50 text-emerald-600";
  return "bg-slate-100 text-slate-600";
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
      url: value.url || "",
      size: Number(value.size || 0) || 0,
    };
  }
  return { name: String(value), url: "", size: 0 };
}

function formatFileSize(bytes) {
  const size = Number(bytes || 0);
  if (!size) return "";
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} КБ`;
  return `${(size / (1024 * 1024)).toFixed(1).replace(".", ",")} МБ`;
}

function ProjectCustomFieldsGrid({ fields, values, onChange, projectId, onFileUpload, uploadingFiles = {} }) {
  if (!fields.length) return null;

  return (
    <div className="rounded-[24px] border border-slate-100 bg-slate-50/70 p-4">
      <div className="grid gap-4 md:grid-cols-2">
        {fields.map((field) => {
          const fieldKey = String(field.id);
          const isFileField = field.field_type === "file";
          const fileValue = isFileField ? customFieldFileDisplay(values?.[fieldKey]) : null;
          const uploadId = `project-custom-field-${projectId || "new"}-${fieldKey}`;
          const cameraId = `project-custom-camera-${projectId || "new"}-${fieldKey}`;
          const isUploading = Boolean(uploadingFiles[fieldKey]);

          if (isFileField) {
            const handleFileChange = (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file && onFileUpload) {
                onFileUpload(fieldKey, file);
              }
            };

            return (
              <div key={field.id} className="space-y-2">
                <Label>{field.name}</Label>
                <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
                  {fileValue ? (
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      {fileValue.url ? (
                        <a
                          href={fileValue.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-2 text-sm font-bold text-blue-600 hover:text-blue-700"
                        >
                          <FileText size={16} />
                          {fileValue.name}
                        </a>
                      ) : (
                        <div className="inline-flex items-center gap-2 text-sm font-bold text-slate-700">
                          <FileText size={16} />
                          {fileValue.name}
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        {fileValue.size ? (
                          <span className="text-xs font-semibold text-slate-400">{formatFileSize(fileValue.size)}</span>
                        ) : null}
                        <button
                          type="button"
                          className="rounded-full p-2 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                          onClick={() => onChange(fieldKey, "")}
                          aria-label="Убрать файл"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm font-semibold text-slate-400">Файл не прикреплён</div>
                  )}

                  {projectId && onFileUpload ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <input id={uploadId} className="sr-only" type="file" onChange={handleFileChange} />
                      <input
                        id={cameraId}
                        className="sr-only"
                        type="file"
                        accept="image/*"
                        capture="environment"
                        onChange={handleFileChange}
                      />
                      <label
                        htmlFor={uploadId}
                        className={`btn-hover inline-flex cursor-pointer items-center justify-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 shadow-sm transition hover:bg-slate-50 ${
                          isUploading ? "pointer-events-none opacity-60" : ""
                        }`}
                      >
                        <FileText size={16} />
                        {isUploading ? "Загружаем..." : "Прикрепить файл"}
                      </label>
                      <label
                        htmlFor={cameraId}
                        className={`btn-hover inline-flex cursor-pointer items-center justify-center gap-2 rounded-full bg-slate-900 px-4 py-2 text-sm font-bold text-white shadow-sm transition hover:bg-black ${
                          isUploading ? "pointer-events-none opacity-60" : ""
                        }`}
                      >
                        <Camera size={16} />
                        Сфотографировать
                      </label>
                    </div>
                  ) : (
                    <div className="mt-3 rounded-2xl bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-500">
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

function ProjectBonusSummary({ project, client }) {
  const clientBalance = Number(client?.bonus_balance ?? project?.client_info?.bonus_balance ?? 0);
  const accruedAmount = Number(project?.bonus_accrued_amount || 0);
  const referralAmount = Number(project?.referral_bonus_used || 0);
  const promoCode = project?.bonus_promo_code || "";

  if (!project && !clientBalance) return null;

  return (
    <div className="rounded-[24px] border border-blue-100 bg-blue-50/60 px-4 py-4">
      <div className="mb-3 flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.2em] text-blue-500">
        <Gift size={14} />
        Бонусы клиента
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-2xl bg-white px-4 py-3 ring-1 ring-blue-100">
          <div className="text-xs font-bold text-slate-400">Бонусный счёт</div>
          <div className="mt-1 text-lg font-black text-slate-900">{formatMoney(clientBalance)} ₽</div>
        </div>
        <div className="rounded-2xl bg-white px-4 py-3 ring-1 ring-blue-100">
          <div className="text-xs font-bold text-slate-400">Начислено за заказ</div>
          <div className="mt-1 text-lg font-black text-emerald-600">{formatMoney(accruedAmount)} ₽</div>
        </div>
        <div className="rounded-2xl bg-white px-4 py-3 ring-1 ring-blue-100">
          <div className="text-xs font-bold text-slate-400">По промокоду</div>
          <div className="mt-1 text-lg font-black text-blue-600">
            {referralAmount ? `${formatMoney(referralAmount)} ₽` : promoCode || "Не применён"}
          </div>
          {project?.referred_by_client_name ? (
            <div className="mt-1 text-xs font-semibold text-slate-400">Рекомендатель: {project.referred_by_client_name}</div>
          ) : null}
        </div>
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
        <div className="text-[1.05rem] font-black tracking-tight text-blue-600">{formatMoney(amount)} ₽</div>
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
        <div className="text-[1.05rem] font-black tracking-tight text-blue-600">{formatMoney(amount)} ₽</div>
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
  const [query, setQuery] = useState(location.state?.q || "");
  const deferredQuery = useDeferredValue(query);
  const [viewMode, setViewMode] = useState(() => localStorage.getItem(VIEW_MODE_KEY) || "kanban");
  const [touchDragProjectId, setTouchDragProjectId] = useState(null);
  const [dragTargetStatus, setDragTargetStatus] = useState("");
  const [dragPreview, setDragPreview] = useState(null);
  const pointerDragRef = useRef(null);
  const suppressProjectClickRef = useRef(false);
  const bodyDragStyleRef = useRef(null);
  const kanbanScrollRef = useRef(null);
  const dragAutoScrollRef = useRef(null);
  const dragAutoScrollFrameRef = useRef(null);

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
  const [addressDetailsOpen, setAddressDetailsOpen] = useState(false);
  const [addressSuggestions, setAddressSuggestions] = useState([]);
  const [addressSuggestLoading, setAddressSuggestLoading] = useState(false);
  const [addressSuggestError, setAddressSuggestError] = useState("");
  const selectedAddressValueRef = useRef("");
  const loadedProjectIdRef = useRef(null);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [customFieldUploads, setCustomFieldUploads] = useState({});
  const [projectClientOpen, setProjectClientOpen] = useState(false);
  const [projectClientForm, setProjectClientForm] = useState(createClientEditForm());
  const [projectClientSaving, setProjectClientSaving] = useState(false);
  const [projectClientError, setProjectClientError] = useState("");

  const [comments, setComments] = useState([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
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
    const tokens = normalizeSearchText(deferredQuery).split(/\s+/).filter(Boolean);
    if (!tokens.length) return projects;

    return projects.filter((project) => {
      const searchText = projectSearchText(project, statusMap);
      return tokens.every((token) => searchText.includes(token));
    });
  }, [deferredQuery, projects, statusMap]);

  const projectSearchResults = useMemo(() => {
    const tokens = normalizeSearchText(deferredQuery).split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    return filteredProjects.slice(0, 8);
  }, [deferredQuery, filteredProjects]);

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

  const routeUrl = useMemo(
    () => yandexRouteUrl(detailForm.object_address, detailForm.object_lat, detailForm.object_lon),
    [detailForm.object_address, detailForm.object_lat, detailForm.object_lon]
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
    setAddressDetailsOpen(false);
    setAddressSuggestions([]);
    setAddressSuggestError("");
    setCustomFieldUploads({});
    setProjectClientOpen(false);
    setProjectClientError("");
    setProjectClientForm(createClientEditForm());
    selectedAddressValueRef.current = "";
    loadedProjectIdRef.current = null;
    detailSnapshotRef.current = "";
    window.clearTimeout(detailAutosaveTimerRef.current);
  }

  async function handleCustomFieldFileUpload(fieldId, file) {
    if (!activeProject?.id || !file) return;

    const fieldKey = String(fieldId);
    setCustomFieldUploads((prev) => ({ ...prev, [fieldKey]: true }));
    setDetailError("");

    try {
      const result = await uploadProjectCustomFieldFile(activeProject.id, fieldKey, file);
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
        phone: normalizeOptionalClientPhone(projectClientForm.phone),
        email: projectClientForm.email.trim() || null,
        address: projectClientForm.address.trim() || null,
        works_with_contract: Boolean(projectClientForm.works_with_contract),
      });

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
            object_address: project.object_address || updated.address || "",
            works_with_contract: Boolean(updated.works_with_contract),
          };
        })
      );
      setDetailForm((prev) => {
        const objectAddress = prev.object_address || updated.address || "";
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
          works_with_contract: Boolean(updated.works_with_contract),
        };
      });
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
      const promoCode = normalizePromoCodeInput(createForm.bonus_promo_code);
      if (promoCode && promoCode.length !== 5) {
        setCreateError("Промокод должен состоять из последних 5 цифр телефона.");
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
      if (isPastDateValue(paymentForm.paid_at)) {
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

  function handleProjectPointerDown(event, projectId) {
    if (event.pointerType === "mouse" && event.button !== 0) return;

    event.preventDefault();
    const cardRect = event.currentTarget.getBoundingClientRect();
    pointerDragRef.current = {
      projectId,
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
      offsetX: event.clientX - cardRect.left,
      offsetY: event.clientY - cardRect.top,
      width: cardRect.width,
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
      setDragPreview({
        projectId: drag.projectId,
        left: event.clientX - drag.offsetX,
        top: event.clientY - drag.offsetY,
        width: drag.width,
      });
      setProjectDragTargetFromPoint(event.clientX, event.clientY);
      updateProjectDragAutoScroll(event.clientX);
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
        <ProjectDragGhost
          project={draggedProject}
          amount={draggedProjectAmount}
          ageDays={draggedProjectAgeDays}
          left={dragPreview.left}
          top={dragPreview.top}
          width={dragPreview.width}
        />
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
          {projectSearchResults.length > 0 && (
            <div className="absolute left-0 right-0 top-[calc(100%+0.5rem)] z-30 overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-[0_24px_60px_rgba(15,23,42,0.12)]">
              {projectSearchResults.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className="block w-full border-b border-slate-100 px-4 py-3 text-left transition last:border-b-0 hover:bg-blue-50"
                  onClick={() => {
                    setQuery("");
                    openProject(project);
                  }}
                >
                  <div className="flex items-center gap-2">
                    {projectOrderLabel(project) ? (
                      <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-black text-blue-600">
                        №{projectOrderLabel(project)}
                      </span>
                    ) : null}
                    <div className="font-black text-slate-900">{projectDisplayName(project)}</div>
                  </div>
                  <div className="mt-1 line-clamp-1 text-sm font-semibold text-slate-500">
                    {[project.client_name, project.object_address, statusMap.get(project.status)?.label].filter(Boolean).join(" · ")}
                  </div>
                </button>
              ))}
            </div>
          )}
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
        <div ref={kanbanScrollRef} className="-mx-4 select-none overflow-x-auto px-4 pb-3 sm:mx-0 sm:px-0">
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
            const total = rows.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
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
                onChange={(event) => setCreateForm((prev) => ({ ...prev, total_amount: formatAmountInput(event.target.value) }))}
                inputMode="numeric"
                placeholder="Например, 120 000"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>Бонусы / промокод</Label>
              <Input
                value={createForm.bonus_promo_code}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, bonus_promo_code: normalizePromoCodeInput(event.target.value) }))}
                inputMode="numeric"
                maxLength={5}
                placeholder="Последние 5 цифр телефона клиента-рекомендателя"
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
            <Button type="submit" disabled={createSaving}>
              {createSaving ? "Создаём..." : "Создать"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(activeProject)}
        title={
          activeProject
            ? `${projectOrderLabel(activeProject) ? `№${projectOrderLabel(activeProject)} · ` : ""}${projectDisplayName(activeProject)}`
            : ""
        }
        onClose={closeProject}
        widthClassName="max-w-5xl"
        bodyClassName="min-h-0"
        positionClassName="items-start pt-4 sm:pt-6"
        overlayClassName="bg-slate-950/30 backdrop-blur-md backdrop-saturate-75"
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
                  <div className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <button
                      type="button"
                      className="min-w-0 text-left"
                      onClick={openProjectClientCard}
                    >
                      <div className="truncate text-base font-black text-slate-900 transition hover:text-blue-600">
                        {detailForm.client_name || "Клиент не указан"}
                      </div>
                      <div className="mt-1 text-xs font-semibold text-slate-400">
                        Открыть карточку клиента
                      </div>
                    </button>
                    {phoneHref(detailForm.client_phone) ? (
                      <a
                        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white text-blue-600 shadow-sm ring-1 ring-slate-200 transition hover:bg-blue-50"
                        href={phoneHref(detailForm.client_phone)}
                        title="Позвонить клиенту"
                        aria-label="Позвонить клиенту"
                      >
                        <Phone size={18} />
                      </a>
                    ) : (
                      <span
                        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white text-slate-300 ring-1 ring-slate-200"
                        title="Телефон клиента не указан"
                        aria-label="Телефон клиента не указан"
                      >
                        <Phone size={18} />
                      </span>
                    )}
                  </div>
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label>Адрес объекта</Label>
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
                      disabled={!routeUrl}
                      onClick={() => routeUrl && window.open(routeUrl, "_blank", "noopener,noreferrer")}
                      title="Построить маршрут"
                      aria-label="Построить маршрут"
                    >
                      <MapPin size={18} />
                    </button>
                  </div>
                  {addressDetailsOpen && (
                    <div className="mt-3 space-y-3 rounded-[24px] border border-slate-200 bg-white p-4 shadow-[0_18px_40px_rgba(15,23,42,0.08)]">
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
                    onChange={(event) => setDetailForm((prev) => ({ ...prev, total_amount: formatAmountInput(event.target.value) }))}
                    inputMode="numeric"
                    placeholder="Например, 120 000"
                  />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label>Бонусы / промокод</Label>
                  <Input
                    value={detailForm.bonus_promo_code}
                    onChange={(event) => setDetailForm((prev) => ({ ...prev, bonus_promo_code: normalizePromoCodeInput(event.target.value) }))}
                    inputMode="numeric"
                    maxLength={5}
                    disabled={Boolean(Number(activeProject.referral_bonus_used || 0))}
                    placeholder="Последние 5 цифр телефона клиента-рекомендателя"
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

              <ProjectCustomFieldsGrid
                fields={customFields}
                values={detailForm.custom_fields}
                projectId={activeProject.id}
                onFileUpload={handleCustomFieldFileUpload}
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

              <ProjectBonusSummary project={activeProject} client={activeProjectClient} />

              {detailForm.works_with_contract ? (
                <div className="flex justify-end rounded-[24px] bg-slate-50 px-4 py-3 ring-1 ring-slate-200/70">
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
                </div>
              ) : null}
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
              <Card className="border border-slate-100 shadow-none ring-0">
                <CardHeader>
                  <div className="text-lg font-black tracking-tight text-slate-900">Комментарии</div>
                </CardHeader>
                <CardBody className="space-y-5">
                  <form className="space-y-3" onSubmit={submitComment}>
                    <textarea
                      className="min-h-28 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10"
                      value={commentText}
                      onChange={(event) => setCommentText(event.target.value)}
                      placeholder="Например: согласовали замер на пятницу, ждём предоплату..."
                    />

                    {commentError && <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{commentError}</div>}

                    <Button type="submit" disabled={commentSaving}>
                      {commentSaving ? "Сохраняем..." : "Добавить комментарий"}
                    </Button>
                  </form>

                  <div className="space-y-4 border-t border-slate-100 pt-5">
                    {commentsLoading ? (
                      <div className="rounded-[24px] bg-slate-50 px-4 py-6 text-sm text-slate-500">Загружаем комментарии...</div>
                    ) : comments.length === 0 ? (
                      <div className="rounded-[24px] bg-slate-50 px-4 py-6 text-sm text-slate-500">
                        Пока нет комментариев.
                      </div>
                    ) : (
                      comments.map((comment) => (
                        <div key={comment.id} className="rounded-[24px] border border-slate-100 bg-slate-50 px-4 py-4">
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
            ) : (
              <div className="space-y-6">
                <Card className="border border-slate-100 shadow-none ring-0">
                  <CardHeader>
                    <div className="text-lg font-black tracking-tight text-slate-900">Добавить операцию</div>
                    <div className="mt-1 text-sm text-slate-500">Операция сразу появится в карточке проекта и в разделе финансов.</div>
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
                            min={todayDateValue()}
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
                              {hasMultipleAccounts ? <th className="pb-3 font-black uppercase tracking-[0.18em]">Счет</th> : null}
                              <th className="pb-3 font-black uppercase tracking-[0.18em]">Комментарий</th>
                              <th className="pb-3 text-right font-black uppercase tracking-[0.18em]">Действие</th>
                            </tr>
                          </thead>
                          <tbody>
                            {activeProjectPayments.map((payment) => {
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
        open={projectClientOpen && Boolean(activeProjectClient)}
        title="Карточка клиента"
        onClose={closeProjectClientCard}
        widthClassName="max-w-2xl"
      >
        <form className="space-y-5" onSubmit={submitProjectClient}>
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
            <div className="space-y-2">
              <Label>Телефон</Label>
              <Input
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                pattern="[0-9+()\\-\\s]*"
                value={projectClientForm.phone}
                onChange={(event) => setProjectClientForm((prev) => ({ ...prev, phone: event.target.value }))}
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
            <div className="space-y-2 sm:col-span-2">
              <Label>Адрес клиента</Label>
              <Input
                value={projectClientForm.address}
                onChange={(event) => setProjectClientForm((prev) => ({ ...prev, address: event.target.value }))}
                placeholder="Адрес клиента, если нужен для документов"
              />
            </div>
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
