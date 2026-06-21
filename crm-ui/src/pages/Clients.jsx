import React, { useEffect, useMemo, useState } from "react";
import { ChevronRight, Edit3, Gift, Mail, MapPin, Phone, Plus, Search, Ticket, Trash2, Wallet } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { createClient, deleteClient, extractApiErrorMessage, fetchClients, fetchPayments, fetchProjects, updateClient } from "../api";
import { Badge, Button, Input, Label, Modal } from "../components/ui.jsx";
import { clientPhoneValidationError, normalizeOptionalClientPhone } from "../utils/phone.js";

const moneyFormatter = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

function formatMoney(value) {
  return moneyFormatter.format(Number(value || 0));
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

function isFuturePayment(payment) {
  return toDateInputValue(payment?.paid_at) > todayDateValue();
}

function paymentSignedAmount(payment) {
  if (isFuturePayment(payment)) return 0;
  const amount = Number(payment?.amount || 0);
  if (payment?.category_type === "expense") return -amount;
  if (payment?.category_type === "income") return amount;
  return payment?.type === "refund" || payment?.type === "correction" ? -amount : amount;
}

function createClientEditForm(client = {}) {
  return {
    name: client.name || "",
    phone: client.phone || "",
    email: client.email || "",
    address: client.address || "",
    works_with_contract: Boolean(client.worksWithContract ?? client.works_with_contract),
  };
}

function InfoRow({ icon: Icon, label, value, href }) {
  const content = (
    <>
      <Icon size={16} className="shrink-0 text-slate-400" />
      <div className="min-w-0">
        <div className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">{label}</div>
        <div className="mt-1 truncate text-sm font-semibold text-slate-800">{value || "Не указано"}</div>
      </div>
    </>
  );

  if (href && value) {
    return (
      <a className="flex items-center gap-3 rounded-2xl bg-slate-50 px-4 py-3 transition hover:bg-blue-50" href={href}>
        {content}
      </a>
    );
  }

  return <div className="flex items-center gap-3 rounded-2xl bg-slate-50 px-4 py-3">{content}</div>;
}

export default function Clients() {
  const navigate = useNavigate();
  const [clientRows, setClientRows] = useState([]);
  const [projects, setProjects] = useState([]);
  const [payments, setPayments] = useState([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [selectedClientId, setSelectedClientId] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState(createClientEditForm());
  const [creatingClient, setCreatingClient] = useState(false);
  const [editForm, setEditForm] = useState(createClientEditForm());
  const [savingClient, setSavingClient] = useState(false);
  const [deletingClient, setDeletingClient] = useState(false);
  const [clientEditMode, setClientEditMode] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [clientsData, projectRows, paymentRows] = await Promise.all([fetchClients(), fetchProjects(), fetchPayments()]);
        setClientRows(clientsData);
        setProjects(projectRows);
        setPayments(paymentRows);
      } catch {
        setClientRows([]);
        setProjects([]);
        setPayments([]);
      }
    })();
  }, []);

  const clients = useMemo(() => {
    const projectsByClient = new Map();
    for (const project of projects) {
      const clientId = project.client || project.client_info?.id;
      if (!clientId) continue;
      if (!projectsByClient.has(clientId)) {
        projectsByClient.set(clientId, []);
      }
      projectsByClient.get(clientId).push(project);
    }

    return clientRows
      .map((client) => {
        const clientProjects = projectsByClient.get(client.id) || [];
        const projectIds = new Set(clientProjects.map((project) => project.id));
        const projectPayments = payments.filter((payment) => projectIds.has(payment.project));
        const total = projectPayments.reduce((sum, payment) => sum + paymentSignedAmount(payment), 0);
        return {
          id: client.id,
          name: client.name,
          phone: client.phone,
          email: client.email,
          address: client.address,
          projects: clientProjects,
          projectCount: clientProjects.length || client.project_count || 0,
          worksWithContract: Boolean(client.works_with_contract),
          bonusBalance: Number(client.bonus_balance || 0),
          promoCode: client.promo_code || "",
          paymentsCount: projectPayments.length,
          total,
        };
      })
      .sort((left, right) => (left.name || "").localeCompare(right.name || "", "ru"));
  }, [clientRows, payments, projects]);

  const filteredClients = useMemo(() => {
    const value = search.trim().toLowerCase();
    if (!value) return clients;

    return clients.filter((client) =>
      [client.name, client.phone, client.email, client.address].filter(Boolean).some((field) => field.toLowerCase().includes(value))
    );
  }, [clients, search]);

  const selectedClient = useMemo(
    () => clients.find((client) => client.id === selectedClientId) || null,
    [clients, selectedClientId]
  );

  function openClientCard(client) {
    setSelectedClientId(client.id);
    setEditForm(createClientEditForm(client));
    setClientEditMode(false);
    setError("");
  }

  function closeClientCard() {
    if (savingClient || deletingClient) return;
    setSelectedClientId(null);
    setClientEditMode(false);
  }

  function openClientCreate() {
    setCreateForm(createClientEditForm());
    setCreateOpen(true);
    setError("");
  }

  function closeClientCreate() {
    if (creatingClient) return;
    setCreateOpen(false);
    setCreateForm(createClientEditForm());
    setError("");
  }

  function startClientEdit() {
    if (!selectedClient) return;
    setEditForm(createClientEditForm(selectedClient));
    setClientEditMode(true);
  }

  async function saveClient(event) {
    event.preventDefault();
    if (!selectedClient) return;

    setSavingClient(true);
    setError("");
    try {
      const phoneError = clientPhoneValidationError(editForm.phone);
      if (phoneError) {
        setError(phoneError);
        return;
      }

      const updated = await updateClient(selectedClient.id, {
        name: editForm.name.trim(),
        phone: normalizeOptionalClientPhone(editForm.phone),
        email: editForm.email.trim() || null,
        address: editForm.address.trim() || null,
        works_with_contract: editForm.works_with_contract,
      });
      setClientRows((current) => current.map((row) => (row.id === updated.id ? updated : row)));
      setSelectedClientId(updated.id);
      setEditForm(createClientEditForm(updated));
      setClientEditMode(false);
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось сохранить клиента."));
    } finally {
      setSavingClient(false);
    }
  }

  async function handleDeleteClient() {
    if (!selectedClient) return;
    const confirmed = window.confirm(
      "Удалить клиента? Связанные проекты останутся в CRM, но будут отвязаны от карточки клиента."
    );
    if (!confirmed) return;

    setDeletingClient(true);
    setError("");
    try {
      await deleteClient(selectedClient.id);
      setClientRows((current) => current.filter((row) => row.id !== selectedClient.id));
      setProjects((current) =>
        current.map((project) => {
          const projectClientId = project.client || project.client_info?.id;
          if (projectClientId !== selectedClient.id) return project;
          return { ...project, client: null, client_info: null };
        })
      );
      setSelectedClientId(null);
      setClientEditMode(false);
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось удалить клиента."));
    } finally {
      setDeletingClient(false);
    }
  }

  async function submitCreateClient(event) {
    event.preventDefault();

    setCreatingClient(true);
    setError("");
    try {
      if (!createForm.name.trim()) {
        setError("Укажите имя клиента.");
        return;
      }
      const phoneError = clientPhoneValidationError(createForm.phone);
      if (phoneError) {
        setError(phoneError);
        return;
      }

      const created = await createClient({
        name: createForm.name.trim(),
        phone: normalizeOptionalClientPhone(createForm.phone),
        email: createForm.email.trim() || null,
        address: createForm.address.trim() || null,
        works_with_contract: createForm.works_with_contract,
      });

      setClientRows((current) => {
        const exists = current.some((row) => row.id === created.id);
        return exists ? current.map((row) => (row.id === created.id ? created : row)) : [created, ...current];
      });
      setCreateOpen(false);
      setCreateForm(createClientEditForm());
      setSelectedClientId(created.id);
      setEditForm(createClientEditForm(created));
      setClientEditMode(false);
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось создать клиента."));
    } finally {
      setCreatingClient(false);
    }
  }

  return (
    <div>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Input
            className="h-12 rounded-[18px] pl-10"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Поиск клиентов..."
          />
          <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400" />
        </div>

        <Button type="button" className="w-full justify-center sm:w-auto" onClick={openClientCreate}>
          <Plus size={16} />
          Добавить клиента
        </Button>
      </div>

      {error && <div className="mb-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="space-y-2">
        {filteredClients.map((client) => (
          <button
            key={client.id}
            type="button"
            className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-2xl bg-white px-4 py-3 text-left shadow-sm ring-1 ring-slate-100 transition hover:-translate-y-0.5 hover:bg-gray-50 hover:shadow-md md:grid-cols-[minmax(0,1fr)_190px_110px_32px]"
            onClick={() => openClientCard(client)}
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-black text-slate-900">{client.name || "Без имени"}</div>
              <div className="mt-1 flex flex-wrap gap-2">
                <Badge>{client.projectCount} проект(ов)</Badge>
                <Badge className="bg-blue-50 text-blue-700">Бонусы {formatMoney(client.bonusBalance)} ₽</Badge>
                {client.worksWithContract && <Badge className="bg-blue-100 text-blue-700">Договор</Badge>}
              </div>
            </div>

            <div className="hidden items-center gap-2 text-sm font-semibold text-slate-500 md:flex">
              <Phone size={15} />
              <span className="truncate">{client.phone || "Телефон не указан"}</span>
            </div>

            <div className="hidden text-right text-sm font-black text-slate-800 md:block">{formatMoney(client.total)} ₽</div>

            <ChevronRight className="text-slate-300" size={20} />
          </button>
        ))}

        {filteredClients.length === 0 && (
          <div className="rounded-[32px] bg-white p-10 text-center text-gray-400 shadow-lg">
            Клиенты не найдены.
          </div>
        )}
      </div>

      <Modal
        open={Boolean(selectedClient)}
        title={selectedClient ? selectedClient.name || "Клиент без имени" : "Клиент"}
        onClose={closeClientCard}
        widthClassName="max-w-4xl"
      >
        {selectedClient && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-4">
              {!clientEditMode ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap gap-2">
                      <Badge>{selectedClient.projectCount} проект(ов)</Badge>
                      <Badge>{selectedClient.paymentsCount} операция(й)</Badge>
                      <Badge className="bg-blue-100 text-blue-700">Бонусы {formatMoney(selectedClient.bonusBalance)} ₽</Badge>
                      {selectedClient.worksWithContract ? <Badge className="bg-blue-100 text-blue-700">Работает по договору</Badge> : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="secondary" disabled={deletingClient} onClick={startClientEdit}>
                        <Edit3 size={16} />
                        Редактировать
                      </Button>
                      <Button type="button" variant="danger" disabled={deletingClient} onClick={handleDeleteClient}>
                        <Trash2 size={16} />
                        {deletingClient ? "Удаляем..." : "Удалить"}
                      </Button>
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <InfoRow icon={Phone} label="Телефон" value={selectedClient.phone} href={selectedClient.phone ? `tel:${selectedClient.phone}` : ""} />
                    <InfoRow icon={Mail} label="Email" value={selectedClient.email} href={selectedClient.email ? `mailto:${selectedClient.email}` : ""} />
                    <InfoRow icon={Gift} label="Бонусный счёт" value={`${formatMoney(selectedClient.bonusBalance)} ₽`} />
                    <InfoRow icon={Ticket} label="Промокод" value={selectedClient.promoCode || "Недоступен без телефона"} />
                    <div className="md:col-span-2">
                      <InfoRow icon={MapPin} label="Адрес" value={selectedClient.address} />
                    </div>
                    <InfoRow icon={Wallet} label="Финансы по проектам" value={`${formatMoney(selectedClient.total)} ₽`} />
                  </div>
                </>
              ) : (
                <form className="space-y-4" onSubmit={saveClient}>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2 md:col-span-2">
                      <Label>Имя клиента</Label>
                      <Input value={editForm.name} onChange={(event) => setEditForm((prev) => ({ ...prev, name: event.target.value }))} />
                    </div>
                    <div className="space-y-2">
                      <Label>Телефон</Label>
                      <Input
                        type="tel"
                        inputMode="numeric"
                        autoComplete="tel"
                        value={editForm.phone}
                        onChange={(event) => setEditForm((prev) => ({ ...prev, phone: event.target.value }))}
                        placeholder="+7..."
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Email</Label>
                      <Input value={editForm.email} onChange={(event) => setEditForm((prev) => ({ ...prev, email: event.target.value }))} />
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <Label>Адрес</Label>
                      <Input value={editForm.address} onChange={(event) => setEditForm((prev) => ({ ...prev, address: event.target.value }))} />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 rounded-2xl bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-600">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-gray-300 text-blue-600"
                      checked={editForm.works_with_contract}
                      onChange={(event) => setEditForm((prev) => ({ ...prev, works_with_contract: event.target.checked }))}
                    />
                    Работает по договору
                  </label>
                  <div className="flex justify-end gap-3">
                    <Button type="button" variant="secondary" disabled={savingClient} onClick={() => setClientEditMode(false)}>
                      Отмена
                    </Button>
                    <Button type="submit" disabled={savingClient}>
                      {savingClient ? "Сохраняем..." : "Сохранить клиента"}
                    </Button>
                  </div>
                </form>
              )}
            </div>

            <div className="space-y-3">
              <div className="text-[11px] font-black uppercase tracking-[0.22em] text-slate-400">Проекты клиента</div>
              {selectedClient.projects.length > 0 ? (
                selectedClient.projects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    className="w-full rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3 text-left transition hover:border-blue-200 hover:bg-blue-50"
                    onClick={() => navigate("/projects", { state: { q: project.title || project.client_name } })}
                  >
                    <div className="font-black text-slate-900">{project.title || project.client_name || `Проект #${project.id}`}</div>
                    <div className="mt-1 line-clamp-1 text-sm text-slate-500">{project.object_address || "Адрес не указан"}</div>
                  </button>
                ))
              ) : (
                <div className="rounded-2xl bg-slate-50 px-4 py-5 text-sm text-slate-400">Проектов пока нет.</div>
              )}
            </div>
          </div>
        )}
      </Modal>

      <Modal open={createOpen} title="Добавить клиента" onClose={closeClientCreate} widthClassName="max-w-2xl">
        <form className="space-y-4" onSubmit={submitCreateClient}>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <Label>Имя клиента</Label>
              <Input
                value={createForm.name}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="Например: Алексей"
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Телефон</Label>
              <Input
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                value={createForm.phone}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, phone: event.target.value }))}
                placeholder="+7..."
              />
            </div>
            <div className="space-y-2">
              <Label>Email</Label>
              <Input
                type="email"
                value={createForm.email}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, email: event.target.value }))}
                placeholder="client@example.com"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>Адрес</Label>
              <Input
                value={createForm.address}
                onChange={(event) => setCreateForm((prev) => ({ ...prev, address: event.target.value }))}
                placeholder="Адрес клиента"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 rounded-2xl bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-600">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-gray-300 text-blue-600"
              checked={createForm.works_with_contract}
              onChange={(event) => setCreateForm((prev) => ({ ...prev, works_with_contract: event.target.checked }))}
            />
            Работает по договору
          </label>

          {error && <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

          <div className="flex justify-end gap-3">
            <Button type="button" variant="secondary" disabled={creatingClient} onClick={closeClientCreate}>
              Отмена
            </Button>
            <Button type="submit" disabled={creatingClient}>
              {creatingClient ? "Создаём..." : "Создать клиента"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
