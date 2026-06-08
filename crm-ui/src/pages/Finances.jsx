import React, { useEffect, useMemo, useState } from "react";
import { ArrowUpCircle, Pencil, Plus, Search, SlidersHorizontal, Trash2 } from "lucide-react";

import {
  createPayment,
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

const KIND_LABELS = {
  income: "Доход",
  expense: "Расход",
};

const moneyFormatter = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function defaultPaymentType(categoryKind) {
  return categoryKind === "expense" ? "correction" : "advance";
}

function paymentKind(payment) {
  if (payment?.category_type === "expense" || payment?.category_type === "income") return payment.category_type;
  return payment?.type === "refund" || payment?.type === "correction" ? "expense" : "income";
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

function createPaymentForm(payment = {}) {
  const categoryKind = payment.id ? paymentKind(payment) : "";

  return {
    project: payment.project ? String(payment.project) : "",
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
  return paymentKind(payment) === "expense" ? -amount : amount;
}

function projectDisplayName(project) {
  return project?.title || project?.client_name || `Проект #${project?.id || ""}`;
}

function paymentCategoryLabel(payment) {
  return payment?.category_name || "Без категории";
}

function paymentCategoryBadgeClass(payment) {
  return paymentKind(payment) === "expense" ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-600";
}

function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase();
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
  const [projectFilter, setProjectFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [amountFrom, setAmountFrom] = useState("");
  const [amountTo, setAmountTo] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [editingPayment, setEditingPayment] = useState(null);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [paymentForm, setPaymentForm] = useState(createPaymentForm());
  const [paymentSaving, setPaymentSaving] = useState(false);
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

  const formCategoryOptions = useMemo(
    () => categories.filter((item) => item.type === paymentForm.category_kind),
    [categories, paymentForm.category_kind]
  );

  const filterCategoryOptions = useMemo(
    () => (kindFilter === "all" ? categories : categories.filter((item) => item.type === kindFilter)),
    [categories, kindFilter]
  );

  const filteredPayments = useMemo(() => {
    const value = normalizeSearch(search);
    const minAmount = amountFrom ? Number(amountFrom) : null;
    const maxAmount = amountTo ? Number(amountTo) : null;
    const fromTime = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
    const toTime = dateTo ? new Date(`${dateTo}T23:59:59`).getTime() : null;

    return payments.filter((payment) => {
      const project = projectMap.get(payment.project);
      const kind = paymentKind(payment);
      const signedAmount = paymentSignedAmount(payment);
      const absoluteAmount = Math.abs(signedAmount);
      const paidTime = payment.paid_at ? new Date(payment.paid_at).getTime() : null;

      const matchesSearch =
        !value ||
        [
          project?.title,
          project?.client_name,
          project?.client_phone,
          project?.object_address,
          payment.comment,
          payment.category_name,
          payment.account_name,
          METHOD_LABELS[payment.method],
          KIND_LABELS[kind],
          formatDate(payment.paid_at),
          payment.amount,
          signedAmount,
        ]
          .filter((field) => field !== null && field !== undefined)
          .some((field) => normalizeSearch(field).includes(value));

      const matchesProject = projectFilter === "all" || String(payment.project || "") === projectFilter;
      const matchesKind = kindFilter === "all" || kind === kindFilter;
      const matchesMethod = method === "all" || payment.method === method;
      const matchesCategory = category === "all" || String(payment.category || "") === category;
      const matchesAccount = account === "all" || String(payment.account || "") === account;
      const matchesAmountFrom = minAmount === null || absoluteAmount >= minAmount;
      const matchesAmountTo = maxAmount === null || absoluteAmount <= maxAmount;
      const matchesDateFrom = fromTime === null || (paidTime !== null && paidTime >= fromTime);
      const matchesDateTo = toTime === null || (paidTime !== null && paidTime <= toTime);

      return (
        matchesSearch &&
        matchesProject &&
        matchesKind &&
        matchesMethod &&
        matchesCategory &&
        matchesAccount &&
        matchesAmountFrom &&
        matchesAmountTo &&
        matchesDateFrom &&
        matchesDateTo
      );
    });
  }, [account, amountFrom, amountTo, category, dateFrom, dateTo, kindFilter, method, payments, projectFilter, projectMap, search]);

  function resetFilters() {
    setSearch("");
    setMethod("all");
    setCategory("all");
    setAccount("all");
    setProjectFilter("all");
    setKindFilter("all");
    setDateFrom("");
    setDateTo("");
    setAmountFrom("");
    setAmountTo("");
  }

  function openPaymentCreate() {
    setActionError("");
    setEditingPayment(null);
    setPaymentForm(createPaymentForm());
    setPaymentModalOpen(true);
  }

  function openPaymentEdit(payment) {
    setActionError("");
    setEditingPayment(payment);
    setPaymentForm(createPaymentForm(payment));
    setPaymentModalOpen(true);
  }

  function closePaymentModal() {
    if (paymentSaving) return;
    setPaymentModalOpen(false);
    setEditingPayment(null);
    setPaymentForm(createPaymentForm());
    setActionError("");
  }

  async function submitPaymentForm(event) {
    event.preventDefault();

    setActionError("");
    setPaymentSaving(true);
    try {
      if (!paymentForm.project) {
        setActionError("Выберите проект для операции.");
        return;
      }
      if (!paymentForm.category_kind) {
        setActionError("Выберите тип операции: доход или расход.");
        return;
      }
      if (!paymentForm.amount.trim()) {
        setActionError("Укажите сумму операции.");
        return;
      }

      const payload = {
        project: paymentForm.project,
        category: paymentForm.category || null,
        account: paymentForm.account || null,
        type: paymentForm.type || defaultPaymentType(paymentForm.category_kind),
        amount: paymentForm.amount.trim(),
        method: paymentForm.method,
        comment: paymentForm.comment.trim(),
        paid_at: paymentForm.paid_at || undefined,
      };

      if (editingPayment) {
        const updated = await updatePayment(editingPayment.id, payload);
        setPayments((current) => current.map((payment) => (payment.id === updated.id ? updated : payment)));
      } else {
        const created = await createPayment(payload);
        setPayments((current) => [created, ...current]);
      }

      closePaymentModal();
    } catch (requestError) {
      setActionError(extractApiErrorMessage(requestError, "Не удалось сохранить операцию."));
    } finally {
      setPaymentSaving(false);
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

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="text-sm font-bold text-slate-900">Финансовые операции</div>
          <div className="text-xs text-slate-500">Создание, поиск, фильтрация и контроль операций по проектам.</div>
        </div>
        <Button type="button" className="w-full justify-center lg:w-auto" onClick={openPaymentCreate}>
          <Plus size={16} />
          Добавить операцию
        </Button>
      </div>

      <div className="mb-4 rounded-[28px] bg-white p-4 shadow-lg">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-grow">
            <Input
              className="pl-10"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Поиск по проекту, клиенту, телефону, адресу, сумме, комментарию..."
            />
            <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400" />
          </div>
          <Button type="button" variant="secondary" className="justify-center" onClick={() => setFiltersOpen((current) => !current)}>
            <SlidersHorizontal size={16} />
            Фильтры
          </Button>
          <Button type="button" variant="ghost" className="justify-center" onClick={resetFilters}>
            Сбросить
          </Button>
        </div>

        {filtersOpen && (
          <div className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-2">
              <Label>Проект</Label>
              <Select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
                <option value="all">Все проекты</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {projectDisplayName(project)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Тип операции</Label>
              <Select
                value={kindFilter}
                onChange={(event) => {
                  setKindFilter(event.target.value);
                  setCategory("all");
                }}
              >
                <option value="all">Доходы и расходы</option>
                <option value="income">Доход</option>
                <option value="expense">Расход</option>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Категория</Label>
              <Select value={category} onChange={(event) => setCategory(event.target.value)}>
                <option value="all">Все категории</option>
                {filterCategoryOptions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.type === "expense" ? "расход" : "доход"}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Счет</Label>
              <Select value={account} onChange={(event) => setAccount(event.target.value)}>
                <option value="all">Все счета</option>
                {accounts.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Способ оплаты</Label>
              <Select value={method} onChange={(event) => setMethod(event.target.value)}>
                <option value="all">Все способы</option>
                {Object.entries(METHOD_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Дата от</Label>
              <Input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Дата до</Label>
              <Input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Сумма от</Label>
                <Input inputMode="numeric" value={amountFrom} onChange={(event) => setAmountFrom(event.target.value)} placeholder="0" />
              </div>
              <div className="space-y-2">
                <Label>До</Label>
                <Input inputMode="numeric" value={amountTo} onChange={(event) => setAmountTo(event.target.value)} placeholder="100000" />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="hidden overflow-x-auto rounded-[32px] bg-white shadow-lg md:block">
        <table className="min-w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-black uppercase tracking-widest text-gray-500">Дата</th>
              <th className="px-6 py-3 text-left text-xs font-black uppercase tracking-widest text-gray-500">Проект</th>
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
                  <td className={`whitespace-nowrap px-6 py-4 text-sm font-bold ${signedAmount < 0 ? "text-red-600" : "text-green-600"}`}>
                    <span className="inline-flex items-center gap-2">
                      <ArrowUpCircle size={16} />
                      {signedAmount < 0 ? "−" : "+"} {formatMoney(Math.abs(signedAmount))} ₽
                    </span>
                    <div className="mt-2">
                      <Badge className={paymentCategoryBadgeClass(payment)}>{paymentCategoryLabel(payment)}</Badge>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-500">
                    {METHOD_LABELS[payment.method] || payment.method}
                    {payment.account_name ? ` · ${payment.account_name}` : ""}
                  </td>
                  <td className="max-w-xs truncate px-6 py-4 text-sm text-gray-500">{payment.comment || "—"}</td>
                  <td className="whitespace-nowrap px-6 py-4 text-right text-sm">
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-10 w-10 px-0 text-blue-600 hover:bg-blue-50"
                        onClick={() => openPaymentEdit(payment)}
                        title="Редактировать"
                        aria-label="Редактировать операцию"
                      >
                        <Pencil size={16} />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-10 w-10 px-0 text-red-600 hover:bg-red-50"
                        onClick={() => removePayment(payment.id)}
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
            {filteredPayments.length === 0 && (
              <tr>
                <td className="py-10 text-center text-gray-400" colSpan={6}>
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
                <div>
                  <div className={`text-xl font-bold ${signedAmount < 0 ? "text-red-600" : "text-green-600"}`}>
                    {signedAmount < 0 ? "−" : "+"} {formatMoney(Math.abs(signedAmount))} ₽
                  </div>
                  <div className="mt-1">
                    <Badge className={paymentCategoryBadgeClass(payment)}>{paymentCategoryLabel(payment)}</Badge>
                  </div>
                </div>
                <div className="text-xs text-gray-500">{formatDate(payment.paid_at)}</div>
              </div>
              <div className="border-t pt-2 text-sm text-gray-600">
                <p className="font-semibold text-gray-800">{projectDisplayName(projectMap.get(payment.project))}</p>
                <p>
                  {METHOD_LABELS[payment.method] || payment.method}
                  {payment.account_name ? ` · ${payment.account_name}` : ""}
                </p>
                <p className="truncate">{payment.comment || "Без комментария"}</p>
                <div className="flex gap-2 pt-2">
                  <Button type="button" variant="secondary" className="flex-1 justify-center" onClick={() => openPaymentEdit(payment)}>
                    <Pencil size={16} />
                    Редактировать
                  </Button>
                  <Button type="button" variant="danger" className="flex-1 justify-center" onClick={() => removePayment(payment.id)}>
                    <Trash2 size={16} />
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

      <Modal open={paymentModalOpen} title={editingPayment ? "Редактировать операцию" : "Добавить операцию"} onClose={closePaymentModal} widthClassName="max-w-2xl">
        <form className="space-y-4" onSubmit={submitPaymentForm}>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <Label>Проект</Label>
              <Select value={paymentForm.project} onChange={(event) => setPaymentForm((prev) => ({ ...prev, project: event.target.value }))}>
                <option value="">Выберите проект</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {projectDisplayName(project)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Тип операции</Label>
              <Select
                value={paymentForm.category_kind}
                onChange={(event) =>
                  setPaymentForm((prev) => ({
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
            {paymentForm.category_kind ? (
              <div className="space-y-2">
                <Label>{paymentForm.category_kind === "expense" ? "Категория расхода" : "Категория дохода"}</Label>
                <Select value={paymentForm.category} onChange={(event) => setPaymentForm((prev) => ({ ...prev, category: event.target.value }))}>
                  <option value="">Без категории</option>
                  {formCategoryOptions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
            <div className="space-y-2">
              <Label>Счет</Label>
              <Select value={paymentForm.account} onChange={(event) => setPaymentForm((prev) => ({ ...prev, account: event.target.value }))}>
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
              <Input value={paymentForm.amount} onChange={(event) => setPaymentForm((prev) => ({ ...prev, amount: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>Способ оплаты</Label>
              <Select value={paymentForm.method} onChange={(event) => setPaymentForm((prev) => ({ ...prev, method: event.target.value }))}>
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
                value={paymentForm.paid_at}
                onChange={(event) => setPaymentForm((prev) => ({ ...prev, paid_at: event.target.value }))}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Комментарий</Label>
            <Input value={paymentForm.comment} onChange={(event) => setPaymentForm((prev) => ({ ...prev, comment: event.target.value }))} />
          </div>
          {actionError && <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{actionError}</div>}
          <div className="flex justify-end gap-3">
            <Button type="button" variant="secondary" disabled={paymentSaving} onClick={closePaymentModal}>
              Отмена
            </Button>
            <Button type="submit" disabled={paymentSaving}>
              {paymentSaving ? "Сохраняем..." : editingPayment ? "Сохранить" : "Добавить"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
