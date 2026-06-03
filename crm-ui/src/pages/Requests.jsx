import React from "react";
import { BellRing, ShieldQuestion } from "lucide-react";

import { Badge, Card, CardBody, CardHeader } from "../components/ui.jsx";

export default function Requests() {
  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-xl font-black text-gray-800">
          <ShieldQuestion size={20} className="text-blue-500" />
          Запросы
        </h2>
        <Badge>0 активных</Badge>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-lg font-black tracking-tight text-gray-900">Активные запросы</div>
              <div className="mt-1 text-sm text-gray-500">Очередь согласований администратора</div>
            </div>
            <div className="rounded-2xl bg-gray-100 p-3 text-gray-700">
              <BellRing size={18} />
            </div>
          </div>
        </CardHeader>
        <CardBody>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-gray-400">
                <tr>
                  <th className="pb-3 font-black uppercase tracking-widest">Дата</th>
                  <th className="pb-3 font-black uppercase tracking-widest">Тип</th>
                  <th className="pb-3 font-black uppercase tracking-widest">Объект</th>
                  <th className="pb-3 font-black uppercase tracking-widest">Статус</th>
                  <th className="pb-3 text-right font-black uppercase tracking-widest">Действия</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="py-10 text-center text-gray-400" colSpan={5}>
                    Запросов пока нет.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
