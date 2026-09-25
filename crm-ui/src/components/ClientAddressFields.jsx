import React, { useEffect, useRef, useState } from "react";

import { fetchAddressSuggestions, hasDadataAddressSuggestions } from "../api";
import { Input, Label } from "./ui.jsx";

export default function ClientAddressFields({
  form,
  setForm,
  addressLabel = "Адрес",
  addressPlaceholder = "Начните вводить адрес",
}) {
  const selectedAddressValueRef = useRef(String(form.address || "").trim());
  const [addressOpen, setAddressOpen] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [suggestError, setSuggestError] = useState("");

  useEffect(() => {
    if (!addressOpen) {
      selectedAddressValueRef.current = String(form.address || "").trim();
    }
  }, [addressOpen, form.address]);

  useEffect(() => {
    if (!addressOpen || !hasDadataAddressSuggestions()) {
      setSuggestions([]);
      setLoading(false);
      setSuggestError("");
      return;
    }

    const query = String(form.address || "").trim();
    if (query.length < 3 || query === selectedAddressValueRef.current) {
      setSuggestions([]);
      setLoading(false);
      setSuggestError("");
      return;
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
      } catch (requestError) {
        if (!cancelled) {
          setSuggestError(requestError?.message || "Не удалось загрузить подсказки Dadata.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [addressOpen, form.address]);

  function applySuggestion(suggestion) {
    const selectedAddress = suggestion.value || suggestion.unrestrictedValue || form.address;
    selectedAddressValueRef.current = String(selectedAddress || "").trim();
    setForm((prev) => ({
      ...prev,
      address: selectedAddress || prev.address,
      address_lat: suggestion.lat || "",
      address_lon: suggestion.lon || "",
      apartment: suggestion.apartment || prev.apartment,
      floor: suggestion.floor || prev.floor,
    }));
    setSuggestions([]);
    setLoading(false);
    setSuggestError("");
  }

  return (
    <div className="space-y-3 sm:col-span-2">
      <div className="space-y-2">
        <Label>{addressLabel}</Label>
        <Input
          value={form.address}
          onFocus={() => setAddressOpen(true)}
          onClick={() => setAddressOpen(true)}
          onChange={(event) => {
            selectedAddressValueRef.current = "";
            setForm((prev) => ({
              ...prev,
              address: event.target.value,
              address_lat: "",
              address_lon: "",
            }));
          }}
          placeholder={addressPlaceholder}
        />
      </div>

      {addressOpen && (loading || suggestions.length > 0 || suggestError) ? (
        <div className="space-y-2 rounded-[22px] border border-slate-200 bg-white p-3 shadow-[0_16px_34px_rgba(15,23,42,0.08)]">
          {loading ? (
            <div className="rounded-2xl bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-400">Ищем адрес...</div>
          ) : null}
          {suggestions.length > 0 ? (
            <div className="space-y-2">
              {suggestions.map((suggestion) => (
                <button
                  key={`${suggestion.value}-${suggestion.lat}-${suggestion.lon}`}
                  type="button"
                  className="w-full rounded-2xl bg-slate-50 px-3 py-2 text-left text-sm font-semibold text-slate-700 transition hover:bg-blue-50 hover:text-blue-700"
                  onClick={() => applySuggestion(suggestion)}
                >
                  {suggestion.value}
                </button>
              ))}
            </div>
          ) : null}
          {suggestError ? (
            <div className="rounded-2xl bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-500">{suggestError}</div>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Квартира</Label>
          <Input
            value={form.apartment}
            onChange={(event) => setForm((prev) => ({ ...prev, apartment: event.target.value }))}
            placeholder="12"
          />
        </div>
        <div className="space-y-2">
          <Label>Этаж</Label>
          <Input
            value={form.floor}
            onChange={(event) => setForm((prev) => ({ ...prev, floor: event.target.value }))}
            placeholder="7"
          />
        </div>
      </div>
    </div>
  );
}
