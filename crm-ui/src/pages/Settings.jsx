import React, { useEffect, useMemo, useState } from "react";
import {
  CreditCard,
  FileText,
  GripVertical,
  Hash,
  Layers,
  Lock,
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
  createUser,
  deleteAccount,
  deleteDocumentTemplate,
  deleteFinanceCategory,
  deleteProjectCustomField,
  deleteProjectStatus,
  extractApiErrorMessage,
  fetchAccounts,
  fetchDocumentTemplates,
  fetchFinanceCategories,
  fetchProjectCustomFields,
  fetchProjectStatuses,
  fetchUsers,
  updateProjectStatus,
  uploadDocumentTemplate,
} from "../api";
import { Input, Select } from "../components/ui.jsx";

const STATUS_COLOR = "sky";

const FIELD_TYPE_LABELS = {
  text: "Текст",
  number: "Число",
  date: "Дата",
  file: "Файл",
};

function SettingsCard({ title, icon, children, className = "" }) {
  return (
    <div className={`overflow-hidden rounded-3xl border border-white/50 bg-white shadow-sm ${className}`}>
      <div className="flex items-center gap-2 border-b border-gray-100 bg-gray-50/30 px-6 py-4 font-semibold text-gray-900">
        <div className="text-indigo-600">{icon}</div>
        <h3 className="truncate text-xs font-black uppercase tracking-widest">{title}</h3>
      </div>
      <div className="p-4 sm:p-6">{children}</div>
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

function DeleteButton(props) {
  return (
    <button type="button" className="rounded-md p-1 text-gray-300 transition hover:bg-red-50 hover:text-red-500" {...props}>
      <Trash2 size={14} />
    </button>
  );
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
  const [templates, setTemplates] = useState([]);
  const [error, setError] = useState("");

  const [managerForm, setManagerForm] = useState({ username: "", email: "", phone: "", password: "" });
  const [stageName, setStageName] = useState("");
  const [stageDays, setStageDays] = useState("3");
  const [categoryName, setCategoryName] = useState("");
  const [categoryType, setCategoryType] = useState("expense");
  const [accountName, setAccountName] = useState("");
  const [fieldName, setFieldName] = useState("");
  const [fieldType, setFieldType] = useState("text");
  const [templateBusy, setTemplateBusy] = useState(false);

  async function reload() {
    const [userRows, statusRows, categoryRows, accountRows, fieldRows, templateRows] = await Promise.all([
      fetchUsers(),
      fetchProjectStatuses(),
      fetchFinanceCategories(),
      fetchAccounts(),
      fetchProjectCustomFields(),
      fetchDocumentTemplates(),
    ]);

    setUsers(userRows);
    setStatuses(statusRows);
    setCategories(categoryRows);
    setAccounts(accountRows);
    setCustomFields(fieldRows);
    setTemplates(templateRows);
  }

  useEffect(() => {
    reload().catch((requestError) => {
      setError(extractApiErrorMessage(requestError, "Не удалось загрузить системные настройки."));
    });
  }, []);

  const managers = useMemo(() => users.filter((user) => user.role === "manager" || !user.is_admin), [users]);

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

  async function handleAddCategory() {
    if (!categoryName.trim()) return;
    try {
      await createFinanceCategory({ name: categoryName.trim(), type: categoryType });
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

  async function removeAndReload(removeAction, id, fallback) {
    try {
      await removeAction(id);
      await reload();
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, fallback));
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-3">
      {error ? (
        <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700 xl:col-span-3">{error}</div>
      ) : null}

      <div className="space-y-6">
        <SettingsCard title="Безопасность" icon={<Lock size={16} />}>
          <button className="w-full rounded-full bg-gray-900 px-5 py-3 text-xs font-bold text-white shadow-lg hover:bg-black" type="button">
            Сменить пароль
          </button>
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
              pattern="[0-9+()\\-\\s]*"
              value={managerForm.phone}
              onChange={(event) => setManagerForm((prev) => ({ ...prev, phone: event.target.value }))}
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
      </div>

      <div className="space-y-6">
        <SettingsCard title="Этапы проектов" icon={<Layers size={16} />}>
          <div className="mb-4 space-y-2">
            {statuses.map((status) => (
              <div key={status.id} className="flex items-center gap-3 rounded-lg bg-gray-50 p-2">
                <GripVertical size={16} className="text-gray-300" />
                <span className="min-w-0 flex-1 text-sm font-semibold">{status.name}</span>
                <Input
                  className="h-10 w-28 py-2 text-center"
                  value={status.stuck_after_days ?? 3}
                  onChange={(event) =>
                    setStatuses((prev) =>
                      prev.map((item) => (item.id === status.id ? { ...item, stuck_after_days: event.target.value } : item))
                    )
                  }
                  onBlur={() => handleStageDaysBlur(status)}
                />
                <span className="text-xs text-gray-400">дней</span>
                <DeleteButton onClick={() => removeAndReload(deleteProjectStatus, status.id, "Не удалось удалить этап.")} />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 border-t pt-4">
            <Input value={stageName} onChange={(event) => setStageName(event.target.value)} placeholder="Новый этап" />
            <Input className="w-28" value={stageDays} onChange={(event) => setStageDays(event.target.value)} />
            <IconButton onClick={handleAddStage}>
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
          <div className="mb-4 space-y-2">
            {categories.map((category) => (
              <div key={category.id} className="flex items-center justify-between rounded-lg bg-gray-50 p-2">
                <span className={`text-sm font-semibold ${category.type === "income" ? "text-green-600" : "text-red-600"}`}>
                  {category.name}
                </span>
                <DeleteButton onClick={() => removeAndReload(deleteFinanceCategory, category.id, "Не удалось удалить категорию.")} />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 border-t pt-4">
            <Input value={categoryName} onChange={(event) => setCategoryName(event.target.value)} placeholder="Новая категория" />
            <Select className="w-36" value={categoryType} onChange={(event) => setCategoryType(event.target.value)}>
              <option value="expense">Расход</option>
              <option value="income">Доход</option>
            </Select>
            <IconButton onClick={handleAddCategory}>
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
            Загрузите PDF-шаблоны для договоров и актов. Для автозаполнения используйте поля PDF:
            <code className="ml-1">CLIENT_NAME</code>, <code>CLIENT_ADDRESS</code>, <code>DEAL_VALUE</code>.
          </p>
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
  );
}
