import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowUpCircle, Brain, CheckCircle2, Pencil, Plus, RefreshCw, SlidersHorizontal, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";

import {
  createPayment,
  deletePayment,
  extractApiErrorMessage,
  fetchAccounts,
  fetchCashForecast,
  fetchFinanceAnalytics,
  fetchFinanceCategories,
  fetchPayments,
  fetchProjects,
  requestCashForecastAi,
  requestFinanceAiAnalysis,
  updatePayment,
} from "../api";
import { Badge, Button, Input, Label, Modal, Select } from "../components/ui.jsx";

const moneyFormatter = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

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

function createPaymentForm(payment = {}) {
  const categoryKind = payment.id ? paymentKind(payment) : "";

  return {
    project: payment.project ? String(payment.project) : "",
    category_kind: categoryKind,
    category: payment.category ? String(payment.category) : "",
    account: payment.account ? String(payment.account) : "",
    amount: payment.amount ? String(payment.amount) : "",
    comment: payment.comment || "",
    paid_at: toDateInputValue(payment.paid_at),
  };
}

function paymentDisplaySignedAmount(payment) {
  const amount = Number(payment?.amount || 0);
  return paymentKind(payment) === "expense" ? -amount : amount;
}

function paymentSignedAmount(payment) {
  if (isFuturePayment(payment)) return 0;
  return paymentDisplaySignedAmount(payment);
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

function formatPercent(value) {
  if (value === null || value === undefined || value === "") return "—";
  return `${Number(value || 0).toLocaleString("ru-RU", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}%`;
}

function AnalyticsMetric({ label, value, tone = "slate", note = "" }) {
  const toneClass =
    tone === "green"
      ? "text-emerald-600"
      : tone === "red"
        ? "text-red-600"
        : tone === "amber"
          ? "text-amber-600"
          : "text-slate-900";

  return (
    <div className="rounded-[24px] bg-slate-50 p-4 ring-1 ring-slate-200/60">
      <div className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">{label}</div>
      <div className={`mt-2 text-2xl font-black tracking-tight ${toneClass}`}>{value}</div>
      {note ? <div className="mt-1 text-xs font-semibold text-slate-500">{note}</div> : null}
    </div>
  );
}

function FinanceAnalyticsBlock({
  analytics,
  loading,
  error,
  aiAnalysis,
  aiError,
  aiLoading,
  onRefresh,
  onAnalyze,
  onProjectOpen,
}) {
  const summary = analytics?.summary || {};
  const atRiskProjects = analytics?.at_risk_projects || [];
  const categoryTotals = analytics?.category_totals || [];
  const recommendations = analytics?.recommendations || [];
  const expensePrediction = analytics?.expense_prediction || null;
  const marginValue = Number(summary.margin_percent || 0);

  return (
    <div className="mb-4 rounded-[32px] bg-white p-4 shadow-lg sm:p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-black uppercase tracking-tight text-slate-900">
            <Brain size={18} className="text-blue-600" />
            Финансы-аналитика
          </div>
          <div className="mt-1 text-xs font-semibold leading-5 text-slate-500">
            Проверяет операции, маржу по проектам, обязательные расходники и дает рекомендации.
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="secondary" className="justify-center" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            Обновить
          </Button>
          <Button type="button" className="justify-center" onClick={onAnalyze} disabled={aiLoading || loading}>
            <Brain size={16} />
            {aiLoading ? "Gemini анализирует..." : "AI-анализ"}
          </Button>
        </div>
      </div>

      {error ? <div className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
      {aiError ? <div className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{aiError}</div> : null}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <AnalyticsMetric label="Доходы" value={`${formatMoney(summary.income_total)} ₽`} tone="green" note={`${summary.income_operation_count || 0} операций`} />
        <AnalyticsMetric label="Расходы" value={`${formatMoney(summary.expense_total)} ₽`} tone="red" note={`${summary.expense_operation_count || 0} операций`} />
        <AnalyticsMetric
          label="Маржа"
          value={formatPercent(summary.margin_percent)}
          tone={marginValue > 0 && marginValue < 30 ? "amber" : "slate"}
          note={`${formatMoney(summary.margin_amount)} ₽`}
        />
        <AnalyticsMetric
          label="Проекты с риском"
          value={summary.at_risk_project_count || 0}
          tone={summary.at_risk_project_count ? "amber" : "green"}
          note={`Всего проектов: ${summary.project_count || 0}`}
        />
      </div>

      {expensePrediction ? (
        <div className="mt-4 rounded-[24px] bg-blue-50 p-4 ring-1 ring-blue-100">
          <div className="text-xs font-black uppercase tracking-[0.18em] text-blue-600">Прогноз расходов по проекту</div>
          <div className="mt-2 text-sm font-semibold leading-5 text-slate-600">{expensePrediction.message}</div>
          {expensePrediction.project ? (
            <button
              type="button"
              className="mt-3 inline-flex items-center rounded-2xl bg-white px-4 py-2 text-sm font-black text-blue-600 shadow-sm ring-1 ring-blue-100 transition hover:bg-blue-100"
              onClick={() => onProjectOpen?.(expensePrediction.project)}
            >
              Открыть карточку проекта
            </button>
          ) : null}
          {expensePrediction.estimated_expense_total ? (
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <AnalyticsMetric
                label="Оценка расходов"
                value={`${formatMoney(expensePrediction.estimated_expense_total)} ₽`}
                tone="slate"
                note={`Средняя доля: ${formatPercent(expensePrediction.average_expense_percent)}`}
              />
              <AnalyticsMetric
                label="Уже внесено"
                value={`${formatMoney(expensePrediction.current_expense_total)} ₽`}
                tone="red"
                note="Текущие расходы проекта"
              />
              <AnalyticsMetric
                label="Еще может уйти"
                value={`${formatMoney(expensePrediction.estimated_remaining_expense)} ₽`}
                tone={Number(expensePrediction.estimated_remaining_expense || 0) > 0 ? "amber" : "green"}
                note={`База: ${expensePrediction.basis_project_count || 0} проектов`}
              />
            </div>
          ) : null}
          {expensePrediction.basis_projects?.length ? (
            <div className="mt-4 rounded-[20px] bg-white/80 p-3 ring-1 ring-blue-100">
              <div className="text-[10px] font-black uppercase tracking-[0.18em] text-blue-500">База прогноза</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {expensePrediction.basis_projects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    className="rounded-full bg-blue-50 px-3 py-1.5 text-xs font-black text-blue-700 transition hover:bg-blue-100"
                    onClick={() => onProjectOpen?.(project.id)}
                  >
                    {project.title}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="rounded-[24px] bg-slate-50 p-4">
          <div className="mb-3 flex items-center gap-2 text-xs font-black uppercase tracking-[0.18em] text-slate-400">
            <AlertTriangle size={15} />
            Что проверить
          </div>
          {recommendations.length > 0 ? (
            <div className="space-y-2">
              {recommendations.map((item) => (
                <div key={item} className="flex gap-2 rounded-2xl bg-white px-3 py-2 text-sm font-semibold leading-5 text-slate-600 ring-1 ring-slate-100">
                  <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-blue-600" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl bg-white px-3 py-3 text-sm font-semibold text-slate-500 ring-1 ring-slate-100">
              Данных для рекомендаций пока нет.
            </div>
          )}
        </div>

        <div className="rounded-[24px] bg-slate-50 p-4">
          <div className="mb-3 text-xs font-black uppercase tracking-[0.18em] text-slate-400">Категории операций</div>
          <div className="space-y-2">
            {categoryTotals.slice(0, 6).map((item) => (
              <div key={`${item.type}-${item.id || item.name}`} className="flex items-center justify-between gap-3 rounded-2xl bg-white px-3 py-2 ring-1 ring-slate-100">
                <div className="min-w-0">
                  <div className="truncate text-sm font-bold text-slate-700">{item.name}</div>
                  <div className="text-xs font-semibold text-slate-400">{item.type === "expense" ? "Расход" : "Доход"} · {item.count} шт.</div>
                </div>
                <div className={`shrink-0 text-sm font-black ${item.type === "expense" ? "text-red-600" : "text-emerald-600"}`}>
                  {formatMoney(item.total)} ₽
                </div>
              </div>
            ))}
            {categoryTotals.length === 0 ? (
              <div className="rounded-2xl bg-white px-3 py-3 text-sm font-semibold text-slate-500 ring-1 ring-slate-100">
                Операций по выбранной выборке нет.
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {atRiskProjects.length > 0 ? (
        <div className="mt-4 rounded-[24px] bg-amber-50 p-4">
          <div className="mb-3 text-xs font-black uppercase tracking-[0.18em] text-amber-600">Проекты, требующие проверки</div>
          <div className="grid gap-2 lg:grid-cols-2">
            {atRiskProjects.slice(0, 6).map((project) => (
              <button
                key={project.id}
                type="button"
                className="rounded-2xl bg-white px-3 py-3 text-left text-sm ring-1 ring-amber-100 transition hover:bg-amber-100/70"
                onClick={() => onProjectOpen?.(project.id)}
              >
                <div className="font-black text-slate-900">{project.title}</div>
                <div className="mt-1 text-xs font-semibold text-slate-500">
                  Маржа: {formatPercent(project.margin_percent)} · не хватает: {project.missing_required_expenses.join(", ") || "нет"}
                </div>
                <div className="mt-2 text-xs font-black text-blue-600">Открыть карточку проекта</div>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {aiAnalysis ? (
        <div className="mt-4 whitespace-pre-wrap rounded-[24px] bg-slate-950 px-4 py-4 text-sm font-semibold leading-6 text-white">
          {aiAnalysis}
        </div>
      ) : null}
    </div>
  );
}

function CashForecastBlock({
  forecast,
  loading,
  error,
  aiAnalysis,
  aiError,
  aiLoading,
  onRefresh,
  onAnalyze,
  onProjectOpen,
}) {
  const buckets = forecast?.buckets || [];
  const cashGapBucket = forecast?.cash_gap_bucket || "";

  return (
    <div className="mb-4 rounded-[32px] bg-white p-4 shadow-lg sm:p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-black uppercase tracking-tight text-slate-900">
            <Brain size={18} className="text-blue-600" />
            Кассовый прогноз
          </div>
          <div className="mt-1 text-xs font-semibold leading-5 text-slate-500">
            Сводит текущий остаток, будущие оплаты, ожидаемые поступления по проектам и оценку предстоящих расходов.
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="secondary" className="justify-center" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            Обновить
          </Button>
          <Button type="button" className="justify-center" onClick={onAnalyze} disabled={aiLoading || loading}>
            <Brain size={16} />
            {aiLoading ? "Gemini считает..." : "Gemini-прогноз"}
          </Button>
        </div>
      </div>

      {error ? <div className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
      {aiError ? <div className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{aiError}</div> : null}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <AnalyticsMetric label="Сейчас в кассе" value={`${formatMoney(forecast?.current_balance)} ₽`} note="Факт на сегодня" />
        <AnalyticsMetric label="Ожидаемый доход" value={`${formatMoney(forecast?.forecast_income)} ₽`} tone="green" note="На горизонте 60 дней" />
        <AnalyticsMetric label="Ожидаемый расход" value={`${formatMoney(forecast?.forecast_expense)} ₽`} tone="red" note={`Средняя доля: ${forecast?.average_expense_percent || "0"}%`} />
        <AnalyticsMetric
          label="Баланс через 60 дней"
          value={`${formatMoney(forecast?.projected_balance_60_days)} ₽`}
          tone={Number(forecast?.projected_balance_60_days || 0) < 0 ? "red" : "green"}
          note={cashGapBucket ? "Есть риск кассового разрыва" : "Разрыва не видно"}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-4">
        {buckets.map((bucket) => {
          const net = Number(bucket.net || 0);
          const projected = Number(bucket.projected_balance || 0);
          return (
            <div
              key={bucket.key}
              className={`rounded-[24px] p-4 ring-1 ${
                cashGapBucket === bucket.key ? "bg-red-50 ring-red-100" : "bg-slate-50 ring-slate-200/70"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-400">{bucket.label}</div>
                  <div className={`mt-2 text-2xl font-black ${projected < 0 ? "text-red-600" : "text-slate-900"}`}>
                    {formatMoney(projected)} ₽
                  </div>
                </div>
                {cashGapBucket === bucket.key ? (
                  <span className="rounded-full bg-red-100 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-red-600">
                    Разрыв
                  </span>
                ) : null}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs font-bold">
                <div className="rounded-2xl bg-white px-3 py-2 text-emerald-600">+ {formatMoney(bucket.income)} ₽</div>
                <div className="rounded-2xl bg-white px-3 py-2 text-red-600">− {formatMoney(bucket.expense)} ₽</div>
              </div>
              <div className={`mt-3 text-sm font-black ${net < 0 ? "text-red-600" : "text-emerald-600"}`}>
                Чистый поток: {net < 0 ? "−" : "+"} {formatMoney(Math.abs(net))} ₽
              </div>
              <div className="mt-3 space-y-2">
                {(bucket.items || []).slice(0, 4).map((item, index) => (
                  <button
                    key={`${bucket.key}-${item.type}-${item.project || "nop"}-${index}`}
                    type="button"
                    className="block w-full rounded-2xl bg-white px-3 py-2 text-left text-xs ring-1 ring-slate-100 transition hover:bg-blue-50"
                    onClick={() => onProjectOpen?.(item.project, item.kind === "expense" ? "finances" : "comments")}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-black text-slate-800">{item.project_title || item.title}</span>
                      <span className={item.kind === "expense" ? "font-black text-red-600" : "font-black text-emerald-600"}>
                        {item.kind === "expense" ? "−" : "+"} {formatMoney(item.amount)}
                      </span>
                    </div>
                    <div className="mt-1 truncate font-semibold text-slate-400">
                      {(item.missing_required_expenses || []).length
                        ? `Не закрыто: ${(item.missing_required_expenses || []).join(", ")}`
                        : item.title}
                    </div>
                  </button>
                ))}
                {(bucket.items || []).length === 0 ? (
                  <div className="rounded-2xl bg-white px-3 py-3 text-xs font-semibold text-slate-400 ring-1 ring-slate-100">
                    Движений пока нет.
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {aiAnalysis ? (
        <div className="mt-4 rounded-[24px] border border-blue-100 bg-blue-50/70 px-4 py-4 text-slate-900">
          <div className="mb-3 flex items-center gap-2 text-xs font-black uppercase tracking-[0.18em] text-blue-600">
            <Brain size={15} />
            Прогноз Gemini
          </div>
          <div className="max-h-[320px] overflow-y-auto whitespace-pre-wrap text-sm font-semibold leading-7">
            {aiAnalysis}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function Finances() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState([]);
  const [payments, setPayments] = useState([]);
  const [categories, setCategories] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [activeTab, setActiveTab] = useState("operations");
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
  const [analytics, setAnalytics] = useState(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsError, setAnalyticsError] = useState("");
  const [analyticsRefreshKey, setAnalyticsRefreshKey] = useState(0);
  const [analyticsProjectFilter, setAnalyticsProjectFilter] = useState("all");
  const [analyticsKindFilter, setAnalyticsKindFilter] = useState("all");
  const [analyticsDateFrom, setAnalyticsDateFrom] = useState("");
  const [analyticsDateTo, setAnalyticsDateTo] = useState("");
  const [aiAnalysis, setAiAnalysis] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [cashForecast, setCashForecast] = useState(null);
  const [cashForecastLoading, setCashForecastLoading] = useState(false);
  const [cashForecastError, setCashForecastError] = useState("");
  const [cashForecastRefreshKey, setCashForecastRefreshKey] = useState(0);
  const [cashAiAnalysis, setCashAiAnalysis] = useState("");
  const [cashAiLoading, setCashAiLoading] = useState(false);
  const [cashAiError, setCashAiError] = useState("");

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
  const hasMultipleAccounts = accounts.length > 1;
  const singleAccountId = accounts.length === 1 ? String(accounts[0].id) : "";

  const formCategoryOptions = useMemo(
    () => categories.filter((item) => item.type === paymentForm.category_kind),
    [categories, paymentForm.category_kind]
  );

  const filterCategoryOptions = useMemo(
    () => (kindFilter === "all" ? categories : categories.filter((item) => item.type === kindFilter)),
    [categories, kindFilter]
  );

  const analyticsParams = useMemo(
    () => ({
      project: analyticsProjectFilter,
      kind: analyticsKindFilter,
      date_from: analyticsDateFrom,
      date_to: analyticsDateTo,
    }),
    [analyticsDateFrom, analyticsDateTo, analyticsKindFilter, analyticsProjectFilter]
  );

  useEffect(() => {
    if (activeTab !== "analytics") return undefined;

    let active = true;
    const timer = window.setTimeout(async () => {
      setAnalyticsLoading(true);
      setAnalyticsError("");
      try {
        const data = await fetchFinanceAnalytics(analyticsParams);
        if (!active) return;
        setAnalytics(data);
      } catch (requestError) {
        if (!active) return;
        setAnalytics(null);
        setAnalyticsError(extractApiErrorMessage(requestError, "Не удалось загрузить финансовую аналитику."));
      } finally {
        if (active) setAnalyticsLoading(false);
      }
    }, 250);

    setAiAnalysis("");
    setAiError("");

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [activeTab, analyticsParams, analyticsRefreshKey]);

  useEffect(() => {
    if (activeTab !== "cashflow") return undefined;

    let active = true;
    const timer = window.setTimeout(async () => {
      setCashForecastLoading(true);
      setCashForecastError("");
      try {
        const data = await fetchCashForecast(analyticsParams);
        if (!active) return;
        setCashForecast(data);
      } catch (requestError) {
        if (!active) return;
        setCashForecast(null);
        setCashForecastError(extractApiErrorMessage(requestError, "Не удалось загрузить кассовый прогноз."));
      } finally {
        if (active) setCashForecastLoading(false);
      }
    }, 250);

    setCashAiAnalysis("");
    setCashAiError("");

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [activeTab, analyticsParams, cashForecastRefreshKey]);

  const filteredPayments = useMemo(() => {
    const minAmount = amountFrom ? Number(amountFrom) : null;
    const maxAmount = amountTo ? Number(amountTo) : null;
    const fromTime = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
    const toTime = dateTo ? new Date(`${dateTo}T23:59:59`).getTime() : null;

    return payments.filter((payment) => {
      const kind = paymentKind(payment);
      const signedAmount = paymentSignedAmount(payment);
      const absoluteAmount = Math.abs(signedAmount);
      const paidTime = payment.paid_at ? new Date(payment.paid_at).getTime() : null;

      const matchesProject = projectFilter === "all" || String(payment.project || "") === projectFilter;
      const matchesKind = kindFilter === "all" || kind === kindFilter;
      const matchesCategory = category === "all" || String(payment.category || "") === category;
      const matchesAccount = account === "all" || String(payment.account || "") === account;
      const matchesAmountFrom = minAmount === null || absoluteAmount >= minAmount;
      const matchesAmountTo = maxAmount === null || absoluteAmount <= maxAmount;
      const matchesDateFrom = fromTime === null || (paidTime !== null && paidTime >= fromTime);
      const matchesDateTo = toTime === null || (paidTime !== null && paidTime <= toTime);

      return (
        matchesProject &&
        matchesKind &&
        matchesCategory &&
        matchesAccount &&
        matchesAmountFrom &&
        matchesAmountTo &&
        matchesDateFrom &&
        matchesDateTo
      );
    });
  }, [account, amountFrom, amountTo, category, dateFrom, dateTo, kindFilter, payments, projectFilter]);

  function refreshAnalytics() {
    setAnalyticsRefreshKey((current) => current + 1);
  }

  function refreshCashForecast() {
    setCashForecastRefreshKey((current) => current + 1);
  }

  function openProjectFromAnalytics(projectId, tab = "comments") {
    if (!projectId) return;
    navigate("/projects", {
      state: {
        projectId,
        tab,
      },
    });
  }

  async function runAiAnalysis() {
    setAiError("");
    setAiAnalysis("");
    setAiLoading(true);

    try {
      const data = await requestFinanceAiAnalysis(analyticsParams);
      setAiAnalysis(data.analysis || "");
      if (data.overview) {
        setAnalytics(data.overview);
      }
    } catch (requestError) {
      setAiError(extractApiErrorMessage(requestError, "Gemini не смог выполнить финансовый анализ."));
    } finally {
      setAiLoading(false);
    }
  }

  async function runCashAiForecast() {
    setCashAiError("");
    setCashAiAnalysis("");
    setCashAiLoading(true);

    try {
      const data = await requestCashForecastAi(analyticsParams);
      setCashAiAnalysis(data.analysis || "");
      if (data.forecast) {
        setCashForecast(data.forecast);
      }
    } catch (requestError) {
      setCashAiError(extractApiErrorMessage(requestError, "Gemini не смог построить кассовый прогноз."));
    } finally {
      setCashAiLoading(false);
    }
  }

  function resetFilters() {
    setCategory("all");
    setAccount("all");
    setProjectFilter("all");
    setKindFilter("all");
    setDateFrom("");
    setDateTo("");
    setAmountFrom("");
    setAmountTo("");
  }

  function resetAnalyticsFilters() {
    setAnalyticsProjectFilter("all");
    setAnalyticsKindFilter("all");
    setAnalyticsDateFrom("");
    setAnalyticsDateTo("");
  }

  function tabButtonClass(tab) {
    const isActive = activeTab === tab;
    return `flex-1 rounded-2xl px-4 py-3 text-sm font-black transition ${
      isActive ? "bg-slate-950 text-white shadow-lg" : "text-slate-500 hover:bg-slate-100"
    }`;
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
      if (!paymentForm.category) {
        setActionError("Выберите категорию операции.");
        return;
      }
      if (!paymentForm.amount.trim()) {
        setActionError("Укажите сумму операции.");
        return;
      }
      if (!paymentForm.paid_at) {
        setActionError("Выберите дату операции.");
        return;
      }
      if (isPastDateValue(paymentForm.paid_at)) {
        setActionError("Нельзя поставить операцию задним числом.");
        return;
      }
      if (hasMultipleAccounts && !paymentForm.account) {
        setActionError("Выберите счет для операции.");
        return;
      }

      const payload = {
        project: paymentForm.project,
        category: paymentForm.category,
        account: hasMultipleAccounts ? paymentForm.account : singleAccountId || null,
        amount: paymentForm.amount.trim(),
        comment: paymentForm.comment.trim(),
        paid_at: toPaymentDateTime(paymentForm.paid_at),
      };

      if (editingPayment) {
        const updated = await updatePayment(editingPayment.id, payload);
        setPayments((current) => current.map((payment) => (payment.id === updated.id ? updated : payment)));
      } else {
        const created = await createPayment(payload);
        setPayments((current) => [created, ...current]);
      }

      refreshAnalytics();
      refreshCashForecast();
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
      refreshAnalytics();
      refreshCashForecast();
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
          <div className="text-xs text-slate-500">Создание, фильтрация и контроль операций по проектам.</div>
        </div>
        {activeTab === "operations" ? (
          <Button type="button" className="w-full justify-center lg:w-auto" onClick={openPaymentCreate}>
          <Plus size={16} />
          Добавить операцию
          </Button>
        ) : null}
      </div>

      <div className="mb-4 grid gap-2 rounded-[28px] bg-white p-2 shadow-lg sm:inline-grid sm:grid-cols-3">
        <button type="button" className={tabButtonClass("operations")} onClick={() => setActiveTab("operations")}>
          Операции
        </button>
        <button type="button" className={tabButtonClass("analytics")} onClick={() => setActiveTab("analytics")}>
          Аналитика
        </button>
        <button type="button" className={tabButtonClass("cashflow")} onClick={() => setActiveTab("cashflow")}>
          Кассовый прогноз
        </button>
      </div>

      {activeTab === "analytics" || activeTab === "cashflow" ? (
        <>
          <div className="mb-4 rounded-[28px] bg-white p-4 shadow-lg">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-2">
                <Label>Проект для анализа</Label>
                <Select value={analyticsProjectFilter} onChange={(event) => setAnalyticsProjectFilter(event.target.value)}>
                  <option value="all">Все проекты</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {projectDisplayName(project)}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Тип операций</Label>
                <Select value={analyticsKindFilter} onChange={(event) => setAnalyticsKindFilter(event.target.value)}>
                  <option value="all">Доходы и расходы</option>
                  <option value="income">Доход</option>
                  <option value="expense">Расход</option>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Дата от</Label>
                <Input type="date" value={analyticsDateFrom} onChange={(event) => setAnalyticsDateFrom(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Дата до</Label>
                <Input type="date" value={analyticsDateTo} onChange={(event) => setAnalyticsDateTo(event.target.value)} />
              </div>
            </div>
            <div className="mt-3 flex justify-end">
              <Button type="button" variant="ghost" className="justify-center" onClick={resetAnalyticsFilters}>
                Сбросить фильтры аналитики
              </Button>
            </div>
          </div>

          {activeTab === "analytics" ? (
            <FinanceAnalyticsBlock
              analytics={analytics}
              loading={analyticsLoading}
              error={analyticsError}
              aiAnalysis={aiAnalysis}
              aiError={aiError}
              aiLoading={aiLoading}
              onRefresh={refreshAnalytics}
              onAnalyze={runAiAnalysis}
              onProjectOpen={openProjectFromAnalytics}
            />
          ) : (
            <CashForecastBlock
              forecast={cashForecast}
              loading={cashForecastLoading}
              error={cashForecastError}
              aiAnalysis={cashAiAnalysis}
              aiError={cashAiError}
              aiLoading={cashAiLoading}
              onRefresh={refreshCashForecast}
              onAnalyze={runCashAiForecast}
              onProjectOpen={openProjectFromAnalytics}
            />
          )}
        </>
      ) : null}

      {activeTab === "operations" ? (
        <>

      <div className="mb-4 rounded-[28px] bg-white p-4 shadow-lg">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
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
            {hasMultipleAccounts ? (
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
            ) : null}
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
              {hasMultipleAccounts ? (
                <th className="px-6 py-3 text-left text-xs font-black uppercase tracking-widest text-gray-500">Счет</th>
              ) : null}
              <th className="px-6 py-3 text-left text-xs font-black uppercase tracking-widest text-gray-500">Комментарий</th>
              <th className="px-6 py-3 text-right text-xs font-black uppercase tracking-widest text-gray-500">Действия</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filteredPayments.map((payment) => {
              const signedAmount = paymentDisplaySignedAmount(payment);
              const futurePayment = isFuturePayment(payment);
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
                      {futurePayment ? <Badge className="ml-2 bg-blue-50 text-blue-600">Запланировано</Badge> : null}
                    </div>
                  </td>
                  {hasMultipleAccounts ? (
                    <td className="whitespace-nowrap px-6 py-4 text-sm text-gray-500">{payment.account_name || "—"}</td>
                  ) : null}
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
                <td className="py-10 text-center text-gray-400" colSpan={hasMultipleAccounts ? 6 : 5}>
                  Платежи не найдены
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="space-y-4 md:hidden">
        {filteredPayments.map((payment) => {
          const signedAmount = paymentDisplaySignedAmount(payment);
          const futurePayment = isFuturePayment(payment);
          return (
            <div key={payment.id} className="space-y-2 rounded-2xl bg-white p-4 shadow-lg">
              <div className="flex items-start justify-between">
                <div>
                  <div className={`text-xl font-bold ${signedAmount < 0 ? "text-red-600" : "text-green-600"}`}>
                    {signedAmount < 0 ? "−" : "+"} {formatMoney(Math.abs(signedAmount))} ₽
                  </div>
                  <div className="mt-1">
                    <Badge className={paymentCategoryBadgeClass(payment)}>{paymentCategoryLabel(payment)}</Badge>
                    {futurePayment ? <Badge className="ml-2 bg-blue-50 text-blue-600">Запланировано</Badge> : null}
                  </div>
                </div>
                <div className="text-xs text-gray-500">{formatDate(payment.paid_at)}</div>
              </div>
              <div className="border-t pt-2 text-sm text-gray-600">
                <p className="font-semibold text-gray-800">{projectDisplayName(projectMap.get(payment.project))}</p>
                {hasMultipleAccounts ? <p>{payment.account_name || "Счет не указан"}</p> : null}
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

        </>
      ) : null}

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
              <Label>Доход / расход</Label>
              <Select
                value={paymentForm.category_kind}
                onChange={(event) => {
                  const nextKind = event.target.value;
                  const firstCategory = categories.find((item) => item.type === nextKind);
                  setPaymentForm((prev) => ({
                    ...prev,
                    category_kind: nextKind,
                    category: firstCategory ? String(firstCategory.id) : "",
                  }));
                }}
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
                  <option value="">Выберите категорию</option>
                  {formCategoryOptions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
            {hasMultipleAccounts ? (
              <div className="space-y-2">
                <Label>Счет</Label>
                <Select value={paymentForm.account} onChange={(event) => setPaymentForm((prev) => ({ ...prev, account: event.target.value }))}>
                  <option value="">Выберите счет</option>
                  {accounts.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
            <div className="space-y-2">
              <Label>Сумма</Label>
              <Input value={paymentForm.amount} onChange={(event) => setPaymentForm((prev) => ({ ...prev, amount: event.target.value }))} />
            </div>
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
