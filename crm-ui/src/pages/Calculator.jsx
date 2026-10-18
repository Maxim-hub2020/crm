import React, { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { useLocation } from "react-router-dom";

import { getRefreshToken, getToken, getUser, isAdminUser } from "../api";

const CALCULATOR_ORIGIN = "https://calc.cehcrm.ru";

export default function Calculator() {
  const location = useLocation();
  const iframeRef = useRef(null);
  const [loaded, setLoaded] = useState(false);
  const calculatorUrl = useMemo(() => {
    const crmParams = new URLSearchParams(location.search);
    const calculatorParams = new URLSearchParams({ embedded: "crm" });
    const quoteId = crmParams.get("quote")?.trim();
    if (quoteId) calculatorParams.set("quote", quoteId);
    return `${CALCULATOR_ORIGIN}/?${calculatorParams.toString()}`;
  }, [location.search]);

  function sendCrmSession() {
    const user = getUser();
    if (!isAdminUser(user)) return;
    const session = {
      username: user?.username || "",
      access: getToken() || "",
      refresh: getRefreshToken() || "",
    };
    if (!session.username || !session.access || !session.refresh) return;
    iframeRef.current?.contentWindow?.postMessage(
      { type: "cehcrm:calculator-session", session },
      CALCULATOR_ORIGIN,
    );
  }

  useEffect(() => {
    function handleCalculatorMessage(event) {
      if (event.origin !== CALCULATOR_ORIGIN || event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type === "cehcrm:calculator-ready") sendCrmSession();
    }

    window.addEventListener("message", handleCalculatorMessage);
    return () => window.removeEventListener("message", handleCalculatorMessage);
  }, []);

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
        ref={iframeRef}
        className="h-full min-h-[520px] w-full border-0 bg-white"
        src={calculatorUrl}
        title="Калькулятор изделий AMALGAMA"
        allow="clipboard-read; clipboard-write"
        referrerPolicy="strict-origin-when-cross-origin"
        onLoad={() => {
          setLoaded(true);
          sendCrmSession();
        }}
      />

    </section>
  );
}
