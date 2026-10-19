import React, { useEffect, useRef, useState } from "react";

import { fetchAddressSuggestions, hasDadataAddressSuggestions } from "../api";
import { Input, Label } from "./ui.jsx";

export const TASK_DISTRICTS = ["Западный", "Северный", "Центр", "Сельмаш", "Береговая"];

const ROSTOV_ZONE_BY_DISTRICT = [
  ["советск", "Западный"],
  ["железнодорож", "Западный"],
  ["ворошиловск", "Северный"],
  ["октябрьск", "Северный"],
  ["ленинск", "Центр"],
  ["кировск", "Центр"],
  ["первомайск", "Сельмаш"],
  ["пролетарск", "Сельмаш"],
];

function taskZone(suggestion) {
  const address = `${suggestion.street || ""} ${suggestion.value || ""}`.toLocaleLowerCase("ru-RU");
  if (address.includes("береговая")) return "Береговая";

  const city = String(suggestion.city || "").toLocaleLowerCase("ru-RU");
  const district = String(suggestion.cityDistrict || "").toLocaleLowerCase("ru-RU");
  if (city.includes("ростов")) {
    return ROSTOV_ZONE_BY_DISTRICT.find(([marker]) => district.includes(marker))?.[1] || "";
  }
  return suggestion.cityDistrict || "";
}

export function TaskLocationFields({ value, onChange }) {
  const selectedAddressRef = useRef(String(value.address || "").trim());
  const [addressOpen, setAddressOpen] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [suggestError, setSuggestError] = useState("");

  useEffect(() => {
    if (!addressOpen || !hasDadataAddressSuggestions()) {
      setSuggestions([]);
      setLoading(false);
      setSuggestError("");
      return undefined;
    }
    const query = String(value.address || "").trim();
    if (query.length < 3 || query === selectedAddressRef.current) {
      setSuggestions([]);
      setLoading(false);
      setSuggestError("");
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    const timerId = window.setTimeout(async () => {
      try {
        const rows = await fetchAddressSuggestions(query);
        if (!cancelled) {
          setSuggestions(rows);
          setSuggestError(rows.length ? "" : "Адрес не найден. Уточните город, улицу или дом.");
        }
      } catch (error) {
        if (!cancelled) setSuggestError(error?.message || "Не удалось загрузить подсказки DaData.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [addressOpen, value.address]);

  function applySuggestion(suggestion) {
    const address = suggestion.value || value.address || "";
    selectedAddressRef.current = String(address).trim();
    onChange({
      address,
      city: suggestion.city || value.city || "",
      district: taskZone(suggestion) || value.district || "",
    });
    setSuggestions([]);
    setSuggestError("");
    setLoading(false);
    setAddressOpen(false);
  }

  return <>
    <div className="space-y-2"><Label>Дата выполнения</Label><Input aria-label="Дата выполнения" type="date" value={value.scheduled_date || ""} onChange={e => onChange({ scheduled_date: e.target.value })} /></div>
    <div className="space-y-2"><Label>Город выполнения</Label><Input aria-label="Город выполнения" value={value.city || ""} onChange={e => onChange({ city: e.target.value })} placeholder="Ростов-на-Дону, Аксай, Батайск…" /></div>
    <div className="space-y-2"><Label>Район / направление</Label><Input aria-label="Район / направление" list="task-district-options" value={value.district || ""} onChange={e => onChange({ district: e.target.value })} placeholder="Определится по адресу или выберите" /><datalist id="task-district-options">{TASK_DISTRICTS.map(d => <option key={d} value={d} />)}</datalist></div>
    <div className="relative space-y-2 md:col-span-2">
      <Label>Адрес выполнения</Label>
      <Input
        aria-label="Адрес выполнения"
        value={value.address || ""}
        onFocus={() => setAddressOpen(true)}
        onClick={() => setAddressOpen(true)}
        onChange={e => {
          selectedAddressRef.current = "";
          onChange({ address: e.target.value });
        }}
        placeholder="Начните вводить улицу и дом"
      />
      {addressOpen && (loading || suggestions.length > 0 || suggestError) ? <div className="absolute z-20 mt-1 w-full space-y-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-xl">
        {loading ? <div className="px-3 py-2 text-sm font-semibold text-slate-400">Ищем адрес...</div> : null}
        {suggestions.map(suggestion => <button key={`${suggestion.value}-${suggestion.lat}-${suggestion.lon}`} type="button" className="w-full rounded-xl bg-slate-50 px-3 py-2 text-left text-sm font-semibold text-slate-700 hover:bg-blue-50 hover:text-blue-700" onClick={() => applySuggestion(suggestion)}>{suggestion.value}</button>)}
        {suggestError ? <div className="px-3 py-2 text-sm font-semibold text-slate-500">{suggestError}</div> : null}
      </div> : null}
    </div>
  </>;
}

export function TaskLocation({ task }) {
  const place = [task.city, task.district, task.address].filter(Boolean).join(" · ");
  return <>
    {place && <div className="mt-2 break-words text-sm text-slate-600">{place}</div>}
    {task.scheduled_date && <div className="mt-1 text-xs font-semibold text-blue-600">Выполнение: {new Date(`${task.scheduled_date}T12:00:00`).toLocaleDateString("ru-RU")}</div>}
  </>;
}
