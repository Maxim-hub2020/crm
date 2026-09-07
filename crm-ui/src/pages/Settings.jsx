import React, { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  Folder,
  FolderOpen,
  ExternalLink,
  CreditCard,
  FileText,
  GripVertical,
  HardDrive,
  Hash,
  Layers,
  ListTodo,
  Lock,
  MessageCircle,
  Plus,
  Settings as SettingsIcon,
  Sliders,
  Tag,
  Trash2,
  UploadCloud,
  Users2,
} from "lucide-react";

import {
  createAccount,
  createFinanceCategory,
  createProjectCustomField,
  createProjectStatus,
  createTaskTemplate,
  createUser,
  deleteAccount,
  deleteDocumentTemplate,
  deleteFinanceCategory,
  deleteProjectCustomField,
  deleteProjectStatus,
  deleteTaskTemplate,
  completeYandexDiskOAuth,
  extractApiErrorMessage,
  fetchAccounts,
  fetchChatSettings,
  fetchDocumentTemplates,
  fetchFinanceCategories,
  fetchProjectCustomFields,
  fetchProjectStatuses,
  fetchTaskTemplates,
  fetchYandexDiskFolders,
  fetchYandexDiskSettings,
  fetchUsers,
  startYandexDiskOAuth,
  updateTaskTemplate,
  updateFinanceCategory,
  updateProjectStatus,
  updateChatSettings,
  updateYandexDiskSettings,
  uploadDocumentTemplate,
} from "../api";
import { Button, Input, Modal, Select } from "../components/ui.jsx";
import { formatRussianPhoneInput } from "../utils/phone.js";

const STATUS_COLOR = "sky";

const FIELD_TYPE_LABELS = {
  text: "Текст",
  number: "Число",
  date: "Дата",
  file: "Файл",
};

function SettingsCard({ title, icon, children, className = "", defaultOpen = false }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={`overflow-hidden rounded-3xl border border-white/50 bg-white shadow-sm ${className}`}>
      <button
        type="button"
        className={`flex w-full items-center justify-between gap-3 bg-gray-50/30 px-6 py-4 text-left font-semibold text-gray-900 transition hover:bg-gray-100/70 ${isOpen ? "border-b border-gray-100" : ""}`}
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-indigo-600">{icon}</span>
          <span className="truncate text-xs font-black uppercase tracking-widest">{title}</span>
        </span>
        <ChevronDown size={18} className={`shrink-0 text-gray-400 transition-transform ${isOpen ? "rotate-180" : ""}`} />
      </button>
      {isOpen ? <div className="p-4 sm:p-6">{children}</div> : null}
    </div>
  );
}

function IconButton({ children, className = "", ...props }) {
  return (
    <button
      type="button"
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-900 text-white shadow-lg transition hover:bg-black ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

function DeleteButton({ className = "", ...props }) {
  return (
    <button type="button" className={`rounded-md p-1 text-gray-300 transition hover:bg-red-50 hover:text-red-500 ${className}`} {...props}>
      <Trash2 size={14} />
    </button>
  );
}

function reorderSettingsRows(rows, sourceId, targetId) {
  if (!sourceId || !targetId || String(sourceId) === String(targetId)) {
    return rows;
  }

  const nextRows = [...rows];
  const sourceIndex = nextRows.findIndex((item) => String(item.id) === String(sourceId));
  const targetIndex = nextRows.findIndex((item) => String(item.id) === String(targetId));

  if (sourceIndex < 0 || targetIndex < 0) {
    return rows;
  }

  const [moved] = nextRows.splice(sourceIndex, 1);
  nextRows.splice(targetIndex, 0, moved);
  return nextRows.map((item, index) => ({ ...item, sort_order: (index + 1) * 10 }));
}

function TemplateUploader({ label, templateType, templates, onUpload, onDelete, busy }) {
  const template = templates.find((item) => item.type === templateType);

  return (
    <div>
      <div className="mb-1.5 ml-1 text-[10px] font-bold uppercase tracking-widest text-gray-400">{label}</div>
      {template ? (
        <div className="flex items-center justify-between gap-3 rounded-lg bg-gray-100 p-2 pl-3">
          <div className="flex min-w-0 items-center gap-2">
            <FileText size={16} className="shrink-0 text-gray-500" />
            <a
              href={template.file_url}
              target="_blank"
              rel="noreferrer"
              className="truncate text-sm font-medium text-blue-600 hover:underline"
              title={template.original_name}
            >
              {template.original_name || `${templateType}.pdf`}
            </a>
          </div>
          <DeleteButton onClick={() => onDelete(template.id)} />
        </div>
      ) : (
        <label className="relative block">
          <input
            type="file"
            accept=".pdf,application/pdf"
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onUpload(templateType, file, template?.id);
              event.target.value = "";
            }}
          />
          <div className="flex items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-3 text-sm text-gray-500 transition hover:bg-gray-50">
            <UploadCloud size={18} />
            <span>{busy ? "Загружаем..." : "Загрузить PDF"}</span>
          </div>
        </label>
      )}
    </div>
  );
}

