import React, { useEffect, useMemo, useState } from "react";
import { Card, CardHeader, CardBody, Select, Badge } from "../components/ui";
import { fetchTop, fetchCommissions, getUser } from "../api";
import { monthStartISO, monthLabel } from "../utils/month";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip } from "recharts";

function MonthPicker({ value, onChange }) {
  const now = new Date();
  const months = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(monthStartISO(d));
  }
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      {months.map((m) => (
        <option key={m} value={m}>
          {monthLabel(m)}
        </option>
      ))}
    </Select>
  );
}

export default function Dashboard() {
  const user = getUser();
  const [period, setPeriod] = useState(monthStartISO(new Date()));
  const [top, setTop] = useState([]);
  const [comm, setComm] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const t = await fetchTop(period);
        setTop(t);
      } catch {
        setTop([]);
      }
    })();
  }, [period]);

  useEffect(() => {
    (async () => {
      try {
        const c = await fetchCommissions();
        setComm(c);
      } catch {
        setComm([]);
      }
    })();
  }, []);

  const myStats = useMemo(() => {
    const rows = comm.filter((x) => x.period_month === period && x.status !== "canceled");
    const accrued = rows.reduce((s, r) => s + Number(r.commission_amount), 0);
    const sales = rows.filter((r) => Number(r.sale_number_in_month) > 0).length;
    const advances = rows.reduce((s, r) => s + Number(r.base_amount), 0);
    return { accrued, sales, advances };
  }, [comm, period]);

  const chartData = useMemo(() => {
    const rows = comm.filter((x) => x.period_month === period && x.status !== "canceled");
    const byDay = new Map();
    for (const r of rows) {
      const day = (r.created_at || "").slice(0, 10) || "—";
      byDay.set(day, (byDay.get(day) || 0) + Number(r.commission_amount));
    }
    return Array.from(byDay.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, value]) => ({ day, value: Number(value.toFixed(2)) }));
  }, [comm, period]);

  const canSeeTop = user?.role === "admin";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-sm text-zinc-500">Дашборд</div>
          <div className="text-2xl font-semibold">Результаты за {monthLabel(period)}</div>
        </div>
        <div className="w-full md:w-64">
          <div className="mb-2 text-sm text-zinc-600">Период</div>
          <MonthPicker value={period} onChange={setPeriod} />
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6">
        <Card className="col-span-12 md:col-span-4">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="font-semibold">Моя статистика</div>
              <Badge>{user?.role === "admin" ? "Админ" : "Менеджер"}</Badge>
            </div>
            <div className="text-sm text-zinc-500">Начисления формируются сразу после аванса</div>
          </CardHeader>
          <CardBody className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm text-zinc-600">Продаж</div>
              <div className="text-lg font-semibold">{myStats.sales}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-sm text-zinc-600">Сумма авансов</div>
              <div className="text-lg font-semibold">{myStats.advances.toFixed(2)}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-sm text-zinc-600">Начислено комиссий</div>
              <div className="text-lg font-semibold">{myStats.accrued.toFixed(2)}</div>
            </div>
            <div className="text-xs text-zinc-500">
              Правило: 1–3 продажи — 5%, с 4-й продажи — 8% (месяц, вариант A).
            </div>
          </CardBody>
        </Card>

        <Card className="col-span-12 md:col-span-8">
          <CardHeader>
            <div className="font-semibold">Начисления по дням</div>
            <div className="text-sm text-zinc-500">Динамика комиссий внутри месяца</div>
          </CardHeader>
          <CardBody>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <XAxis dataKey="day" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="value" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardBody>
        </Card>

        {canSeeTop && (
          <Card className="col-span-12">
            <CardHeader>
              <div className="font-semibold">ТОП менеджеров</div>
              <div className="text-sm text-zinc-500">Сортировка по начисленным комиссиям</div>
            </CardHeader>
            <CardBody>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-zinc-500">
                    <tr>
                      <th className="py-2">#</th>
                      <th className="py-2">Менеджер</th>
                      <th className="py-2">Продажи</th>
                      <th className="py-2">Авансы</th>
                      <th className="py-2">Начислено</th>
                      <th className="py-2">Выплачено</th>
                      <th className="py-2">К выплате</th>
                    </tr>
                  </thead>
                  <tbody>
                    {top.map((r, i) => (
                      <tr key={r.manager_id} className="border-t border-zinc-100">
                        <td className="py-3">{i + 1}</td>
                        <td className="py-3 font-medium">{r.manager}</td>
                        <td className="py-3">{r.sales}</td>
                        <td className="py-3">{r.advance_sum}</td>
                        <td className="py-3">{r.accrued_commission}</td>
                        <td className="py-3">{r.paid_out}</td>
                        <td className="py-3 font-semibold">{r.to_pay}</td>
                      </tr>
                    ))}
                    {top.length === 0 && (
                      <tr>
                        <td className="py-6 text-zinc-500" colSpan={7}>
                          Нет данных за выбранный период
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}
