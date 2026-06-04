import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  BadgeCheck,
  CalendarClock,
  CreditCard,
  LogOut,
  ReceiptText,
  ShieldAlert,
} from "lucide-react";
import { useNavigate } from "react-router-dom";

import {
  activateBillingInvoice,
  clearToken,
  createBillingInvoice,
  extractApiErrorMessage,
  fetchBillingSummary,
  getUser,
  isAdminUser,
} from "../api";
import { Badge, Button, Card, CardBody } from "../components/ui.jsx";

function formatRub(value) {
  const amount = Number(value || 0);
  return `${amount.toLocaleString("ru-RU")} ₽`;
}

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("ru-RU");
}

export default function Subscription() {
  const navigate = useNavigate();
  const user = getUser();
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const isAdmin = isAdminUser(user);

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const nextSummary = await fetchBillingSummary();
        if (!active) return;
        setSummary(nextSummary);
      } catch (requestError) {
        if (!active) return;
        setError(extractApiErrorMessage(requestError, "Не удалось загрузить статус подписки."));
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const subscription = summary?.subscription || null;
  const latestInvoice = summary?.latest_invoice || null;
  const plan = summary?.plan || null;
  const isActiveNow = Boolean(subscription?.is_active_now);
  const priceLabel = useMemo(() => formatRub(plan?.price_rub || 1500), [plan?.price_rub]);

  async function handleCreateInvoice() {
    setActionLoading(true);
    setError("");
    setNotice("");

    try {
      const response = await createBillingInvoice();
      setSummary(response.summary);
      setNotice("Счет на продление создан.");
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось создать счет на подписку."));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleActivateInvoice() {
    if (!latestInvoice?.id) return;

    setActionLoading(true);
    setError("");
    setNotice("");

    try {
      const response = await activateBillingInvoice(latestInvoice.id);
      setSummary(response.summary);
      setNotice("Подписка активирована. Доступ к CRM открыт.");
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось активировать подписку."));
    } finally {
      setActionLoading(false);
    }
  }

  function logout() {
    clearToken();
    navigate("/login");
  }

  if (loading) {
    return <div className="app-screen bg-[#f5f5f7]" />;
  }

  return (
    <div className="app-screen bg-[#f5f5f7] px-4 py-8 sm:px-6 lg:px-10">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[11px] font-black uppercase tracking-[0.26em] text-slate-400">Подписка</div>
            <h1 className="mt-3 text-3xl font-black tracking-tight text-slate-900 sm:text-4xl">
              {isActiveNow ? "Подписка активна" : "Доступ к CRM приостановлен"}
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-500 sm:text-base">
              CRM работает по ежемесячной подписке. Текущий тариф открывает все модули системы, проекты,
              финансы, задачи и голосового помощника.
            </p>
          </div>

          <Button type="button" variant="secondary" onClick={logout}>
            <LogOut size={16} />
            Выйти
          </Button>
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
          <Card>
            <CardBody className="grid gap-6 p-6 sm:p-8">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <div className="text-[11px] font-black uppercase tracking-[0.26em] text-slate-400">Тариф</div>
                  <div className="mt-3 text-3xl font-black tracking-tight text-slate-900">
                    {plan?.name || "ProCRM"}
                  </div>
                  <div className="mt-2 text-sm text-slate-500">
                    {plan?.description || "Полный доступ ко всем модулям CRM."}
                  </div>
                </div>

                <div className="rounded-[28px] bg-slate-900 px-6 py-5 text-white shadow-lg shadow-slate-900/10">
                  <div className="text-[11px] font-black uppercase tracking-[0.2em] text-white/60">Стоимость</div>
                  <div className="mt-2 text-3xl font-black">{priceLabel}</div>
                  <div className="mt-1 text-sm text-white/70">в месяц</div>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <div className="rounded-[28px] border border-slate-200 bg-slate-50/80 p-5">
                  <div className="flex items-center gap-3 text-slate-900">
                    <BadgeCheck size={18} />
                    <span className="text-sm font-semibold">Статус</span>
                  </div>
                  <div className="mt-4">
                    <Badge className={isActiveNow ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}>
                      {isActiveNow ? "Активна" : "Ожидает оплаты"}
                    </Badge>
                  </div>
                </div>

                <div className="rounded-[28px] border border-slate-200 bg-slate-50/80 p-5">
                  <div className="flex items-center gap-3 text-slate-900">
                    <CalendarClock size={18} />
                    <span className="text-sm font-semibold">Оплачено до</span>
                  </div>
                  <div className="mt-4 text-lg font-black tracking-tight text-slate-900">
                    {formatDate(subscription?.current_period_end)}
                  </div>
                  <div className="mt-2 text-xs text-slate-500">
                    {subscription?.days_left ? `Осталось ${subscription.days_left} дн.` : "Период еще не активирован"}
                  </div>
                </div>

                <div className="rounded-[28px] border border-slate-200 bg-slate-50/80 p-5">
                  <div className="flex items-center gap-3 text-slate-900">
                    <ReceiptText size={18} />
                    <span className="text-sm font-semibold">Последний счет</span>
                  </div>
                  <div className="mt-4 text-lg font-black tracking-tight text-slate-900">
                    {latestInvoice ? formatRub(latestInvoice.amount_rub) : "Не создан"}
                  </div>
                  <div className="mt-2 text-xs text-slate-500">
                    {latestInvoice
                      ? `${formatDate(latestInvoice.period_start)} — ${formatDate(latestInvoice.period_end)}`
                      : "Счет появится после оформления подписки"}
                  </div>
                </div>
              </div>

              {error ? <div className="rounded-[24px] bg-red-50 px-5 py-4 text-sm text-red-700">{error}</div> : null}
              {notice ? <div className="rounded-[24px] bg-emerald-50 px-5 py-4 text-sm text-emerald-700">{notice}</div> : null}

              <div className="flex flex-wrap gap-3">
                {isActiveNow ? (
                  <Button type="button" className="px-6 py-3" onClick={() => navigate("/")}>
                    Открыть CRM
                    <ArrowRight size={16} />
                  </Button>
                ) : null}

                {!isActiveNow && isAdmin && !latestInvoice ? (
                  <Button type="button" className="px-6 py-3" disabled={actionLoading} onClick={handleCreateInvoice}>
                    <CreditCard size={16} />
                    Оформить подписку за {priceLabel}
                  </Button>
                ) : null}

                {!isActiveNow && isAdmin && latestInvoice?.status === "pending" && !latestInvoice?.checkout_url ? (
                  <Button type="button" className="px-6 py-3" disabled={actionLoading} onClick={handleActivateInvoice}>
                    <BadgeCheck size={16} />
                    Подтвердить оплату
                  </Button>
                ) : null}

                {!isActiveNow && latestInvoice?.checkout_url ? (
                  <a
                    className="btn-hover inline-flex items-center justify-center gap-2 rounded-full bg-slate-900 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-slate-900/10 transition hover:bg-black"
                    href={latestInvoice.checkout_url}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <CreditCard size={16} />
                    Перейти к оплате
                  </a>
                ) : null}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardBody className="grid gap-5 p-6 sm:p-8">
              <div className="inline-flex h-14 w-14 items-center justify-center rounded-[22px] bg-slate-900 text-white shadow-lg shadow-slate-900/10">
                {isActiveNow ? <BadgeCheck size={24} /> : <ShieldAlert size={24} />}
              </div>

              <div>
                <div className="text-xl font-black tracking-tight text-slate-900">
                  {isActiveNow ? "Система открыта для работы" : "Нужна активная подписка"}
                </div>
                <p className="mt-3 text-sm leading-7 text-slate-500">
                  {isAdmin
                    ? "Как администратор вы можете оформить следующий период и открыть доступ всей команде."
                    : "Доступ к проектам и модулям команды откроется сразу после того, как администратор продлит подписку."}
                </p>
              </div>

              <div className="grid gap-3">
                <div className="rounded-[24px] border border-slate-200 bg-slate-50/80 px-5 py-4 text-sm text-slate-600">
                  1. Подписка единая для всей CRM и всей команды.
                </div>
                <div className="rounded-[24px] border border-slate-200 bg-slate-50/80 px-5 py-4 text-sm text-slate-600">
                  2. Стоимость фиксирована: {priceLabel} в месяц.
                </div>
                <div className="rounded-[24px] border border-slate-200 bg-slate-50/80 px-5 py-4 text-sm text-slate-600">
                  3. После активации снова доступны проекты, финансы, задачи и голосовой помощник.
                </div>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
