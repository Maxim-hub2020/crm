import React, { useEffect, useMemo, useState } from "react";
import { ArrowUpCircle, Search, Trash2 } from "lucide-react";

import {
  deletePayment,
  extractApiErrorMessage,
  fetchAccounts,
  fetchFinanceCategories,
  fetchPayments,
  fetchProjects,
  updatePayment,
} from "../api";
import { Badge, Button, Input, Label, Modal, Select } from "../components/ui.jsx";

const METHOD_LABELS = {
  transfer: "Перевод",
  cash: "Наличные",
  card: "Карта",
  other: "Другое",
};

const moneyFormatter = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function defaultPaymentType(categoryKind) {
  return categoryKind === "expense" ? "correction" : "advance";
}

function formatMoney(value) {
  return moneyFormatter.format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toLocaleDateString("ru-RU");
}

function toDateTimeLocalValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return offsetDate.toISOString().slice(0, 16);
}

function createPaymentEditForm(payment = {}) {
  const categoryKind = payment.id ? payment.category_type || (payment.type === "refund" || payment.type === "correction" ? "expense" : "income") : "";

  return {
    category_kind: categoryKind,
    category: payment.category ? String(payment.category) : "",
    account: payment.account ? String(payment.account) : "",
    type: categoryKind ? payment.type || defaultPaymentType(categoryKind) : "",
    amount: payment.amount ? String(payment.amount) : "",
    method: payment.method || "transfer",
    comment: payment.comment || "",
    paid_at: toDateTimeLocalValue(payment.paid_at),
  };
}

function paymentSignedAmount(payment) {
  const amount = Number(payment?.amount || 0);
  if (payment?.category_type === "expense") return -amount;
  if (payment?.category_type === "income") return amount;
  return payment?.type === "refund" || payment?.type === "correction" ? -amount : amount;
}

function projectDisplayName(project) {
  return project?.title || project?.client_name || `Проект #${project?.id || ""}`;
}

function paymentCategoryLabel(payment) {
  return payment?.category_name || "Без категории";
}

function paymentCategoryBadgeClass(payment) {
  if (payment?.category_type === "expense") return "bg-red-50 text-red-600";
  if (payment?.category_type === "income") return "bg-emerald-50 text-emerald-600";
  return "";
}

