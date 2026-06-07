import React, { useEffect, useMemo, useState } from "react";
import { ArrowUpCircle, Search } from "lucide-react";

import { fetchAccounts, fetchFinanceCategories, fetchPayments, fetchProjects } from "../api";
import { Badge, Input, Select } from "../components/ui.jsx";

const METHOD_LABELS = {
  transfer: "Перевод",
  cash: "Наличные",
  card: "Карта",
  other: "Другое",
};

const TYPE_LABELS = {
  advance: "Аванс",
  additional: "Доплата",
  refund: "Возврат",
  correction: "Корректировка",
};

const moneyFormatter = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function formatMoney(value) {
  return moneyFormatter.format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toLocaleDateString("ru-RU");
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
  return payment?.category_name || TYPE_LABELS[payment?.type] || payment?.type || "Без категории";
}

function paymentCategoryBadgeClass(payment) {
  if (payment?.category_type === "expense") return "bg-red-50 text-red-600";
  if (payment?.category_type === "income") return "bg-emerald-50 text-emerald-600";
  return "";
}

function StatTile({ label, value, tone = "light" }) {
  return (
    <div className={`rounded-3xl p-4 shadow-lg sm:p-6 ${tone === "dark" ? "bg-gray-900 text-white" : "bg-white"}`}>
      <div className={`mb-1 text-sm font-bold uppercase tracking-wider ${tone === "dark" ? "text-gray-300" : "text-gray-400"}`}>
        {label}
      </div>
      <div className={`text-2xl font-black sm:text-3xl ${tone === "dark" ? "text-white" : "text-gray-800"}`}>{value}</div>
    </div>
  );
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

  const stats = useMemo(() => {
    const income = filteredPayments.reduce((sum, payment) => {
      const signedAmount = paymentSignedAmount(payment);
      return signedAmount > 0 ? sum + signedAmount : sum;
    }, 0);
    const expense = filteredPayments.reduce((sum, payment) => {
      const signedAmount = paymentSignedAmount(payment);
      return signedAmount < 0 ? sum + Math.abs(signedAmount) : sum;
    }, 0);
    const total = income - expense;
    const average = filteredPayments.length ? total / filteredPayments.length : 0;
    const thisMonth = filteredPayments
      .filter((payment) => {
        const date = payment.paid_at ? new Date(payment.paid_at) : null;
        if (!date || Number.isNaN(date.getTime())) return false;
        const now = new Date();
        return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
      })
      .reduce((sum, payment) => sum + paymentSignedAmount(payment), 0);

    return { total, income, expense, average, thisMonth, count: filteredPayments.length };
  }, [filteredPayments]);

  return (
    <div>
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Маржа" value={`${formatMoney(stats.total)} ₽`} tone="dark" />
        <StatTile label="Операции" value={stats.count} />
        <StatTile label="Доходы / расходы" value={`${formatMoney(stats.income)} / ${formatMoney(stats.expense)} ₽`} />
        <StatTile label="За месяц" value={`${formatMoney(stats.thisMonth)} ₽`} />
      </div>

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
                <div className={`text-xl font-bold ${signedAmount < 0 ? "text-red-600" : "text-green-600"}`}>
                  {signedAmount < 0 ? "−" : "+"} {formatMoney(Math.abs(signedAmount))} ₽
                </div>
                <div className="text-xs text-gray-500">{formatDate(payment.paid_at)}</div>
              </div>
              <div className="border-t pt-2 text-sm text-gray-600 [&>p:nth-child(3)]:hidden">
                <p className="font-semibold text-gray-800">{projectDisplayName(projectMap.get(payment.project))}</p>
                <p>
                  {paymentCategoryLabel(payment)} · {METHOD_LABELS[payment.method] || payment.method}
                  {payment.account_name ? ` · ${payment.account_name}` : ""}
                </p>
                <p>{TYPE_LABELS[payment.type] || payment.type} • {METHOD_LABELS[payment.method] || payment.method}</p>
                <p className="truncate">{payment.comment || "Без комментария"}</p>
              </div>
            </div>
          );
        })}
        {filteredPayments.length === 0 && (
          <div className="rounded-2xl bg-white p-8 text-center text-sm text-gray-400 shadow-lg">Платежи не найдены</div>
        )}
      </div>
    </div>
  );
}
