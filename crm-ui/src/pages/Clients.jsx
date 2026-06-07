import React, { useEffect, useMemo, useState } from "react";
import { ChevronRight, Mail, MapPin, Phone, Search, Wallet } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { extractApiErrorMessage, fetchClients, fetchPayments, fetchProjects, updateClient } from "../api";
import { Badge, Button, Input, Label, Modal } from "../components/ui.jsx";

const moneyFormatter = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function formatMoney(value) {
  return moneyFormatter.format(Number(value || 0));
}

function paymentSignedAmount(payment) {
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

export default function Clients() {
  const navigate = useNavigate();
  const [clientRows, setClientRows] = useState([]);
  const [projects, setProjects] = useState([]);
  const [payments, setPayments] = useState([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [selectedClientId, setSelectedClientId] = useState(null);
  const [editForm, setEditForm] = useState(createClientEditForm());
  const [savingClient, setSavingClient] = useState(false);

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
    setError("");
  }

  async function saveClient(event) {
    event.preventDefault();
    if (!selectedClient) return;

    setSavingClient(true);
    setError("");
    try {
      const updated = await updateClient(selectedClient.id, {
        name: editForm.name.trim(),
        phone: editForm.phone.trim(),
        email: editForm.email.trim() || null,
        address: editForm.address.trim() || null,
        works_with_contract: editForm.works_with_contract,
      });
      setClientRows((current) => current.map((row) => (row.id === updated.id ? updated : row)));
      setSelectedClientId(null);
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось сохранить клиента."));
    } finally {
      setSavingClient(false);
    }
  }

  async function toggleContract(client) {
    setError("");
    try {
      const updated = await updateClient(client.id, {
        works_with_contract: !client.worksWithContract,
      });
      setClientRows((current) => current.map((row) => (row.id === updated.id ? updated : row)));
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось сохранить признак договора."));
    }
  }

  return (
    <div>
      <div className="mb-6 max-w-xs">
        <div className="relative">
          <Input
            className="pl-10"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Поиск клиентов..."
          />
          <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400" />
        </div>
      </div>

      {error && <div className="mb-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="space-y-3">
        {filteredClients.map((client) => (
          <div
            key={client.id}
            className="flex w-full items-center rounded-2xl bg-white p-4 text-left shadow transition-all hover:bg-gray-50 hover:shadow-lg"
          >
            <div className="grid flex-grow grid-cols-1 items-center gap-4 md:grid-cols-4">
              <div>
                <div className="font-bold text-gray-800">{client.name || "Без имени"}</div>
                <div className="mt-1 flex flex-wrap gap-2">
                  <Badge>{client.projectCount} проектов</Badge>
                  <Badge>{client.paymentsCount} платежей</Badge>
                  {client.worksWithContract && <Badge className="bg-blue-100 text-blue-700">Договор</Badge>}
                </div>
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <Phone size={16} />
                {client.phone || "Телефон не указан"}
              </div>
              <div className="min-w-0 space-y-1 text-sm text-gray-500">
                <div className="flex items-center gap-2 truncate">
                  <Mail size={16} className="shrink-0" />
                  <span className="truncate">{client.email || "Email не указан"}</span>
                </div>
                <div className="flex items-center gap-2 truncate">
                  <MapPin size={16} className="shrink-0" />
                  <span className="truncate">{client.address || "Адрес не указан"}</span>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 md:justify-end">
                <label className="flex items-center gap-2 text-xs font-semibold text-gray-500">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-gray-300 text-blue-600"
                    checked={client.worksWithContract}
                    onChange={() => toggleContract(client)}
                  />
                  Договор
                </label>
                <div className="text-right">
                  <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-gray-400">
                    <Wallet size={12} />
                    Сумма
                  </div>
                  <div className="mt-1 font-black text-gray-800">{formatMoney(client.total)} ₽</div>
                </div>
                <button
                  type="button"
                  className="rounded-full p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
                  onClick={() => openClientCard(client)}
                >
                  <ChevronRight />
                </button>
              </div>
            </div>
          </div>
        ))}

        {filteredClients.length === 0 && (
          <div className="rounded-[32px] bg-white p-10 text-center text-gray-400 shadow-lg">
            Клиенты не найдены.
          </div>
        )}
      </div>

      <Modal
        open={Boolean(selectedClient)}
        title={selectedClient ? `Клиент — ${selectedClient.name || "без имени"}` : "Клиент"}
        onClose={() => !savingClient && setSelectedClientId(null)}
        widthClassName="max-w-4xl"
      >
        {selectedClient && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
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
                    value={editForm.phone}
                    onChange={(event) => setEditForm((prev) => ({ ...prev, phone: event.target.value }))}
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
                <Button type="button" variant="secondary" disabled={savingClient} onClick={() => setSelectedClientId(null)}>
                  Отмена
                </Button>
                <Button type="submit" disabled={savingClient}>
                  {savingClient ? "Сохраняем..." : "Сохранить клиента"}
                </Button>
              </div>
            </form>

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
    </div>
  );
}
