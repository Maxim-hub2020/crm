import { Input, Label } from "./ui.jsx";

const fields = [
  ["name", "Наименование организации", 250],
  ["inn", "ИНН", 10, true],
  ["kpp", "КПП", 9, true],
  ["ogrn", "ОГРН", 13, true],
  ["address", "Юридический адрес", 350],
  ["signatory", "ФИО подписанта", 150],
  ["position", "Должность подписанта", 100],
  ["bank", "Банк", 150],
  ["bik", "БИК", 9, true],
  ["account", "Расчётный счёт", 20, true],
  ["correspondent_account", "Корреспондентский счёт", 20, true],
];

export default function ClientContractFields({ form, setForm }) {
  return (
    <div className="space-y-3 sm:col-span-2">
      <label className="flex items-center gap-2 text-sm font-semibold text-slate-600">
        <input
          type="checkbox"
          checked={form.is_legal_entity}
          onChange={(event) => setForm((prev) => ({ ...prev, is_legal_entity: event.target.checked }))}
        />
        Договор на юридическое лицо
      </label>
      {form.is_legal_entity ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map(([key, label, maxLength, numeric]) => (
            <label key={key} className={key === "name" || key === "address" ? "block space-y-2 sm:col-span-2" : "block space-y-2"}>
              <span className="block text-sm font-semibold text-slate-600">{label}</span>
              <Input
                value={form.legal_details?.[key] || ""}
                maxLength={maxLength}
                inputMode={numeric ? "numeric" : undefined}
                onChange={(event) => {
                  const value = numeric ? event.target.value.replace(/\D/g, "") : event.target.value;
                  setForm((prev) => ({ ...prev, legal_details: { ...prev.legal_details, [key]: value } }));
                }}
              />
            </label>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          <Label>ФИО для договора и акта</Label>
          <Input
            value={form.contract_full_name}
            onChange={(event) => setForm((prev) => ({ ...prev, contract_full_name: event.target.value }))}
            placeholder="Иванов Иван Иванович"
            autoComplete="name"
          />
        </div>
      )}
    </div>
  );
}
