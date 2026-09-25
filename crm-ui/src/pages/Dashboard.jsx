import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CircleDollarSign,
  Clock3,
  Landmark,
  RefreshCw,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { useNavigate } from "react-router-dom";

import { fetchCashForecast, fetchFinanceAnalytics, fetchProjectStatuses, fetchProjects, getUser, isAdminUser } from "../api";

const moneyFormatter = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const APPLICATION_NAMES = new Set(["заявка", "заявки", "application", "applications", "lead", "leads"]);

function formatMoney(value) {
  return moneyFormatter.format(Number(value || 0));
}

function formatPercent(value) {
  return `${Number(value || 0).toLocaleString("ru-RU", { maximumFractionDigits: 2 })}%`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });
}

function projectAge(project) {
  const source = project.updated_at || project.created_at;
  if (!source) return 0;
  const date = new Date(source);
  if (Number.isNaN(date.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24)));
}

function projectDisplayName(project) {
  const number = project?.order_number_label ? `№${project.order_number_label} · ` : "";
  return `${number}${project?.title || project?.client_name || `Проект #${project?.id || ""}`}`;
}

function normalizeStatusValue(value) {
  return String(value || "").trim().toLocaleLowerCase("ru-RU");
}

function MetricCard({ icon: Icon, label, value, note, tone = "slate", onClick }) {
  const toneClasses = {
    blue: "bg-blue-50 text-blue-600 ring-blue-100",
    emerald: "bg-emerald-50 text-emerald-600 ring-emerald-100",
    amber: "bg-amber-50 text-amber-600 ring-amber-100",
    red: "bg-red-50 text-red-600 ring-red-100",
    slate: "bg-slate-100 text-slate-600 ring-slate-200",
  };
  const Component = onClick ? "button" : "div";

  return (
    <Component
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={`rounded-[26px] bg-white p-4 text-left shadow-sm ring-1 ring-slate-200/70 ${
        onClick ? "transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-400" : ""
      }`}
    >
      <div className={`inline-flex h-9 w-9 items-center justify-center rounded-2xl ring-1 ${toneClasses[tone]}`}>
        <Icon size={17} />
      </div>
      <div className="mt-4 text-[10px] font-black uppercase tracking-[0.17em] text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-black tracking-tight text-slate-950">{value}</div>
      <div className="mt-1 text-xs font-semibold text-slate-500">{note}</div>
    </Component>
  );
}

