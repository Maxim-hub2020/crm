import React, { useState } from "react";
import { Calculator as CalculatorIcon, ExternalLink, LoaderCircle } from "lucide-react";

const CALCULATOR_URL = "https://calc.cehcrm.ru/?embedded=crm";

export default function Calculator() {
  const [loaded, setLoaded] = useState(false);

  return (
    <section className="relative h-full min-h-[520px] overflow-hidden bg-white">
      {!loaded ? (
        <div className="absolute inset-0 z-10 grid place-items-center bg-[#f5f5f7]">
          <div className="rounded-3xl bg-white px-7 py-6 text-center shadow-sm">
            <LoaderCircle className="mx-auto animate-spin text-blue-600" size={28} />
            <div className="mt-3 font-black text-slate-900">Загружаем калькулятор</div>
            <div className="mt-1 text-sm font-semibold text-slate-500">Расчёты и архив КП останутся связанными с CRM.</div>
          </div>
        </div>
      ) : null}

      <iframe
        className="h-full min-h-[520px] w-full border-0 bg-white"
        src={CALCULATOR_URL}
        title="Калькулятор изделий AMALGAMA"
        allow="clipboard-read; clipboard-write"
        referrerPolicy="strict-origin-when-cross-origin"
        onLoad={() => setLoaded(true)}
      />

      <a
        href={CALCULATOR_URL}
        target="_blank"
        rel="noreferrer"
        className="absolute bottom-4 right-4 z-20 inline-flex items-center gap-2 rounded-full bg-slate-950 px-4 py-2.5 text-xs font-black text-white shadow-xl transition hover:bg-blue-600"
      >
        <CalculatorIcon size={15} />
        Открыть отдельно
        <ExternalLink size={14} />
      </a>
    </section>
  );
}