export default function Finances() {
  const [projects, setProjects] = useState([]);
  const [payments, setPayments] = useState([]);
  const [categories, setCategories] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [search, setSearch] = useState("");
  const [method, setMethod] = useState("all");
  const [category, setCategory] = useState("all");
  const [account, setAccount] = useState("all");
  const [editingPayment, setEditingPayment] = useState(null);
  const [editForm, setEditForm] = useState(createPaymentEditForm());
  const [editSaving, setEditSaving] = useState(false);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const [projectRows, paymentRows, categoryRows, accountRows] = await Promise.all([
          fetchProjects(),
          fetchPayments(),
          fetchFinanceCategories(),
          fetchAccounts(),
        ]);
        setProjects(projectRows);
        setPayments(paymentRows);
        setCategories(categoryRows);
        setAccounts(accountRows);
      } catch {
        setProjects([]);
        setPayments([]);
        setCategories([]);
        setAccounts([]);
      }
    })();
  }, []);

  const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  const editCategoryOptions = useMemo(
    () => categories.filter((item) => item.type === editForm.category_kind),
    [categories, editForm.category_kind]
  );
  const filteredPayments = useMemo(() => {
    const value = search.trim().toLowerCase();

    return payments.filter((payment) => {
      const project = projectMap.get(payment.project);
      const matchesSearch =
        !value ||
        [project?.title, project?.client_name, project?.client_phone, payment.comment, payment.type, payment.category_name, payment.account_name]
          .filter(Boolean)
          .some((field) => field.toLowerCase().includes(value));

      const matchesMethod = method === "all" || payment.method === method;
      const matchesCategory = category === "all" || String(payment.category || "") === category;
      const matchesAccount = account === "all" || String(payment.account || "") === account;
      return matchesSearch && matchesMethod && matchesCategory && matchesAccount;
    });
  }, [account, category, method, payments, projectMap, search]);

  function openPaymentEdit(payment) {
    setActionError("");
    setEditingPayment(payment);
    setEditForm(createPaymentEditForm(payment));
  }

  async function submitPaymentEdit(event) {
    event.preventDefault();
    if (!editingPayment) return;

    setActionError("");
    setEditSaving(true);
    try {
      if (!editForm.category_kind) {
        setActionError("Выберите тип операции: доход или расход.");
        return;
      }
      const updated = await updatePayment(editingPayment.id, {
        category: editForm.category || null,
        account: editForm.account || null,
        type: editForm.type || defaultPaymentType(editForm.category_kind),
        amount: editForm.amount,
        method: editForm.method,
        comment: editForm.comment,
        paid_at: editForm.paid_at || undefined,
      });
      setPayments((current) => current.map((payment) => (payment.id === updated.id ? updated : payment)));
      setEditingPayment(null);
      setEditForm(createPaymentEditForm());
    } catch (requestError) {
      setActionError(extractApiErrorMessage(requestError, "Не удалось сохранить операцию."));
    } finally {
      setEditSaving(false);
    }
  }

  async function removePayment(paymentId) {
    if (!window.confirm("Удалить финансовую операцию?")) return;

    setActionError("");
    try {
      await deletePayment(paymentId);
      setPayments((current) => current.filter((payment) => payment.id !== paymentId));
    } catch (requestError) {
      setActionError(extractApiErrorMessage(requestError, "Не удалось удалить операцию."));
    }
  }

  return (
    <div>
      {actionError && <div className="mb-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{actionError}</div>}

      <div className="mb-4 flex flex-col gap-4 sm:flex-row">
        <div className="relative flex-grow">
          <Input
            className="pl-10"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Поиск..."
          />
          <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400" />
        </div>
        <Select value={method} onChange={(event) => setMethod(event.target.value)} className="sm:w-64">
          <option value="all">Все способы оплаты</option>
          {Object.entries(METHOD_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <Select value={category} onChange={(event) => setCategory(event.target.value)} className="sm:w-64">
          <option value="all">Все категории</option>
          {categories.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {item.type === "expense" ? "расход" : "доход"}
            </option>
          ))}
        </Select>
        <Select value={account} onChange={(event) => setAccount(event.target.value)} className="sm:w-64">
          <option value="all">Все счета</option>
          {accounts.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
      </div>

      <div className="hidden overflow-x-auto rounded-[32px] bg-white shadow-lg md:block">
        <table className="min-w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-black uppercase tracking-widest text-gray-500">Дата</th>
              <th className="px-6 py-3 text-left text-xs font-black uppercase tracking-widest text-gray-500">Клиент</th>
              <th className="px-6 py-3 text-left text-xs font-black uppercase tracking-widest text-gray-500">Тип</th>
              <th className="px-6 py-3 text-left text-xs font-black uppercase tracking-widest text-gray-500">Сумма</th>
              <th className="px-6 py-3 text-left text-xs font-black uppercase tracking-widest text-gray-500">Способ</th>
              <th className="px-6 py-3 text-left text-xs font-black uppercase tracking-widest text-gray-500">Комментарий</th>
              <th className="px-6 py-3 text-right text-xs font-black uppercase tracking-widest text-gray-500">Действия</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filteredPayments.map((payment) => {
              const signedAmount = paymentSignedAmount(payment);
              return (
                <tr key={payment.id} className="transition hover:bg-gray-50/50">
                  <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-500">{formatDate(payment.paid_at)}</td>
                  <td className="whitespace-nowrap px-6 py-4 text-sm font-semibold text-gray-800">
                    {projectDisplayName(projectMap.get(payment.project))}
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 text-sm">
                    <Badge className={paymentCategoryBadgeClass(payment)}>{paymentCategoryLabel(payment)}</Badge>
                  </td>
                  <td className={`whitespace-nowrap px-6 py-4 text-sm font-bold ${signedAmount < 0 ? "text-red-600" : "text-green-600"}`}>
                    <span className="inline-flex items-center gap-2">
                      <ArrowUpCircle size={16} />
                      {signedAmount < 0 ? "−" : "+"} {formatMoney(Math.abs(signedAmount))} ₽
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-500">
                    {METHOD_LABELS[payment.method] || payment.method}
                    {payment.account_name ? ` · ${payment.account_name}` : ""}
                  </td>
                  <td className="max-w-xs truncate px-6 py-4 text-sm text-gray-500">{payment.comment || "—"}</td>
                  <td className="whitespace-nowrap px-6 py-4 text-right text-sm">
                    <div className="flex justify-end gap-2">
                      <Button type="button" variant="ghost" className="px-3 text-blue-600 hover:bg-blue-50" onClick={() => openPaymentEdit(payment)}>
                        Редактировать
                      </Button>
                      <Button type="button" variant="ghost" className="px-3 text-red-600 hover:bg-red-50" onClick={() => removePayment(payment.id)}>
                        <Trash2 size={16} />
                        Удалить
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filteredPayments.length === 0 && (
              <tr>
                <td className="py-10 text-center text-gray-400" colSpan={7}>
                  Платежи не найдены
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="space-y-4 md:hidden">
        {filteredPayments.map((payment) => {
          const signedAmount = paymentSignedAmount(payment);
          return (
            <div key={payment.id} className="space-y-2 rounded-2xl bg-white p-4 shadow-lg">
              <div className="flex items-start justify-between">
                <div className={`text-xl font-bold ${signedAmount < 0 ? "text-red-600" : "text-green-600"}`}>
                  {signedAmount < 0 ? "−" : "+"} {formatMoney(Math.abs(signedAmount))} ₽
                </div>
                <div className="text-xs text-gray-500">{formatDate(payment.paid_at)}</div>
              </div>
              <div className="border-t pt-2 text-sm text-gray-600">
                <p className="font-semibold text-gray-800">{projectDisplayName(projectMap.get(payment.project))}</p>
                <p>
                  {paymentCategoryLabel(payment)} · {METHOD_LABELS[payment.method] || payment.method}
                  {payment.account_name ? ` · ${payment.account_name}` : ""}
                </p>
                <p className="truncate">{payment.comment || "Без комментария"}</p>
                <div className="flex gap-2 pt-2">
                  <Button type="button" variant="secondary" className="flex-1 justify-center" onClick={() => openPaymentEdit(payment)}>
                    Редактировать
                  </Button>
                  <Button type="button" variant="danger" className="flex-1 justify-center" onClick={() => removePayment(payment.id)}>
                    Удалить
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
        {filteredPayments.length === 0 && (
          <div className="rounded-2xl bg-white p-8 text-center text-sm text-gray-400 shadow-lg">Платежи не найдены</div>
        )}
      </div>

      <Modal
        open={Boolean(editingPayment)}
        title="Редактировать операцию"
        onClose={() => {
          if (!editSaving) {
            setEditingPayment(null);
            setEditForm(createPaymentEditForm());
          }
        }}
        widthClassName="max-w-2xl"
      >
        <form className="space-y-4" onSubmit={submitPaymentEdit}>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Тип операции</Label>
              <Select
                value={editForm.category_kind}
                onChange={(event) =>
                  setEditForm((prev) => ({
                    ...prev,
                    category_kind: event.target.value,
                    category: "",
                    type: event.target.value ? defaultPaymentType(event.target.value) : "",
                  }))
                }
              >
                <option value="">Выберите тип</option>
                <option value="income">Доход</option>
                <option value="expense">Расход</option>
              </Select>
            </div>
            {editForm.category_kind ? (
              <div className="space-y-2">
                <Label>{editForm.category_kind === "expense" ? "Категория расхода" : "Категория дохода"}</Label>
                <Select value={editForm.category} onChange={(event) => setEditForm((prev) => ({ ...prev, category: event.target.value }))}>
                  <option value="">Без категории</option>
                  {editCategoryOptions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
            <div className="space-y-2">
              <Label>Счет</Label>
              <Select value={editForm.account} onChange={(event) => setEditForm((prev) => ({ ...prev, account: event.target.value }))}>
                <option value="">Без счета</option>
                {accounts.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Сумма</Label>
              <Input value={editForm.amount} onChange={(event) => setEditForm((prev) => ({ ...prev, amount: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>Способ оплаты</Label>
              <Select value={editForm.method} onChange={(event) => setEditForm((prev) => ({ ...prev, method: event.target.value }))}>
                {Object.entries(METHOD_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Дата</Label>
              <Input
                type="datetime-local"
                value={editForm.paid_at}
                onChange={(event) => setEditForm((prev) => ({ ...prev, paid_at: event.target.value }))}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Комментарий</Label>
            <Input value={editForm.comment} onChange={(event) => setEditForm((prev) => ({ ...prev, comment: event.target.value }))} />
          </div>
          <div className="flex justify-end gap-3">
            <Button type="button" variant="secondary" disabled={editSaving} onClick={() => setEditingPayment(null)}>
              Отмена
            </Button>
            <Button type="submit" disabled={editSaving}>
              {editSaving ? "Сохраняем..." : "Сохранить"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
