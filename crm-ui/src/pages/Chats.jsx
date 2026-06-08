import React, { useMemo } from "react";
import { ArrowUpRight, CheckCircle2, ExternalLink, Inbox, MessageCircle, PlugZap, RefreshCw, Settings2 } from "lucide-react";

import { Button } from "../components/ui.jsx";

const CHATWOOT_URL = String(import.meta.env.VITE_CHATWOOT_URL || "").trim().replace(/\/+$/, "");

function setupSteps() {
  return [
    "Поднять Chatwoot отдельным compose-файлом на TimeWeb.",
    "Подключить каналы: Telegram, WhatsApp, сайт, почту и другие мессенджеры.",
    "Добавить URL Chatwoot в .env CRM: VITE_CHATWOOT_URL=https://chats.cehcrm.ru.",
    "Пересобрать frontend, чтобы модуль «Чаты» открыл единый inbox.",
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
  const chatwootAppUrl = useMemo(() => (CHATWOOT_URL ? `${CHATWOOT_URL}/app` : ""), []);
  const configured = Boolean(CHATWOOT_URL);

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-[32px] border border-slate-200/80 bg-white shadow-sm">
        <div className="flex flex-col gap-5 bg-[radial-gradient(circle_at_top_left,#dbeafe,transparent_35%),linear-gradient(135deg,#ffffff,#f8fafc)] p-5 sm:flex-row sm:items-center sm:justify-between sm:p-7">
          <div className="min-w-0">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-1 text-xs font-black uppercase tracking-[0.18em] text-blue-600 shadow-sm">
              <MessageCircle size={14} />
              единый inbox
            </div>
            <h2 className="text-2xl font-black tracking-tight text-slate-950 sm:text-3xl">Чаты клиентов</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
              Модуль для подключения Chatwoot: все входящие сообщения из сайта, Telegram, WhatsApp, Instagram, почты и других каналов будут собираться в одном окне.
            </p>
          </div>

          {configured ? (
            <a href={chatwootAppUrl} target="_blank" rel="noreferrer">
              <Button type="button" className="gap-2">
                Открыть Chatwoot <ArrowUpRight size={16} />
              </Button>
            </a>
          ) : (
            <div className="rounded-3xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-700">
              Chatwoot URL пока не настроен
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
              <h3 className="text-xl font-black tracking-tight">Как подключим</h3>
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
                title="Синхронизация CRM"
                text="Следующим шагом привяжем контакты Chatwoot к клиентам и проектам CRM через API/webhook."
              />
              <FeatureCard
                icon={PlugZap}
                title="Отдельный сервис"
                text="Chatwoot разворачивается отдельно, поэтому не перегружает Django и проще обновляется."
              />
            </div>
          </div>
        )}
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <FeatureCard
          icon={CheckCircle2}
          title="Что уже готово"
          text="В CRM добавлен модуль «Чаты» и переменная VITE_CHATWOOT_URL для подключения inbox."
        />
        <FeatureCard
          icon={ExternalLink}
          title="Self-host"
          text="Для TimeWeb подготовлен отдельный docker-compose.chatwoot.yml, чтобы поднять Chatwoot рядом с CRM."
        />
        <FeatureCard
          icon={Settings2}
          title="Дальше"
          text="После запуска Chatwoot подключим Telegram/WhatsApp и сделаем связку сообщений с карточками клиентов."
        />
      </section>
    </div>
  );
}