export default function Settings() {
  const [users, setUsers] = useState([]);
  const [statuses, setStatuses] = useState([]);
  const [categories, setCategories] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [customFields, setCustomFields] = useState([]);
  const [taskTemplates, setTaskTemplates] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [chatSettings, setChatSettings] = useState(null);
  const [yandexDiskSettings, setYandexDiskSettings] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draggedRow, setDraggedRow] = useState(null);
  const [reorderSaving, setReorderSaving] = useState("");

  const [managerForm, setManagerForm] = useState({ username: "", email: "", phone: "", password: "" });
  const [stageName, setStageName] = useState("");
  const [stageDays, setStageDays] = useState("3");
  const [categoryName, setCategoryName] = useState("");
  const [categoryType, setCategoryType] = useState("expense");
  const [accountName, setAccountName] = useState("");
  const [fieldName, setFieldName] = useState("");
  const [fieldType, setFieldType] = useState("text");
  const [taskTemplateForm, setTaskTemplateForm] = useState({ status: "", title: "", notes: "", due_in_days: "1", priority: "medium" });
  const [templateBusy, setTemplateBusy] = useState(false);
  const [chatSaving, setChatSaving] = useState(false);
  const [yandexDiskSaving, setYandexDiskSaving] = useState(false);
  const [yandexDiskConnecting, setYandexDiskConnecting] = useState(false);
  const [yandexDiskCodeSaving, setYandexDiskCodeSaving] = useState(false);
  const [yandexDiskCode, setYandexDiskCode] = useState("");
  const [diskPicker, setDiskPicker] = useState({
    open: false,
    target: "base_path",
    title: "",
    path: "disk:/",
    folders: [],
    loading: false,
    error: "",
  });
  const [chatForm, setChatForm] = useState({
    enabled: false,
    base_url: "",
    account_id: "",
    inbox_name: "",
    api_access_token: "",
  });
  const [yandexDiskForm, setYandexDiskForm] = useState({
    enabled: false,
    auto_create_project_folders: true,
    base_path: "/CRM/Проекты",
    archive_path: "/CRM/Архив",
    folder_template_text: "Визуализация\nЗакупочная смета\nМодель\nРаскрой\nСмета\nСогласование\nТЗ\nЧертежи",
  });

  async function reload() {
    const [userRows, statusRows, categoryRows, accountRows, fieldRows, taskTemplateRows, templateRows, chatRows, yandexDiskRows] = await Promise.all([
      fetchUsers(),
      fetchProjectStatuses(),
      fetchFinanceCategories(),
      fetchAccounts(),
      fetchProjectCustomFields(),
      fetchTaskTemplates(),
      fetchDocumentTemplates(),
      fetchChatSettings(),
      fetchYandexDiskSettings(),
    ]);

    setUsers(userRows);
    setStatuses(statusRows);
    setCategories(categoryRows);
    setAccounts(accountRows);
    setCustomFields(fieldRows);
    setTaskTemplates(taskTemplateRows);
    setTemplates(templateRows);
    setChatSettings(chatRows);
    setYandexDiskSettings(yandexDiskRows);
    setChatForm({
      enabled: Boolean(chatRows.enabled),
      base_url: chatRows.base_url || "",
      account_id: chatRows.account_id || "",
      inbox_name: chatRows.inbox_name || "",
      api_access_token: "",
    });
    setYandexDiskForm({
      enabled: Boolean(yandexDiskRows.enabled),
      auto_create_project_folders: Boolean(yandexDiskRows.auto_create_project_folders),
      base_path: yandexDiskRows.base_path || "/CRM/Проекты",
      archive_path: yandexDiskRows.archive_path || "/CRM/Архив",
      folder_template_text: yandexDiskRows.folder_template_text || "Визуализация\nЗакупочная смета\nМодель\nРаскрой\nСмета\nСогласование\nТЗ\nЧертежи",
    });
    setTaskTemplateForm((prev) => ({ ...prev, status: prev.status || statusRows[0]?.id || "" }));
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const yandexDiskStatus = params.get("yandex_disk");
    if (yandexDiskStatus === "connected") {
      setNotice("Яндекс.Диск подключен. Теперь CRM может создавать и переносить папки проектов.");
      window.history.replaceState({}, "", window.location.pathname);
    } else if (yandexDiskStatus === "error") {
      setError(params.get("message") || "Не удалось подключить Яндекс.Диск.");
      window.history.replaceState({}, "", window.location.pathname);
    }

    reload().catch((requestError) => {
      setError(extractApiErrorMessage(requestError, "Не удалось загрузить системные настройки."));
    });
  }, []);

  const managers = useMemo(() => users.filter((user) => user.role === "manager" || !user.is_admin), [users]);
  const financeCategoriesByType = useMemo(
    () => ({
      income: categories.filter((category) => category.type === "income"),
      expense: categories.filter((category) => category.type === "expense"),
    }),
    [categories]
  );
  const terminalStatusId = statuses[statuses.length - 1]?.id || null;

  async function handleAddManager(event) {
    event.preventDefault();
    if (!managerForm.username.trim() || !managerForm.password.trim()) return;

    try {
      await createUser({
        username: managerForm.username.trim(),
        email: managerForm.email.trim(),
        password: managerForm.password,
        first_name: managerForm.username.trim(),
        role: "manager",
      });
      setManagerForm({ username: "", email: "", phone: "", password: "" });
      await reload();
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось добавить менеджера."));
    }
  }

  async function handleAddStage() {
    if (!stageName.trim()) return;
    try {
      await createProjectStatus({
        name: stageName.trim(),
        color: STATUS_COLOR,
        stuck_after_days: Number(stageDays) || 3,
        sort_order: statuses.length > 0 ? Math.max(...statuses.map((item) => Number(item.sort_order || 0))) + 10 : 10,
      });
      setStageName("");
      setStageDays("3");
      await reload();
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось добавить этап."));
    }
  }

  async function handleStageDaysBlur(status) {
    try {
      await updateProjectStatus(status.id, { stuck_after_days: Number(status.stuck_after_days) || 3 });
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось сохранить количество дней."));
      await reload();
    }
  }

  function handleDragStart(event, row) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `${row.kind}:${row.id}`);
    setDraggedRow(row);
  }

  async function handleStatusDrop(targetId) {
    if (draggedRow?.kind !== "status") return;

    const orderedRows = reorderSettingsRows(statuses, draggedRow.id, targetId);
    setDraggedRow(null);
    if (orderedRows === statuses) return;

    setStatuses(orderedRows);
    setReorderSaving("statuses");
    try {
      await Promise.all(orderedRows.map((status) => updateProjectStatus(status.id, { sort_order: status.sort_order })));
      setError("");
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось сохранить порядок этапов."));
      await reload();
    } finally {
      setReorderSaving("");
    }
  }

  async function handleCategoryDrop(targetId, type) {
    if (draggedRow?.kind !== "category" || draggedRow.type !== type) return;

    const groupRows = financeCategoriesByType[type] || [];
    const orderedRows = reorderSettingsRows(groupRows, draggedRow.id, targetId);
    setDraggedRow(null);
    if (orderedRows === groupRows) return;

    const orderedMap = new Map(orderedRows.map((category) => [category.id, category]));
    setCategories((prev) => prev.map((category) => (category.type === type ? orderedMap.get(category.id) || category : category)));
    setReorderSaving(`categories-${type}`);
    try {
      await Promise.all(orderedRows.map((category) => updateFinanceCategory(category.id, { sort_order: category.sort_order })));
      setError("");
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось сохранить порядок финансовых категорий."));
      await reload();
    } finally {
      setReorderSaving("");
    }
  }

  async function handleAddCategory() {
    if (!categoryName.trim()) return;
    try {
      const typeRows = financeCategoriesByType[categoryType] || [];
      const nextOrder = typeRows.length > 0 ? Math.max(...typeRows.map((item) => Number(item.sort_order || 0))) + 10 : 10;
      await createFinanceCategory({ name: categoryName.trim(), type: categoryType, sort_order: nextOrder });
      setCategoryName("");
      await reload();
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось добавить категорию."));
    }
  }

  async function handleAddAccount() {
    if (!accountName.trim()) return;
    try {
      await createAccount({ name: accountName.trim() });
      setAccountName("");
      await reload();
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось добавить счет."));
    }
  }

  async function handleAddField() {
    if (!fieldName.trim()) return;
    try {
      await createProjectCustomField({ name: fieldName.trim(), field_type: fieldType });
      setFieldName("");
      setFieldType("text");
      await reload();
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось добавить поле."));
    }
  }

  async function handleAddTaskTemplate(event) {
    event.preventDefault();
    if (!taskTemplateForm.status || !taskTemplateForm.title.trim()) return;
    try {
      await createTaskTemplate({
        status: taskTemplateForm.status,
        title: taskTemplateForm.title.trim(),
        notes: taskTemplateForm.notes.trim(),
        due_in_days: Number(taskTemplateForm.due_in_days) || 0,
        priority: taskTemplateForm.priority,
        auto_create: true,
      });
      setTaskTemplateForm((prev) => ({ ...prev, title: "", notes: "", due_in_days: "1", priority: "medium" }));
      await reload();
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось добавить шаблон задачи."));
    }
  }

  async function handleToggleTaskTemplate(template) {
    try {
      await updateTaskTemplate(template.id, { auto_create: !template.auto_create });
      await reload();
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось обновить шаблон задачи."));
    }
  }

  async function handleTemplateUpload(templateType, file, existingId) {
    setTemplateBusy(true);
    try {
      await uploadDocumentTemplate(templateType, file, existingId);
      await reload();
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось загрузить шаблон."));
    } finally {
      setTemplateBusy(false);
    }
  }

  async function handleSaveChatSettings(event) {
    event.preventDefault();
    setChatSaving(true);

    try {
      const payload = {
        enabled: Boolean(chatForm.enabled),
        base_url: chatForm.base_url.trim(),
        account_id: chatForm.account_id.trim(),
        inbox_name: chatForm.inbox_name.trim(),
      };
      if (chatForm.api_access_token.trim()) {
        payload.api_access_token = chatForm.api_access_token.trim();
      }

      const updated = await updateChatSettings(payload);
      setChatSettings(updated);
      setChatForm({
        enabled: Boolean(updated.enabled),
        base_url: updated.base_url || "",
        account_id: updated.account_id || "",
        inbox_name: updated.inbox_name || "",
        api_access_token: "",
      });
      setError("");
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось сохранить настройки чатов."));
    } finally {
      setChatSaving(false);
    }
  }

  async function removeAndReload(removeAction, id, fallback) {
    try {
      await removeAction(id);
      await reload();
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, fallback));
    }
  }

  function parentDiskPath(path) {
    const normalized = String(path || "disk:/").replace(/^disk:/, "").replace(/^\/+/, "");
    if (!normalized) return "disk:/";
    const parts = normalized.split("/").filter(Boolean);
    parts.pop();
    return parts.length ? `disk:/${parts.join("/")}` : "disk:/";
  }

  async function loadDiskPickerPath(path) {
    setDiskPicker((prev) => ({ ...prev, path, loading: true, error: "" }));
    try {
      const response = await fetchYandexDiskFolders(path);
      setDiskPicker((prev) => ({
        ...prev,
        path: response.path || path,
        folders: response.folders || [],
        loading: false,
        error: "",
      }));
    } catch (requestError) {
      setDiskPicker((prev) => ({
        ...prev,
        loading: false,
        error: extractApiErrorMessage(requestError, "Не удалось загрузить папки Яндекс.Диска."),
      }));
    }
  }

  function openDiskPicker(target, title) {
    const currentPath = yandexDiskForm[target] || "disk:/";
    setDiskPicker({
      open: true,
      target,
      title,
      path: currentPath,
      folders: [],
      loading: true,
      error: "",
    });
    loadDiskPickerPath(currentPath);
  }

  function closeDiskPicker() {
    setDiskPicker((prev) => ({ ...prev, open: false, loading: false, error: "" }));
  }

  function selectCurrentDiskFolder() {
    setYandexDiskForm((prev) => ({ ...prev, [diskPicker.target]: diskPicker.path }));
    closeDiskPicker();
  }

  async function handleConnectYandexDisk() {
    setYandexDiskConnecting(true);
    try {
      const response = await startYandexDiskOAuth();
      if (response.authorization_url) {
        window.location.href = response.authorization_url;
        return;
      }
      setError("Backend не вернул ссылку подключения Яндекс.Диска.");
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось начать подключение Яндекс.Диска."));
    } finally {
      setYandexDiskConnecting(false);
    }
  }

  async function handleCompleteYandexDiskOAuth() {
    if (!yandexDiskCode.trim()) return;

    setYandexDiskCodeSaving(true);
    try {
      const updated = await completeYandexDiskOAuth(yandexDiskCode.trim());
      setYandexDiskSettings(updated);
      setYandexDiskCode("");
      setNotice("Яндекс.Диск подключен. Теперь CRM может создавать и переносить папки проектов.");
      setError("");
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось сохранить код Яндекс.Диска."));
    } finally {
      setYandexDiskCodeSaving(false);
    }
  }

  function renderYandexDiskPathField(target, label, description) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-3">
        <div className="mb-2 flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</div>
            <p className="mt-1 text-xs leading-4 text-slate-500">{description}</p>
          </div>
          <Button type="button" variant="secondary" className="shrink-0 px-3 py-2 text-xs" onClick={() => openDiskPicker(target, label)}>
            <FolderOpen size={15} />
            Выбрать
          </Button>
        </div>
        <Input
          value={yandexDiskForm[target]}
          onChange={(event) => setYandexDiskForm((prev) => ({ ...prev, [target]: event.target.value }))}
          placeholder={target === "archive_path" ? "/CRM/Архив" : "/CRM/Проекты"}
        />
      </div>
    );
  }

  async function handleSaveYandexDiskSettings(event) {
    event.preventDefault();
    setYandexDiskSaving(true);
    try {
      const payload = {
        enabled: Boolean(yandexDiskForm.enabled),
        auto_create_project_folders: Boolean(yandexDiskForm.auto_create_project_folders),
        base_path: yandexDiskForm.base_path.trim() || "/CRM/Проекты",
        archive_path: yandexDiskForm.archive_path.trim() || "/CRM/Архив",
        folder_template: yandexDiskForm.folder_template_text
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean),
      };
      const updated = await updateYandexDiskSettings(payload);
      setYandexDiskSettings(updated);
      setYandexDiskForm((prev) => ({
        ...prev,
        enabled: Boolean(updated.enabled),
        auto_create_project_folders: Boolean(updated.auto_create_project_folders),
        base_path: updated.base_path || "/CRM/Проекты",
        archive_path: updated.archive_path || "/CRM/Архив",
        folder_template_text: updated.folder_template_text || prev.folder_template_text,
      }));
      setError("");
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось сохранить настройки Яндекс.Диска."));
    } finally {
      setYandexDiskSaving(false);
    }
  }

  return (
    <>
    <div className="grid gap-6 xl:grid-cols-3">
      {error ? (
        <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700 xl:col-span-3">{error}</div>
      ) : null}
      {notice ? (
        <div className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700 xl:col-span-3">{notice}</div>
      ) : null}

      <div className="space-y-6">
        <SettingsCard title="Безопасность" icon={<Lock size={16} />}>
          <button className="w-full rounded-full bg-gray-900 px-5 py-3 text-xs font-bold text-white shadow-lg hover:bg-black" type="button">
            Сменить пароль
          </button>
        </SettingsCard>

        <SettingsCard title="Чаты" icon={<MessageCircle size={16} />}>
          <form className="space-y-3" onSubmit={handleSaveChatSettings}>
            <label className="flex items-start gap-3 rounded-2xl bg-blue-50 px-3 py-3 text-sm font-semibold text-blue-700">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 rounded border-blue-200 text-blue-600"
                checked={chatForm.enabled}
                onChange={(event) => setChatForm((prev) => ({ ...prev, enabled: event.target.checked }))}
              />
              <span>Включить модуль Chatwoot для команды</span>
            </label>
            <Input
              value={chatForm.base_url}
              onChange={(event) => setChatForm((prev) => ({ ...prev, base_url: event.target.value }))}
              placeholder="https://chats.cehcrm.ru"
              inputMode="url"
            />
            <Input
              value={chatForm.inbox_name}
              onChange={(event) => setChatForm((prev) => ({ ...prev, inbox_name: event.target.value }))}
              placeholder="Название inbox, например Основные чаты"
            />
            <Input
              value={chatForm.account_id}
              onChange={(event) => setChatForm((prev) => ({ ...prev, account_id: event.target.value }))}
              placeholder="Account ID Chatwoot, если нужен для API"
            />
            <Input
              type="password"
              value={chatForm.api_access_token}
              onChange={(event) => setChatForm((prev) => ({ ...prev, api_access_token: event.target.value }))}
              placeholder={chatSettings?.has_api_access_token ? "API token сохранен, новый вводить не обязательно" : "API access token Chatwoot"}
            />
            <p className="text-xs leading-5 text-gray-500">
              Каждый Chatwoot подключает свои каналы внутри себя: Telegram, WhatsApp, виджет сайта, email. В CRM хранится адрес inbox и служебный token для будущих webhooks/API.
            </p>
            {chatSettings?.app_url ? (
              <a className="block truncate text-xs font-bold text-blue-600 hover:underline" href={chatSettings.app_url} target="_blank" rel="noreferrer">
                Открыть подключенный inbox
              </a>
            ) : null}
            <button
              className="w-full rounded-full bg-gray-900 px-5 py-3 text-xs font-bold text-white shadow-lg hover:bg-black disabled:opacity-60"
              type="submit"
              disabled={chatSaving}
            >
              {chatSaving ? "Сохраняем..." : "Сохранить чаты"}
            </button>
          </form>
        </SettingsCard>

        <SettingsCard title="Яндекс.Диск" icon={<HardDrive size={16} />}>
          <form className="space-y-3" onSubmit={handleSaveYandexDiskSettings}>
            <label className="flex items-start gap-3 rounded-2xl bg-blue-50 px-3 py-3 text-sm font-semibold text-blue-700">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 rounded border-blue-200 text-blue-600"
                checked={yandexDiskForm.enabled}
                onChange={(event) => setYandexDiskForm((prev) => ({ ...prev, enabled: event.target.checked }))}
              />
              <span>Включить создание папок проектов на Яндекс.Диске</span>
            </label>
            <label className="flex items-start gap-3 rounded-2xl bg-slate-50 px-3 py-3 text-sm font-semibold text-slate-600">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-600"
                checked={yandexDiskForm.auto_create_project_folders}
                onChange={(event) => setYandexDiskForm((prev) => ({ ...prev, auto_create_project_folders: event.target.checked }))}
              />
              <span>Автоматически создавать папку при создании проекта</span>
            </label>
            <div className={`rounded-2xl px-4 py-3 text-sm font-bold ${yandexDiskSettings?.has_oauth_token ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
              {yandexDiskSettings?.has_oauth_token ? "CRM подключена к Яндекс.Диску и может создавать папки." : "CRM ещё не подключена к Яндекс.Диску. Нажмите кнопку ниже и подтвердите доступ."}
            </div>
            <button
              type="button"
              className="flex w-full items-center justify-center gap-2 rounded-full border border-blue-100 bg-blue-50 px-5 py-3 text-sm font-bold text-blue-700 transition hover:border-blue-200 hover:bg-blue-100 disabled:opacity-60"
              onClick={handleConnectYandexDisk}
              disabled={yandexDiskConnecting}
            >
              <ExternalLink size={17} />
              {yandexDiskConnecting ? "Открываем Яндекс..." : yandexDiskSettings?.has_oauth_token ? "Переподключить CRM к Яндекс.Диску" : "Подключить CRM к Яндекс.Диску"}
            </button>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <div className="mb-2 text-[10px] font-black uppercase tracking-widest text-slate-400">Код подтверждения Яндекса</div>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <Input
                  value={yandexDiskCode}
                  onChange={(event) => setYandexDiskCode(event.target.value)}
                  placeholder="Вставьте код, который показал Яндекс"
                />
                <Button
                  type="button"
                  className="px-4"
                  onClick={handleCompleteYandexDiskOAuth}
                  disabled={yandexDiskCodeSaving || !yandexDiskCode.trim()}
                >
                  {yandexDiskCodeSaving ? "Проверяем..." : "Сохранить доступ"}
                </Button>
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-500">
                Если Яндекс не возвращает обратно в CRM, он покажет код на странице verification_code. Скопируйте его сюда.
              </p>
            </div>
            {renderYandexDiskPathField("base_path", "Папка проектов", "Сюда будут автоматически попадать новые папки проектов.")}
            {renderYandexDiskPathField("archive_path", "Папка архива", "Сюда CRM перенесёт папку проекта после перехода в завершённый статус.")}
            <textarea
              className="min-h-40 w-full rounded-2xl border border-gray-200 px-3 py-3 text-sm outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10"
              value={yandexDiskForm.folder_template_text}
              onChange={(event) => setYandexDiskForm((prev) => ({ ...prev, folder_template_text: event.target.value }))}
              placeholder={"Визуализация\nЗакупочная смета\nМодель\nРаскрой\nСмета\nСогласование\nТЗ\nЧертежи"}
            />
            <p className="text-xs leading-5 text-gray-500">
              Папка проекта будет называться как в CRM: номер проекта и его наименование. Внутри будут созданы подпапки из списка выше.
            </p>
            <button
              className="w-full rounded-full bg-gray-900 px-5 py-3 text-xs font-bold text-white shadow-lg hover:bg-black disabled:opacity-60"
              type="submit"
              disabled={yandexDiskSaving}
            >
              {yandexDiskSaving ? "Сохраняем..." : "Сохранить Яндекс.Диск"}
            </button>
          </form>
        </SettingsCard>

        <SettingsCard title="Команда" icon={<Users2 size={16} />}>
          <div className="mb-4 space-y-3">
            {managers.map((manager) => (
              <div key={manager.id} className="flex items-center justify-between rounded-lg bg-gray-50 p-3">
                <div>
                  <p className="font-semibold">{manager.full_name || manager.username}</p>
                  <p className="text-xs text-gray-500">{manager.email || "email не указан"}</p>
                </div>
              </div>
            ))}
          </div>

          <form className="space-y-3 border-t pt-4" onSubmit={handleAddManager}>
            <h4 className="text-sm font-bold">Добавить менеджера</h4>
            <Input
              value={managerForm.username}
              onChange={(event) => setManagerForm((prev) => ({ ...prev, username: event.target.value }))}
              placeholder="Имя"
              required
            />
            <Input
              type="email"
              value={managerForm.email}
              onChange={(event) => setManagerForm((prev) => ({ ...prev, email: event.target.value }))}
              placeholder="Email"
            />
            <Input
              type="tel"
              inputMode="numeric"
              autoComplete="tel"
              value={managerForm.phone}
              onChange={(event) => setManagerForm((prev) => ({ ...prev, phone: formatRussianPhoneInput(event.target.value) }))}
              onFocus={() => {
                if (!managerForm.phone) setManagerForm((prev) => ({ ...prev, phone: "+7-" }));
              }}
              placeholder="Телефон"
            />
            <Input
              type="password"
              value={managerForm.password}
              onChange={(event) => setManagerForm((prev) => ({ ...prev, password: event.target.value }))}
              placeholder="Пароль"
              required
            />
            <button className="w-full rounded-full bg-gray-900 px-5 py-3 text-xs font-bold text-white shadow-lg hover:bg-black" type="submit">
              Добавить
            </button>
          </form>
        </SettingsCard>

        <SettingsCard title="Шаблоны задач" icon={<ListTodo size={16} />}>
          <div className="mb-4 space-y-2">
            {taskTemplates.map((template) => (
              <div key={template.id} className="rounded-2xl bg-gray-50 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-black text-gray-900">{template.title}</div>
                    <div className="mt-1 text-xs font-semibold text-gray-500">
                      {template.status_name || "Этап"} · срок +{template.due_in_days || 0} дн. · {template.priority}
                    </div>
                    {template.notes ? <div className="mt-2 line-clamp-2 text-xs text-gray-500">{template.notes}</div> : null}
                  </div>
                  <DeleteButton onClick={() => removeAndReload(deleteTaskTemplate, template.id, "Не удалось удалить шаблон задачи.")} />
                </div>
                <button
                  type="button"
                  className={`mt-3 rounded-full px-3 py-1 text-xs font-black ${
                    template.auto_create ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-500"
                  }`}
                  onClick={() => handleToggleTaskTemplate(template)}
                >
                  {template.auto_create ? "Автосоздание включено" : "Автосоздание выключено"}
                </button>
              </div>
            ))}
            {taskTemplates.length === 0 ? (
              <div className="rounded-2xl bg-gray-50 px-4 py-6 text-sm text-gray-400">Шаблонов пока нет.</div>
            ) : null}
          </div>

          <form className="space-y-3 border-t pt-4" onSubmit={handleAddTaskTemplate}>
            <Select
              value={taskTemplateForm.status}
              onChange={(event) => setTaskTemplateForm((prev) => ({ ...prev, status: event.target.value }))}
            >
              {statuses.map((status) => (
                <option key={status.id} value={status.id}>
                  {status.name}
                </option>
              ))}
            </Select>
            <Input
              value={taskTemplateForm.title}
              onChange={(event) => setTaskTemplateForm((prev) => ({ ...prev, title: event.target.value }))}
              placeholder="Название задачи"
            />
            <Input
              value={taskTemplateForm.notes}
              onChange={(event) => setTaskTemplateForm((prev) => ({ ...prev, notes: event.target.value }))}
              placeholder="Комментарий к задаче"
            />
            <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-2">
              <Select
                value={taskTemplateForm.priority}
                onChange={(event) => setTaskTemplateForm((prev) => ({ ...prev, priority: event.target.value }))}
              >
                <option value="low">Низкий</option>
                <option value="medium">Средний</option>
                <option value="high">Высокий</option>
              </Select>
              <Input
                inputMode="numeric"
                value={taskTemplateForm.due_in_days}
                onChange={(event) => setTaskTemplateForm((prev) => ({ ...prev, due_in_days: event.target.value }))}
                placeholder="+ дней"
              />
            </div>
            <button className="w-full rounded-full bg-gray-900 px-5 py-3 text-xs font-bold text-white shadow-lg hover:bg-black" type="submit">
              Добавить шаблон
            </button>
          </form>
        </SettingsCard>
      </div>

      <div className="space-y-6">
        <SettingsCard title="Этапы проектов" icon={<Layers size={16} />}>
          <div className={`mb-4 space-y-2 transition ${reorderSaving === "statuses" ? "opacity-70" : ""}`}>
            {statuses.map((status) => (
              <div
                key={status.id}
                className={`grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg bg-gray-50 p-2 transition ${
                  draggedRow?.kind === "status" && draggedRow.id !== status.id ? "ring-2 ring-blue-100" : ""
                }`}
                onDragOver={(event) => {
                  if (draggedRow?.kind === "status" && draggedRow.id !== status.id) {
                    event.preventDefault();
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  handleStatusDrop(status.id);
                }}
              >
                <button
                  type="button"
                  draggable
                  className="shrink-0 cursor-grab rounded-md p-1 text-gray-300 transition hover:bg-white hover:text-blue-500 active:cursor-grabbing"
                  onDragStart={(event) => handleDragStart(event, { kind: "status", id: status.id })}
                  onDragEnd={() => setDraggedRow(null)}
                  aria-label="Переместить этап"
                >
                  <GripVertical size={16} />
                </button>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{status.name}</span>
                {status.id !== terminalStatusId ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <Input
                      className="h-9 !w-[4ch] !min-w-[4ch] !px-1 !py-1 text-center tabular-nums"
                      inputMode="numeric"
                      value={status.stuck_after_days ?? 3}
                      onChange={(event) =>
                        setStatuses((prev) =>
                          prev.map((item) => (item.id === status.id ? { ...item, stuck_after_days: event.target.value } : item))
                        )
                      }
                      onBlur={() => handleStageDaysBlur(status)}
                    />
                    <span className="shrink-0 text-xs text-gray-400">дн.</span>
                  </div>
                ) : null}
                <DeleteButton className="justify-self-end" onClick={() => removeAndReload(deleteProjectStatus, status.id, "Не удалось удалить этап.")} />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 border-t pt-4">
            <Input value={stageName} onChange={(event) => setStageName(event.target.value)} placeholder="Новый этап" />
            <Input className="h-10 !w-[4ch] !min-w-[4ch] shrink-0 !px-1 text-center tabular-nums" inputMode="numeric" value={stageDays} onChange={(event) => setStageDays(event.target.value)} />
            <IconButton className="shrink-0" onClick={handleAddStage}>
              <Plus size={16} />
            </IconButton>
          </div>
        </SettingsCard>

        <SettingsCard title="Поля проектов" icon={<Sliders size={16} />}>
          <div className="mb-4 space-y-2">
            {customFields.map((field) => (
              <div key={field.id} className="flex items-center justify-between rounded-lg bg-gray-50 p-2">
                <div className="flex items-center gap-2">
                  <Hash size={14} className="text-gray-400" />
                  <span className="text-sm font-semibold">{field.name}</span>
                  <span className="text-xs text-gray-400">({FIELD_TYPE_LABELS[field.field_type] || field.field_type})</span>
                </div>
                <DeleteButton onClick={() => removeAndReload(deleteProjectCustomField, field.id, "Не удалось удалить поле.")} />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 border-t pt-4">
            <Input value={fieldName} onChange={(event) => setFieldName(event.target.value)} placeholder="Название поля" />
            <Select className="w-36" value={fieldType} onChange={(event) => setFieldType(event.target.value)}>
              <option value="text">Текст</option>
              <option value="number">Число</option>
              <option value="date">Дата</option>
              <option value="file">Файл</option>
            </Select>
            <IconButton onClick={handleAddField}>
              <Plus size={16} />
            </IconButton>
          </div>
        </SettingsCard>
      </div>

      <div className="space-y-6">
        <SettingsCard title="Категории финансов" icon={<Tag size={16} />}>
          <div className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-1">
            {[
              { key: "income", title: "Доходы", tone: "text-green-600", empty: "Доходных категорий пока нет." },
              { key: "expense", title: "Расходы", tone: "text-red-600", empty: "Расходных категорий пока нет." },
            ].map((group) => (
              <div key={group.key} className={`rounded-2xl bg-gray-50 p-2 transition ${reorderSaving === `categories-${group.key}` ? "opacity-70" : ""}`}>
                <div className={`mb-2 px-2 text-[10px] font-black uppercase tracking-widest ${group.tone}`}>{group.title}</div>
                <div className="space-y-2">
                  {financeCategoriesByType[group.key].length ? (
                    financeCategoriesByType[group.key].map((category) => (
                      <div
                        key={category.id}
                        className={`flex items-center justify-between gap-2 rounded-lg bg-white p-2 transition ${
                          draggedRow?.kind === "category" && draggedRow.type === group.key && draggedRow.id !== category.id ? "ring-2 ring-blue-100" : ""
                        }`}
                        onDragOver={(event) => {
                          if (draggedRow?.kind === "category" && draggedRow.type === group.key && draggedRow.id !== category.id) {
                            event.preventDefault();
                          }
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          handleCategoryDrop(category.id, group.key);
                        }}
                      >
                        <button
                          type="button"
                          draggable
                          className="shrink-0 cursor-grab rounded-md p-1 text-gray-300 transition hover:bg-gray-50 hover:text-blue-500 active:cursor-grabbing"
                          onDragStart={(event) => handleDragStart(event, { kind: "category", type: group.key, id: category.id })}
                          onDragEnd={() => setDraggedRow(null)}
                          aria-label="Переместить категорию"
                        >
                          <GripVertical size={14} />
                        </button>
                        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-800">{category.name}</span>
                        <DeleteButton onClick={() => removeAndReload(deleteFinanceCategory, category.id, "Не удалось удалить категорию.")} />
                      </div>
                    ))
                  ) : (
                    <div className="rounded-lg bg-white px-3 py-3 text-xs text-gray-400">{group.empty}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="grid gap-2 border-t pt-4 sm:grid-cols-[minmax(0,1fr)_144px_auto] sm:items-center">
            <Input value={categoryName} onChange={(event) => setCategoryName(event.target.value)} placeholder="Новая категория" />
            <Select className="w-full sm:w-36" value={categoryType} onChange={(event) => setCategoryType(event.target.value)}>
              <option value="income">Доход</option>
              <option value="expense">Расход</option>
            </Select>
            <IconButton className="justify-self-end" onClick={handleAddCategory}>
              <Plus size={16} />
            </IconButton>
          </div>
        </SettingsCard>

        <SettingsCard title="Счета" icon={<CreditCard size={16} />}>
          <div className="mb-4 space-y-2">
            {accounts.map((account) => (
              <div key={account.id} className="flex items-center justify-between rounded-lg bg-gray-50 p-2">
                <span className="text-sm font-semibold">{account.name}</span>
                <DeleteButton onClick={() => removeAndReload(deleteAccount, account.id, "Не удалось удалить счет.")} />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 border-t pt-4">
            <Input value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder="Новый счет" />
            <IconButton onClick={handleAddAccount}>
              <Plus size={16} />
            </IconButton>
          </div>
        </SettingsCard>

        <SettingsCard title="Шаблоны документов" icon={<SettingsIcon size={16} />}>
          <p className="mb-4 text-sm text-gray-500">
            Загрузите заполняемые PDF-шаблоны для договоров и актов. CRM подставит данные в именованные поля PDF.
          </p>
          <div className="mb-4 rounded-2xl bg-slate-50 px-4 py-3 text-xs font-semibold leading-6 text-slate-600">
            <div><code>CLIENT_FULL_NAME</code> — ФИО, <code>CLIENT_PHONE</code> — телефон, <code>CLIENT_ADDRESS</code> — адрес.</div>
            <div><code>PROJECT_NUMBER</code> — номер проекта, <code>PROJECT_TITLE</code> — название, <code>DEAL_VALUE</code> — сумма.</div>
            <div><code>QUOTE_NUMBER</code> — номер КП, <code>QUOTE_ITEMS</code> — позиции КП, <code>DOCUMENT_DATE</code> — дата.</div>
          </div>
          <div className="space-y-4">
            <TemplateUploader
              label="Шаблон договора"
              templateType="contract"
              templates={templates}
              onUpload={handleTemplateUpload}
              onDelete={(id) => removeAndReload(deleteDocumentTemplate, id, "Не удалось удалить шаблон.")}
              busy={templateBusy}
            />
            <TemplateUploader
              label="Шаблон акта"
              templateType="act"
              templates={templates}
              onUpload={handleTemplateUpload}
              onDelete={(id) => removeAndReload(deleteDocumentTemplate, id, "Не удалось удалить шаблон.")}
              busy={templateBusy}
            />
          </div>
        </SettingsCard>
      </div>
    </div>
    <Modal
      open={diskPicker.open}
      title={diskPicker.title || "Выбор папки"}
      onClose={closeDiskPicker}
      widthClassName="max-w-2xl"
      bodyClassName="space-y-4"
    >
      <div className="rounded-2xl bg-slate-50 p-3">
        <div className="text-[10px] font-black uppercase tracking-widest text-slate-400">Текущая папка</div>
        <div className="mt-1 break-all text-sm font-bold text-slate-900">{diskPicker.path}</div>
      </div>

      {diskPicker.error ? <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{diskPicker.error}</div> : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={() => loadDiskPickerPath(parentDiskPath(diskPicker.path))} disabled={diskPicker.loading || diskPicker.path === "disk:/"}>
          <ChevronLeft size={16} />
          Выше
        </Button>
        <Button type="button" onClick={selectCurrentDiskFolder} disabled={diskPicker.loading}>
          <FolderOpen size={16} />
          Выбрать текущую папку
        </Button>
      </div>

      <div className="max-h-[48vh] overflow-y-auto rounded-2xl border border-slate-200 bg-white">
        {diskPicker.loading ? (
          <div className="px-4 py-6 text-center text-sm font-semibold text-slate-400">Загружаем папки...</div>
        ) : diskPicker.folders.length ? (
          diskPicker.folders.map((folder) => (
            <button
              key={folder.path}
              type="button"
              className="flex w-full items-center gap-3 border-b border-slate-100 px-4 py-3 text-left transition last:border-b-0 hover:bg-blue-50"
              onClick={() => loadDiskPickerPath(folder.path)}
            >
              <Folder size={18} className="shrink-0 text-blue-600" />
              <span className="min-w-0 flex-1 truncate text-sm font-bold text-slate-800">{folder.name}</span>
            </button>
          ))
        ) : (
          <div className="px-4 py-6 text-center text-sm font-semibold text-slate-400">В этой папке нет вложенных папок.</div>
        )}
      </div>
    </Modal>
    </>
  );
}
