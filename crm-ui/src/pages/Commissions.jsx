import React, { useEffect, useMemo, useState } from "react";
import { Card, CardHeader, CardBody, Select, Badge } from "../components/ui";
import { fetchCommissions } from "../api";
import { monthStartISO, monthLabel } from "../utils/month";

export default function Commissions() {
  const [period, setPeriod] = useState(monthStartISO(new Date()));
  const [rows, setRows] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const c = await fetchCommissions();
        setRows(c);
      } catch {
        setRows([]);
      }
    })();
  }, []);

  const filtered = useMemo(
    () => rows.filter((x) => x.period_month === period && x.status !== "canceled"),
    [rows, period]
  );

  const totals = useMemo(() => {
    const accrued = filtered.reduce((s, r) => s + Number(r.commission_amount), 0);
    const base = filtered.reduce((s, r) => s + Number(r.base_amount), 0);
    return { accrued, base };
  }, [filtered]);

  const now = new Date();
  const months = [];
  for (let i = 0; i < 12; i++) months.push(monthStartISO(new Date(now.getFullYear(), now.getMonth() - i, 1)));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-sm text-zinc-500">Начисления</div>
          <div className="text-2xl font-semibold">Комиссии за {monthLabel(period)}</div>
        </div>
        <div className="w-full md:w-64">
          <div className="mb-2 text-sm text-zinc-600">Период</div>
          <Select value={period} onChange={(e) => setPeriod(e.target.value)}>
            {months.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6">
        <Card className="col-span-12 md:col-span-4">
          <CardHeader>
            <div className="font-semibold">Итого</div>
            <div className="text-sm text-zinc-500">Сводка по выбранному месяцу</div>
          </CardHeader>
          <CardBody className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-sm text-zinc-600">База (авансы)</div>
              <div className="font-semibold">{totals.base.toFixed(2)}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-sm text-zinc-600">Начислено</div>
              <div className="font-semibold">{totals.accrued.toFixed(2)}</div>
            </div>
            <div className="text-xs text-zinc-500">Ставка: 5% (1–3 продажи), 8% (с 4-й продажи).</div>
          </CardBody>
        </Card>

        <Card className="col-span-12 md:col-span-8">
          <CardHeader>
            <div className="font-semibold">Список начислений</div>
            <div className="text-sm text-zinc-500">Каждый аванс создаёт начисление автоматически</div>
          </CardHeader>
          <CardBody>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-zinc-500">
                  <tr>
                    <th className="py-2">Дата</th>
                    <th className="py-2">Проект</th>
                    <th className="py-2">База</th>
                    <th className="py-2">Ставка</th>
                    <th className="py-2">Комиссия</th>
                    <th className="py-2">Продажа №</th>
                    <th className="py-2">Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.id} className="border-t border-zinc-100">
                      <td className="py-3">{(r.created_at || "").slice(0, 10)}</td>
                      <td className="py-3">{r.project}</td>
                      <td className="py-3">{Number(r.base_amount).toFixed(2)}</td>
                      <td className="py-3">{(Number(r.rate) * 100).toFixed(0)}%</td>
                      <td className="py-3 font-semibold">{Number(r.commission_amount).toFixed(2)}</td>
                      <td className="py-3">{r.sale_number_in_month || "—"}</td>
                      <td className="py-3">
                        <Badge>{r.status}</Badge>
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td className="py-6 text-zinc-500" colSpan={7}>
                        Нет начислений за этот месяц
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
