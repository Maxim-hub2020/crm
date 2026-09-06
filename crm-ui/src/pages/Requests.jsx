import React, { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, LoaderCircle, Phone, RefreshCw, ShieldQuestion, Trash2 } from "lucide-react";

import { deleteCalculatorLead, extractApiErrorMessage, fetchCalculatorLeads, fetchMe, updateCalculatorLead } from "../api";
import { Badge, Button, Card, CardBody, CardHeader, Modal } from "../components/ui.jsx";

const STATUS_LABELS = {
  new: "Новая",
  in_progress: "В работе",
  done: "Завершена",
};

const PRODUCT_LABELS = {
  shower: "Душевая",
  mirror: "Зеркало",
  mixed: "Несколько изделий",
};

const formatDate = (value) => !value || Number.isNaN(new Date(value).getTime()) ? "Не указана" : new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "short",
  timeStyle: "short",
}).format(new Date(value));

const formatMoney = (value) => `${Number(value || 0).toLocaleString("ru-RU")} ₽`;

const localDateTime = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

function LeadDetails({ lead, saving, onSave }) {
  const [note, setNote] = useState(lead.manager_note || "");
  const [followUp, setFollowUp] = useState(localDateTime(lead.follow_up_at));
  const items = Array.isArray(lead.configuration?.items) ? lead.configuration.items : [];
  return (
    <form className="space-y-4" onSubmit={(event) => {
      event.preventDefault();
      void onSave({ manager_note: note, follow_up_at: followUp ? new Date(followUp).toISOString() : null });
    }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <strong>{lead.client_name}</strong>
        {lead.client_phone ? <a className="inline-flex items-center gap-2 text-blue-600" href={`tel:${lead.client_phone}`}><Phone size={18} />{lead.client_phone}</a> : <span>Телефон не указан</span>}
      </div>
      <div className="text-xl font-black">{lead.configuration?.amount_is_from ? "От " : ""}{formatMoney(lead.amount)}</div>
      {lead.client_phone ? <a className="inline-flex items-center gap-2 text-sm font-semibold text-blue-600" href={`sms:${lead.client_phone}`}>Написать SMS</a> : null}
      {items.length > 0 ? <ul className="divide-y divide-gray-100 rounded-xl border border-gray-100 px-3">
        {items.map((item, index) => <li key={`${item.id}-${index}`} className="flex justify-between gap-3 py-3 text-sm">
          <span>{item.title} · {item.quantity} шт.</span><strong className="shrink-0">{formatMoney(item.amount)}</strong>
        </li>)}
      </ul> : null}
      {lead.configuration?.amount_is_from ? <p className="text-sm text-gray-500">В КП есть альтернативные варианты. Показана минимальная итоговая цена; позиции выше относятся ко всем вариантам.</p> : null}
      {lead.configuration?.customer_note ? <p className="whitespace-pre-wrap text-sm text-gray-600">{lead.configuration.customer_note}</p> : null}
      <label className="block text-sm font-semibold">Следующий контакт
        <input type="datetime-local" className="mt-2 block min-h-11 w-full min-w-0 rounded-xl border p-3 text-base" value={followUp} onChange={(event) => setFollowUp(event.target.value)} />
      </label>
      <p className="text-xs text-gray-500">Когда срок наступит, заявка будет выделена в списке. Это не отправляет сообщение клиенту.</p>
      <label className="block text-sm font-semibold">Заметка
        <textarea className="mt-2 block w-full rounded-xl border p-3 text-base" rows={3} maxLength={5000} value={note} onChange={(event) => setNote(event.target.value)} placeholder="О чём договорились и когда напомнить о себе" />
      </label>
      <Button type="submit" disabled={saving}>Сохранить</Button>
    </form>
  );
}

export default function Requests() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingId, setSavingId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [deletingLead, setDeletingLead] = useState(null);
  const [company, setCompany] = useState(null);
  const loadSequence = useRef(0);
  const mutationRunning = useRef(false);
  const selectedLead = leads.find((lead) => lead.id === selectedId);

  const load = async (silent = false) => {
    if (mutationRunning.current) return;
    const sequence = ++loadSequence.current;
    if (!silent) {
      setLoading(true);
      setError("");
    }
    try {
      const nextLeads = await fetchCalculatorLeads();
      if (sequence === loadSequence.current) setLeads(nextLeads);
    } catch (requestError) {
      if (sequence === loadSequence.current) setError(extractApiErrorMessage(requestError, "Не удалось загрузить заявки калькулятора."));
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    let active = true;
    void fetchMe().then((me) => { if (active) setCompany(me.workspace); }).catch(() => {});
    const refresh = () => { if (document.visibilityState === "visible") void load(true); };
    const interval = window.setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      ++loadSequence.current;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  const activeCount = useMemo(() => leads.filter((lead) => lead.status !== "done").length, [leads]);

  const changeLead = async (leadId, payload) => {
    mutationRunning.current = true;
    ++loadSequence.current;
    setSavingId(leadId);
    setError("");
    try {
      const saved = await updateCalculatorLead(leadId, payload);
      setLeads((current) => current.map((lead) => lead.id === leadId ? { ...lead, ...saved } : lead));
      if (!Object.hasOwn(payload, "status")) setSelectedId(null);
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось обновить заявку."));
    } finally {
      mutationRunning.current = false;
      setLoading(false);
      setSavingId(null);
    }
  };

  const removeLead = async () => {
    mutationRunning.current = true;
    ++loadSequence.current;
    setSavingId(deletingLead.id);
    setError("");
    try {
      await deleteCalculatorLead(deletingLead.id);
      setLeads((current) => current.filter((lead) => lead.id !== deletingLead.id));
      setDeletingLead(null);
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось удалить заявку."));
    } finally {
      mutationRunning.current = false;
      setLoading(false);
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
          <p className="mt-1 text-sm text-gray-500">КП с контактами из calc.cehcrm.ru и заявки с сайта</p>
          {company ? <p className="mt-1 text-sm font-semibold text-blue-700">Компания: {company.name} · ID {company.id}</p> : null}
          <p className="mt-1 text-xs text-gray-500">Новые заявки появляются автоматически, проверка каждые 15 секунд.</p>
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
                    <td className="py-4 pr-4 text-gray-500">{formatDate(lead.created_at)}
                      {lead.follow_up_at && lead.status !== "done" ? <span className={`mt-2 block rounded-lg p-2 text-xs font-semibold ${new Date(lead.follow_up_at) <= new Date() ? "bg-amber-50 text-amber-800" : "bg-blue-50 text-blue-700"}`}>
                        Связаться: {formatDate(lead.follow_up_at)}
                      </span> : null}
                    </td>
                    <td className="py-4 pr-4">
                      <button type="button" className="block text-left font-bold text-blue-700 hover:underline" onClick={() => setSelectedId(lead.id)}>{lead.client_name}</button>
                      {lead.client_phone ? <a className="mt-1 inline-flex items-center gap-1 font-semibold text-blue-600" href={`tel:${lead.client_phone}`}>
                        <Phone size={14} /> {lead.client_phone}
                      </a> : <span className="text-xs text-gray-500">Телефон не указан</span>}
                      {lead.client_email ? <span className="mt-1 block text-xs text-gray-500">{lead.client_email}</span> : null}
                    </td>
                    <td className="py-4 pr-4">
                      <strong className="block text-gray-900">{PRODUCT_LABELS[lead.product] || lead.product}</strong>
                      {lead.quote_number ? <span className="mt-1 block text-xs text-gray-500">КП №{lead.quote_number}</span> : null}
                    </td>
                    <td className="py-4 pr-4 text-base font-black text-gray-900">{lead.configuration?.amount_is_from ? "От " : ""}{formatMoney(lead.amount)}
                      <button type="button" onClick={() => setSelectedId(lead.id)} className="mt-2 block text-sm font-semibold text-blue-600">Открыть заявку</button>
                    </td>
                    <td className="py-4 pr-4">
                      <select
                        aria-label={`Статус заявки ${lead.id}`}
                        className="min-h-10 rounded-xl border border-gray-200 bg-white px-3 font-semibold text-gray-700"
                        disabled={savingId === lead.id}
                        value={lead.status}
                        onChange={(event) => void changeLead(lead.id, { status: event.target.value })}
                      >
                        {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </td>
                    <td className="py-4 text-right">
                      <button type="button" aria-label={`Удалить заявку ${lead.client_name}`} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-rose-600 hover:bg-rose-50" onClick={() => setDeletingLead(lead)}><Trash2 size={18} /></button>
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
      <Modal open={Boolean(selectedLead)} title={selectedLead?.quote_number ? `КП №${selectedLead.quote_number}` : "Заявка"} onClose={() => { if (!savingId) setSelectedId(null); }}>
        {error ? <p role="alert" className="mb-3 text-rose-600">{error}</p> : null}
        {selectedLead ? <LeadDetails key={selectedLead.id} lead={selectedLead} saving={savingId === selectedLead.id} onSave={(payload) => changeLead(selectedLead.id, payload)} /> : null}
      </Modal>
      <Modal open={Boolean(deletingLead)} title="Удалить заявку?" onClose={() => { if (!savingId) setDeletingLead(null); }} widthClassName="max-w-lg">
        <p className="mb-4">Заявка «{deletingLead?.client_name}», контакты в ней и связанное КП будут удалены из серверного архива калькулятора. Существующие клиенты и проекты CRM не изменятся. Отменить удаление нельзя.</p>
        {error ? <p role="alert" className="mb-3 text-rose-600">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={Boolean(savingId)} onClick={() => setDeletingLead(null)}>Отмена</Button>
          <Button disabled={Boolean(savingId)} onClick={() => void removeLead()}>Удалить</Button>
        </div>
      </Modal>
    </div>
  );
}
