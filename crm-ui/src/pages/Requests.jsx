import React, { useEffect, useMemo, useState } from "react";
import { ExternalLink, LoaderCircle, Phone, RefreshCw, ShieldQuestion } from "lucide-react";

import { extractApiErrorMessage, fetchCalculatorLeads, updateCalculatorLead } from "../api";
import { Badge, Button, Card, CardBody, CardHeader } from "../components/ui.jsx";

const STATUS_LABELS = {
  new: "Новая",
  in_progress: "В работе",
  done: "Завершена",
};

const PRODUCT_LABELS = {
  shower: "Душевая",
  mirror: "Зеркало",
};

const formatDate = (value) => new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "short",
  timeStyle: "short",
}).format(new Date(value));

const formatMoney = (value) => `${Number(value || 0).toLocaleString("ru-RU")} ₽`;

export default function Requests() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingId, setSavingId] = useState(null);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setLeads(await fetchCalculatorLeads());
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось загрузить заявки калькулятора."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const activeCount = useMemo(() => leads.filter((lead) => lead.status !== "done").length, [leads]);

  const changeStatus = async (leadId, status) => {
    setSavingId(leadId);
    setError("");
    try {
      await updateCalculatorLead(leadId, { status });
      setLeads((current) => current.map((lead) => lead.id === leadId ? { ...lead, status } : lead));
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось обновить заявку."));
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-black text-gray-800">
            <ShieldQuestion size={20} className="text-blue-500" />
            Заявки калькулятора
          </h2>
          <p className="mt-1 text-sm text-gray-500">Расчёты, отправленные с amalgama.cehcrm.ru</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge>{activeCount} активных</Badge>
          <Button type="button" variant="secondary" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            Обновить
          </Button>
        </div>
      </div>

      {error ? <div className="mb-4 rounded-xl bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{error}</div> : null}

      <Card>
        <CardHeader>
          <div className="text-lg font-black tracking-tight text-gray-900">Входящие расчёты</div>
        </CardHeader>
        <CardBody>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-gray-400">
                <tr>
                  <th className="pb-3 font-black">Дата</th>
                  <th className="pb-3 font-black">Клиент</th>
                  <th className="pb-3 font-black">Изделие</th>
                  <th className="pb-3 font-black">Расчёт</th>
                  <th className="pb-3 font-black">Статус</th>
                  <th className="pb-3 text-right font-black">Действия</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {leads.map((lead) => (
                  <tr key={lead.id} className="align-top">
                    <td className="py-4 pr-4 text-gray-500">{formatDate(lead.created_at)}</td>
                    <td className="py-4 pr-4">
                      <strong className="block text-gray-900">{lead.client_name}</strong>
                      <a className="mt-1 inline-flex items-center gap-1 font-semibold text-blue-600" href={`tel:${lead.client_phone}`}>
                        <Phone size={14} /> {lead.client_phone}
                      </a>
                      {lead.client_email ? <span className="mt-1 block text-xs text-gray-500">{lead.client_email}</span> : null}
                    </td>
                    <td className="py-4 pr-4">
                      <strong className="block text-gray-900">{PRODUCT_LABELS[lead.product] || lead.product}</strong>
                      <span className="mt-1 block text-xs text-gray-500">Версия цен: {formatDate(lead.price_version)}</span>
                    </td>
                    <td className="py-4 pr-4 text-base font-black text-gray-900">{formatMoney(lead.amount)}</td>
                    <td className="py-4 pr-4">
                      <select
                        aria-label={`Статус заявки ${lead.id}`}
                        className="min-h-10 rounded-xl border border-gray-200 bg-white px-3 font-semibold text-gray-700"
                        disabled={savingId === lead.id}
                        value={lead.status}
                        onChange={(event) => void changeStatus(lead.id, event.target.value)}
                      >
                        {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </td>
                    <td className="py-4 text-right">
                      {lead.source_url ? (
                        <a className="inline-flex min-h-10 items-center gap-2 rounded-xl px-3 font-semibold text-blue-600 hover:bg-blue-50" href={lead.source_url} rel="noreferrer" target="_blank">
                          <ExternalLink size={16} /> Источник
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {!loading && leads.length === 0 ? (
                  <tr><td className="py-12 text-center text-gray-400" colSpan={6}>Заявок пока нет.</td></tr>
                ) : null}
                {loading ? (
                  <tr><td className="py-12 text-center text-gray-400" colSpan={6}><LoaderCircle className="mx-auto animate-spin" /></td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
