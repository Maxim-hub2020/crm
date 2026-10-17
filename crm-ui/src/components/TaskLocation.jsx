import React from "react";
import { Input, Label } from "./ui.jsx";

export const TASK_DISTRICTS = ["Западный", "Северный", "Центр", "Сельмаш", "Береговая"];

export function TaskLocationFields({ value, onChange }) {
  return <>
    <div className="space-y-2"><Label>Дата выполнения</Label><Input aria-label="Дата выполнения" type="date" value={value.scheduled_date || ""} onChange={e => onChange({ scheduled_date: e.target.value })} /></div>
    <div className="space-y-2"><Label>Город выполнения</Label><Input aria-label="Город выполнения" value={value.city || ""} onChange={e => onChange({ city: e.target.value })} placeholder="Ростов-на-Дону, Аксай, Батайск…" /></div>
    <div className="space-y-2"><Label>Район / направление</Label><Input aria-label="Район / направление" list="task-district-options" value={value.district || ""} onChange={e => onChange({ district: e.target.value })} placeholder="Выберите или введите район" /><datalist id="task-district-options">{TASK_DISTRICTS.map(d => <option key={d} value={d} />)}</datalist></div>
    <div className="space-y-2"><Label>Адрес выполнения</Label><Input aria-label="Адрес выполнения" value={value.address || ""} onChange={e => onChange({ address: e.target.value })} placeholder="Улица, дом, магазин или объект" /></div>
  </>;
}

export function TaskLocation({ task }) {
  const place = [task.city, task.district, task.address].filter(Boolean).join(" · ");
  return <>
    {place && <div className="mt-2 break-words text-sm text-slate-600">{place}</div>}
    {task.scheduled_date && <div className="mt-1 text-xs font-semibold text-blue-600">Выполнение: {new Date(`${task.scheduled_date}T12:00:00`).toLocaleDateString("ru-RU")}</div>}
  </>;
}
