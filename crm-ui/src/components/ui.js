import React from "react";

export function Card({ className = "", children }) {
  return (
    <div className={`rounded-2xl bg-white shadow-sm ring-1 ring-zinc-200 ${className}`}>
      {children}
    </div>
  );
}

export function CardHeader({ className = "", children }) {
  return <div className={`p-5 border-b border-zinc-100 ${className}`}>{children}</div>;
}

export function CardBody({ className = "", children }) {
  return <div className={`p-5 ${className}`}>{children}</div>;
}

export function Button({ variant = "primary", className = "", ...props }) {
  const base = "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition";
  const styles =
    variant === "primary"
      ? "bg-zinc-900 text-white hover:bg-zinc-800"
      : variant === "ghost"
      ? "bg-transparent hover:bg-zinc-100 text-zinc-900"
      : "bg-white ring-1 ring-zinc-200 hover:bg-zinc-50 text-zinc-900";
  return <button className={`${base} ${styles} ${className}`} {...props} />;
}

export function Input({ className = "", ...props }) {
  return (
    <input
      className={`w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-900/20 ${className}`}
      {...props}
    />
  );
}

export function Select({ className = "", ...props }) {
  return (
    <select
      className={`w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-900/20 ${className}`}
      {...props}
    />
  );
}

export function Badge({ children }) {
  return (
    <span className="inline-flex items-center rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-700">
      {children}
    </span>
  );
}

export function Modal({ open, title, onClose, children }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-2xl rounded-2xl bg-white shadow-xl ring-1 ring-zinc-200">
        <div className="flex items-center justify-between border-b border-zinc-100 p-5">
          <div className="text-base font-semibold">{title}</div>
          <button className="text-zinc-500 hover:text-zinc-900" onClick={onClose}>✕</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
