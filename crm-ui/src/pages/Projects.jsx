import React, { useEffect, useMemo, useState } from "react";
import { Card, CardHeader, CardBody, Button, Input, Modal, Select, Badge } from "../components/ui";
import { createProject, fetchProjects, createPayment, fetchPayments } from "../api";

const CAT_OPTIONS = [
  { value: "mirrors", label: "Зеркала" },
  { value: "furniture", label: "Мебель" },
  { value: "shower", label: "Душевые" },
];

function categoriesToBadges(csv) {
  const set = new Set((csv || "").split(",").map((s) => s.trim()).filter(Boolean));
  return CAT_OPTIONS.filter((x) => set.has(x.value)).map((x) => x.label);
}

export default function Projects() {
  const [projects, setProjects] = useState([]);
  const [payments, setPayments] = useState([]);
  const [q, setQ] = useState("");

  const [openCreate, setOpenCreate] = useState(false);
  const [openPay, setOpenPay] = useState(false);
  const [activeProject, setActiveProject] = useState(null);

  const [form, setForm] = useState({
    client_name: "",
    client_phone: "",
    client_email: "",
    object_address: "",
    description: "",
    categories: "mirrors",
  });

  const [payForm, setPayForm] = useState({
    amount: "",
    method: "transfer",
    comment: "",
    paid_at: "",
  });

  async function reload() {
    const p = await fetchProjects();
    setProjects(p);
    const pay = await fetchPayments();
    setPayments(pay);
  }

  useEffect(() => {
    reload().catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return projects;
    return projects.filter((p) =>
      [p.client_name, p.client_phone, p.object_address].some((x) => (x || "").toLowerCase().includes(s))
    );
  }, [projects, q]);

  function openAddAdvance(p) {
    setActiveProject(p);
    setPayForm({ amount: "", method: "transfer", comment: "", paid_at: "" });
    setOpenPay(true);
  }

  async function submitCreate(e) {
    e.preventDefault();
    await createProject(form);
    setOpenCreate(false);
    setForm({
      client_name: "",
      client_phone: "",
      client_email: "",
      object_address: "",
      description: "",
      categories: "mirrors",
    });
    await reload();
  }

  async function submitAdvance(e) {
    e.preventDefault();
    await createPayment({
      project: activeProject.id,
      type: "advance",
      amount: payForm.amount,
      method: payForm.method,
      comment: payForm.comment,
      paid_at: payForm.paid_at || undefined,
    });
    setOpenPay(false);
    await reload();
  }

  function projectPayments(projectId) {
    return payments
      .filter((x) => x.project === projectId)
      .sort((a, b) => (b.paid_at || "").localeCompare(a.paid_at || ""));
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-sm text-zinc-500">Проекты</div>
          <div className="text-2xl font-semibold">Список проектов</div>
        </div>
        <div className="flex w-full gap-3 md:w-auto">
          <div className="w-full md:w-80">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск: телефон, имя, адрес…" />
          </div>
          <Button onClick={() => setOpenCreate(true)}>+ Новый проект</Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="font-semibold">Проекты</div>
          <div className="text-sm text-zinc-500">Добавьте аванс — комиссия начислится автоматически</div>
        </CardHeader>
        <CardBody>
          <div className="space-y-3">
            {filtered.map((p) => {
              const badges = categoriesToBadges(p.categories);
              const pays = projectPayments(p.id);
              const lastPay = pays[0];

              return (
                <div key={p.id} className="rounded-2xl border border-zinc-200 bg-white p-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="space-y-1">
                      <div className="text-base font-semibold">{p.client_name}</div>
                      <div className="text-sm text-zinc-600">{p.client_phone}</div>
                      {p.object_address && <div className="text-sm text-zinc-500">{p.object_address}</div>}
                      <div className="mt-2 flex flex-wrap gap-2">
                        {badges.map((b) => (
                          <Badge key={b}>{b}</Badge>
                        ))}
                        <Badge>{p.status}</Badge>
                      </div>
                    </div>

                    <div className="flex flex-col items-start gap-2 md:items-end">
                      <Button onClick={() => openAddAdvance(p)}>Добавить аванс</Button>
                      {lastPay && (
                        <div className="text-xs text-zinc-500">
                          Последний платёж: {Number(lastPay.amount).toFixed(2)} • {String(lastPay.type)}
                        </div>
                      )}
                    </div>
                  </div>

                  {p.description && <div className="mt-3 text-sm text-zinc-700">{p.description}</div>}

                  {pays.length > 0 && (
                    <div className="mt-4 overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="text-left text-zinc-500">
                          <tr>
                            <th className="py-2">Дата</th>
                            <th className="py-2">Тип</th>
                            <th className="py-2">Сумма</th>
                            <th className="py-2">Способ</th>
                            <th className="py-2">Комментарий</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pays.map((x) => (
                            <tr key={x.id} className="border-t border-zinc-100">
                              <td className="py-2">{(x.paid_at || "").slice(0, 10)}</td>
                              <td className="py-2">{x.type}</td>
                              <td className="py-2">{Number(x.amount).toFixed(2)}</td>
                              <td className="py-2">{x.method}</td>
                              <td className="py-2">{x.comment}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}

            {filtered.length === 0 && (
              <div className="rounded-2xl border border-zinc-200 bg-white p-10 text-center text-zinc-500">
                Проекты не найдены
              </div>
            )}
          </div>
        </CardBody>
      </Card>

      <Modal open={openCreate} title="Новый проект" onClose={() => setOpenCreate(false)}>
        <form className="space-y-4" onSubmit={submitCreate}>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <div className="mb-2 text-sm text-zinc-600">Клиент</div>
              <Input value={form.client_name} onChange={(e) => setForm({ ...form, client_name: e.target.value })} />
            </div>
            <div>
              <div className="mb-2 text-sm text-zinc-600">Телефон</div>
              <Input value={form.client_phone} onChange={(e) => setForm({ ...form, client_phone: e.target.value })} />
            </div>
            <div>
              <div className="mb-2 text-sm text-zinc-600">Email</div>
              <Input value={form.client_email} onChange={(e) => setForm({ ...form, client_email: e.target.value })} />
            </div>
            <div>
              <div className="mb-2 text-sm text-zinc-600">Адрес</div>
              <Input value={form.object_address} onChange={(e) => setForm({ ...form, object_address: e.target.value })} />
            </div>
          </div>

          <div>
            <div className="mb-2 text-sm text-zinc-600">Категория</div>
            <Select value={form.categories} onChange={(e) => setForm({ ...form, categories: e.target.value })}>
              {CAT_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
            <div className="mt-2 text-xs text-zinc-500">Можно расширить до мультивыбора позже.</div>
          </div>

          <div>
            <div className="mb-2 text-sm text-zinc-600">Описание / ТЗ</div>
            <textarea
              className="min-h-24 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-900/20"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpenCreate(false)}>
              Отмена
            </Button>
            <Button type="submit">Создать</Button>
          </div>
        </form>
      </Modal>

      <Modal open={openPay} title={`Аванс — ${activeProject?.client_name || ""}`} onClose={() => setOpenPay(false)}>
        <form className="space-y-4" onSubmit={submitAdvance}>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <div className="mb-2 text-sm text-zinc-600">Сумма аванса</div>
              <Input
                value={payForm.amount}
                onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })}
                placeholder="Напр. 25000"
              />
            </div>
            <div>
              <div className="mb-2 text-sm text-zinc-600">Способ оплаты</div>
              <Select value={payForm.method} onChange={(e) => setPayForm({ ...payForm, method: e.target.value })}>
                <option value="transfer">Перевод</option>
                <option value="cash">Наличные</option>
                <option value="card">Карта</option>
                <option value="other">Другое</option>
              </Select>
            </div>
          </div>

          <div>
            <div className="mb-2 text-sm text-zinc-600">Дата поступления (опционально)</div>
            <Input
              value={payForm.paid_at}
              onChange={(e) => setPayForm({ ...payForm, paid_at: e.target.value })}
              placeholder="2026-01-04T12:00:00+02:00"
            />
            <div className="mt-2 text-xs text-zinc-500">Если пусто — будет “сейчас”.</div>
          </div>

          <div>
            <div className="mb-2 text-sm text-zinc-600">Комментарий</div>
            <Input
              value={payForm.comment}
              onChange={(e) => setPayForm({ ...payForm, comment: e.target.value })}
              placeholder="Напр. предоплата по договору"
            />
          </div>

          <div className="rounded-xl bg-zinc-50 p-3 text-xs text-zinc-600">
            Комиссия начислится автоматически: 5% (1–3 продажи), с 4-й продажи — 8%.
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpenPay(false)}>
              Отмена
            </Button>
            <Button type="submit">Сохранить аванс</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
