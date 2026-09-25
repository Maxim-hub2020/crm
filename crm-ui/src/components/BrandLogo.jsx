import React from "react";

export function BrandMark({ className = "" }) {
  return (
    <div
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-slate-950 text-white shadow-lg shadow-slate-950/15 ring-1 ring-white/10 ${className}`}
      aria-hidden="true"
    >
      <div className="absolute -left-4 -top-5 h-16 w-16 rounded-full bg-blue-500/35 blur-xl" />
      <div className="absolute -bottom-5 -right-4 h-16 w-16 rounded-full bg-cyan-300/30 blur-xl" />
      <div className="absolute left-2 top-2 flex gap-0.5 opacity-70">
        <span className="h-1.5 w-1.5 rounded-full bg-white/70" />
        <span className="h-1.5 w-1.5 rounded-full bg-white/35" />
      </div>
      <span className="relative -mt-0.5 text-[22px] font-black leading-none tracking-tighter">Ц</span>
      <div className="absolute bottom-2.5 right-2.5 flex items-end gap-0.5">
        <span className="h-2 w-1 rounded-full bg-blue-300" />
        <span className="h-3.5 w-1 rounded-full bg-white" />
        <span className="h-2.5 w-1 rounded-full bg-cyan-300" />
      </div>
    </div>
  );
}

export function BrandLogo({ className = "", markClassName = "h-10 w-10", compact = false }) {
  return (
    <div className={`flex min-w-0 items-center gap-3 ${className}`}>
      <BrandMark className={markClassName} />
      {!compact && (
        <div className="min-w-0">
          <div className="truncate text-sm font-black uppercase tracking-tight text-slate-950">Цех CRM</div>
          <div className="truncate text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">проекты и финансы</div>
        </div>
      )}
    </div>
  );
}
