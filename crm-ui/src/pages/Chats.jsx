import React, { useEffect, useState } from "react";
import { ArrowUpRight, CheckCircle2, ExternalLink, Inbox, MessageCircle, PlugZap, RefreshCw, Settings2 } from "lucide-react";

import { extractApiErrorMessage, fetchChatSettings } from "../api";
import { Button } from "../components/ui.jsx";

function setupSteps() {
  return [
    "Администратор открывает раздел «Система» и блок «Чаты».",
    "Вставляет адрес Chatwoot, например https://chats.cehcrm.ru, и включает модуль.",
    "В Chatwoot подключает каналы: Telegram, WhatsApp, сайт, почту и другие мессенджеры.",
    "Менеджеры открывают «Чаты» и работают с единым inbox своей CRM.",
  ];
}

function FeatureCard({ icon: Icon, title, text }) {
  return (
    <div className="rounded-[28px] border border-slate-200/80 bg-white p-5 shadow-sm">
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
        <Icon size={20} />
      </div>
      <div className="text-sm font-black uppercase tracking-tight text-slate-950">{title}</div>
      <p className="mt-2 text-sm leading-6 text-slate-500">{text}</p>
    </div>
  );
}

export default function Chats() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    fetchChatSettings()
      .then((data) => {
        if (!active) return;
        setSettings(data);
        setError("");
      })
      .catch((requestError) => {
        if (!active) return;
        setError(extractApiErrorMessage(requestError, "Не удалось загрузить настройки чатов."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const chatwootAppUrl = settings?.app_url || "";
  const configured = Boolean(settings?.enabled && chatwootAppUrl);

  return (
    <div className="space-y-5">
      {error ? <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}

      <section className="overflow-hidden rounded-[32px] border border-slate-200/80 bg-white shadow-sm">
        <div className="flex flex-col gap-5 bg-[radial-gradient(circle_at_top_left,#dbeafe,transparent_35%),linear-gradient(135deg,#ffffff,#f8fafc)] p-5 sm:flex-row sm:items-center sm:justify-between sm:p-7">
          <div className="min-w-0">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-1 text-xs font-black uppercase tracking-[0.18em] text-blue-600 shadow-sm">
              <MessageCircle size={14} />
              единый inbox
            </div>
            <h2 className="text-2xl font-black tracking-tight text-slate-950 sm:text-3xl">Чаты клиентов</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
              Здесь открывается inbox Chatwoot: сайт, Telegram, WhatsApp, Instagram, почта и другие каналы собираются в одном окне.
            </p>
          </div>

          {loading ? (
            <div className="rounded-3xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-500">
              Загружаем настройки...
            </div>
          ) : configured ? (
            <a href={chatwootAppUrl} target="_blank" rel="noreferrer">
              <Button type="button" className="gap-2">
                Открыть Chatwoot <ArrowUpRight size={16} />
              </Button>
            </a>
          ) : (
            <div className="rounded-3xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-700">
              Подключите Chatwoot в разделе «Система»
            </div>
          )}
        </div>

        {configured ? (
          <div className="h-[calc(100vh-220px)] min-h-[620px] border-t border-slate-100 bg-slate-50">
            <iframe
              title="Chatwoot Inbox"
              src={chatwootAppUrl}
              className="h-full w-full border-0 bg-white"
              allow="clipboard-read; clipboard-write; microphone; camera"
            />
          </div>
        ) : (
          <div className="grid gap-4 border-t border-slate-100 p-5 sm:p-7 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="rounded-[28px] bg-slate-950 p-5 text-white sm:p-6">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10">
                <Settings2 size={22} />
              </div>
              <h3 className="text-xl font-black tracking-tight">Как подключить</h3>
              <div className="mt-5 space-y-3">
                {setupSteps().map((step, index) => (
                  <div key={step} className="flex gap-3 rounded-2xl bg-white/5 p-3">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-500 text-xs font-black">
                      {index + 1}
                    </div>
                    <div className="text-sm leading-6 text-slate-200">{step}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-4">
              <FeatureCard
                icon={Inbox}
                title="Один inbox"
                text="Менеджеры отвечают клиентам в одном окне, без прыжков между мессенджерами."
              />
              <FeatureCard
                icon={RefreshCw}
                title="Настройка из CRM"
                text="Адрес Chatwoot теперь хранится в backend-настройках, а не в frontend env."
              />
              <FeatureCard
                icon={PlugZap}
                title="Отдельный сервис"
                text="Chatwoot разворачивается рядом с CRM и подключает каналы уже внутри себя."
              />
            </div>
          </div>
        )}
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <FeatureCard
          icon={CheckCircle2}
          title="Готово"
          text="Модуль «Чаты» читает настройки из CRM и открывает подключенный inbox."
        />
        <FeatureCard
          icon={ExternalLink}
          title="Self-host"
          text="Для TimeWeb уже есть отдельный docker-compose.chatwoot.yml, чтобы поднять Chatwoot рядом с CRM."
        />
        <FeatureCard
          icon={Settings2}
          title="Следующий слой"
          text="Для SaaS с разными компаниями нужен workspace/tenant-слой, чтобы изолировать не только чаты, но и клиентов, проекты и финансы."
        />
      </section>
    </div>
  );
}