function Section({ id, title, description, action, children, className = "" }) {
  return (
    <section id={id} className={`rounded-[30px] bg-white p-4 shadow-sm ring-1 ring-slate-200/70 sm:p-5 ${className}`}>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-black tracking-tight text-slate-950">{title}</h2>
          {description ? <p className="mt-1 text-xs font-semibold leading-5 text-slate-500">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function ProjectRow({ project, meta, tone = "slate", onClick }) {
  const toneClass =
    tone === "amber"
      ? "bg-amber-50 text-amber-700"
      : tone === "red"
        ? "bg-red-50 text-red-600"
        : "bg-slate-100 text-slate-600";

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center justify-between gap-3 rounded-2xl bg-slate-50 px-3 py-3 text-left transition hover:bg-blue-50"
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-black text-slate-900">{projectDisplayName(project)}</div>
        <div className="mt-1 truncate text-xs font-semibold text-slate-500">{project.client_name || "Клиент не указан"}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {meta ? <span className={`rounded-full px-2.5 py-1 text-[10px] font-black ${toneClass}`}>{meta}</span> : null}
        <ArrowRight size={15} className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-blue-600" />
      </div>
    </button>
  );
}

function EmptyState({ children }) {
  return <div className="rounded-2xl bg-slate-50 px-4 py-8 text-center text-sm font-semibold text-slate-400">{children}</div>;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const isAdmin = isAdminUser(getUser());
  const [projects, setProjects] = useState([]);
  const [statuses, setStatuses] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [cashForecast, setCashForecast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let active = true;

    (async () => {
      setLoading(true);
      setError("");
      const results = await Promise.allSettled([
        fetchProjects(),
        fetchProjectStatuses(),
        fetchFinanceAnalytics(),
        fetchCashForecast(),
      ]);
      if (!active) return;

      const [projectResult, statusResult, analyticsResult, forecastResult] = results;
      setProjects(projectResult.status === "fulfilled" ? projectResult.value : []);
      setStatuses(statusResult.status === "fulfilled" ? statusResult.value : []);
      setAnalytics(analyticsResult.status === "fulfilled" ? analyticsResult.value : null);
      setCashForecast(forecastResult.status === "fulfilled" ? forecastResult.value : null);
      if (results.some((result) => result.status === "rejected")) {
        setError("Часть данных временно недоступна. Остальные показатели обновлены.");
      }
      setLoading(false);
    })();

    return () => {
      active = false;
    };
  }, [refreshKey]);

  const statusMap = useMemo(() => new Map(statuses.map((status) => [status.code, status])), [statuses]);
  const applicationStatusCodes = useMemo(
    () =>
      new Set(
        statuses
          .filter(
            (status) =>
              APPLICATION_NAMES.has(normalizeStatusValue(status.code)) ||
              APPLICATION_NAMES.has(normalizeStatusValue(status.name))
          )
          .map((status) => status.code)
      ),
    [statuses]
  );
  const terminalStatusCode = statuses[statuses.length - 1]?.code || "";
  const activeProjects = useMemo(
    () =>
      projects.filter(
        (project) =>
          !applicationStatusCodes.has(project.status) &&
          project.status !== terminalStatusCode &&
          !["closed", "completed", "done", "canceled"].includes(normalizeStatusValue(project.status))
      ),
    [applicationStatusCodes, projects, terminalStatusCode]
  );
  const applications = useMemo(
    () => projects.filter((project) => applicationStatusCodes.has(project.status)).slice(0, 6),
    [applicationStatusCodes, projects]
  );
  const stuckProjects = useMemo(
    () =>
      activeProjects
        .filter((project) => projectAge(project) >= Number(statusMap.get(project.status)?.stuck_after_days || 5))
        .sort((left, right) => projectAge(right) - projectAge(left))
        .slice(0, 6),
    [activeProjects, statusMap]
  );
  const recentProjects = useMemo(
    () =>
      [...activeProjects]
        .sort((left, right) => new Date(right.updated_at || right.created_at) - new Date(left.updated_at || left.created_at))
        .slice(0, 6),
    [activeProjects]
  );
  const statusSummary = useMemo(
    () =>
      statuses.map((status) => {
        const statusProjects = projects.filter((project) => project.status === status.code);
        return {
          ...status,
          count: statusProjects.length,
          amount: statusProjects.reduce((sum, project) => sum + Number(project.total_amount || 0), 0),
        };
      }),
    [projects, statuses]
  );

  const atRiskProjects = analytics?.at_risk_projects || [];
  const summary = analytics?.summary || {};

  function openProject(projectId, tab = "comments") {
    navigate("/projects", { state: { projectId, tab } });
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-black tracking-tight text-slate-950">Состояние бизнеса</h2>
          <p className="mt-1 text-sm font-semibold text-slate-500">Проекты, деньги и точки внимания на текущий момент.</p>
        </div>
        <button
          type="button"
          onClick={() => setRefreshKey((value) => value + 1)}
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-black text-slate-700 shadow-sm ring-1 ring-slate-200 transition hover:bg-slate-50 disabled:opacity-60"
        >
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          Обновить
        </button>
      </div>

      {error ? <div className="rounded-2xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-700">{error}</div> : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <MetricCard
          icon={Landmark}
          label="Сейчас в кассе"
          value={`${formatMoney(cashForecast?.current_balance)} ₽`}
          note="Фактический остаток"
          tone={Number(cashForecast?.current_balance || 0) < 0 ? "red" : "slate"}
        />
        <MetricCard icon={CircleDollarSign} label="Ожидаемый доход" value={`${formatMoney(cashForecast?.forecast_income)} ₽`} note="На горизонте 60 дней" tone="emerald" />
        <MetricCard icon={TrendingDown} label="Ожидаемый расход" value={`${formatMoney(cashForecast?.forecast_expense)} ₽`} note="На горизонте 60 дней" tone="red" />
        <MetricCard
          icon={TrendingUp}
          label="Баланс через 60 дней"
          value={`${formatMoney(cashForecast?.projected_balance_60_days)} ₽`}
          note="С учётом прогноза расходов"
          tone={Number(cashForecast?.projected_balance_60_days || 0) < 0 ? "red" : "emerald"}
        />
        <MetricCard
          icon={CircleDollarSign}
          label="Фактическая маржа"
          value={formatPercent(summary.margin_percent)}
          note={`${formatMoney(summary.margin_amount)} ₽ по операциям`}
          tone={Number(summary.margin_percent || 0) < 30 ? "amber" : "blue"}
        />
        <MetricCard
          icon={AlertTriangle}
          label="Проекты с риском"
          value={summary.at_risk_project_count || 0}
          note={atRiskProjects.length ? "Нажмите, чтобы посмотреть" : "Критичных рисков нет"}
          tone={atRiskProjects.length ? "amber" : "emerald"}
          onClick={
            atRiskProjects.length
              ? () => document.getElementById("dashboard-risks")?.scrollIntoView({ behavior: "smooth" })
              : undefined
          }
        />
      </div>

      <Section title="Проекты по этапам" description="Количество и общая стоимость проектов на каждом этапе.">
        <div className="no-scrollbar flex gap-3 overflow-x-auto pb-1">
          {statusSummary.map((status) => (
            <div key={status.code} className="min-w-[180px] flex-1 rounded-[22px] bg-slate-50 px-4 py-3 ring-1 ring-slate-100">
              <div className="truncate text-xs font-black uppercase tracking-wide text-slate-500">{status.name}</div>
              <div className="mt-3 flex items-end justify-between gap-3">
                <div className="text-2xl font-black text-slate-950">{status.count}</div>
                <div className="text-right text-xs font-black text-slate-500">{formatMoney(status.amount)} ₽</div>
              </div>
            </div>
          ))}
          {!statusSummary.length ? <EmptyState>Этапы проектов пока не настроены.</EmptyState> : null}
        </div>
      </Section>

      <div className="grid gap-5 xl:grid-cols-2">
        <Section
          id="dashboard-risks"
          title="Финансовые риски"
          description="Проекты на поздних этапах с низкой маржой, неполной оплатой или недостающими расходами."
          className="scroll-mt-5"
          action={isAdmin ? (
            <button type="button" onClick={() => navigate("/finances")} className="shrink-0 text-xs font-black text-blue-600 hover:text-blue-800">
              В аналитику
            </button>
          ) : null}
        >
          <div className="space-y-2">
            {atRiskProjects.slice(0, 6).map((project) => (
              <ProjectRow
                key={project.id}
                project={{ ...project, order_number_label: "" }}
                meta={
                  project.low_margin
                    ? `Маржа ${Number(project.margin_percent || 0).toLocaleString("ru-RU")}%`
                    : project.missing_required_expenses?.length
                      ? `Проверить: ${project.missing_required_expenses.slice(0, 2).join(", ")}`
                      : "Не закрыта оплата"
                }
                tone="amber"
                onClick={() => openProject(project.id, "finances")}
              />
            ))}
            {!atRiskProjects.length ? <EmptyState>Проектов с финансовыми рисками сейчас нет.</EmptyState> : null}
          </div>
        </Section>

        <Section title="Зависшие проекты" description="Проекты, в которых дольше допустимого не было изменений.">
          <div className="space-y-2">
            {stuckProjects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                meta={`${projectAge(project)} дн.`}
                tone="red"
                onClick={() => openProject(project.id)}
              />
            ))}
            {!stuckProjects.length ? <EmptyState>Нет проектов, требующих внимания по срокам.</EmptyState> : null}
          </div>
        </Section>

        <Section
          title="Новые заявки"
          description="Расчёты из калькулятора, которые ещё не переведены в работу."
          action={
            <button type="button" onClick={() => navigate("/projects")} className="shrink-0 text-xs font-black text-blue-600 hover:text-blue-800">
              Все проекты
            </button>
          }
        >
          <div className="space-y-2">
            {applications.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                meta={formatDate(project.created_at)}
                tone="slate"
                onClick={() => openProject(project.id)}
              />
            ))}
            {!applications.length ? <EmptyState>Новых заявок сейчас нет.</EmptyState> : null}
          </div>
        </Section>

        <Section title="Последние изменения" description="Проекты в работе, которые обновлялись последними.">
          <div className="space-y-2">
            {recentProjects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                meta={projectAge(project) === 0 ? "Сегодня" : formatDate(project.updated_at || project.created_at)}
                tone="slate"
                onClick={() => openProject(project.id)}
              />
            ))}
            {!recentProjects.length ? <EmptyState>Активных проектов пока нет.</EmptyState> : null}
          </div>
        </Section>
      </div>

      <div className="flex items-center gap-2 px-1 text-xs font-semibold text-slate-400">
        <Clock3 size={14} />
        Финансовые показатели учитывают текущие операции и прогноз на 60 дней. Заявки в расчёты не входят.
      </div>
    </div>
  );
}
