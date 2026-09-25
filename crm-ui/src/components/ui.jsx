import React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export function Card({ className = "", children }) {
  return <div className={`rounded-[32px] bg-white shadow-lg ${className}`}>{children}</div>;
}

export function CardHeader({ className = "", children }) {
  return <div className={`border-b border-gray-100 px-6 py-4 ${className}`}>{children}</div>;
}

export function CardBody({ className = "", children }) {
  return <div className={`px-6 py-5 ${className}`}>{children}</div>;
}

export function Label({ className = "", children }) {
  return (
    <label className={`ml-1 block text-[10px] font-bold uppercase tracking-widest text-gray-400 ${className}`}>
      {children}
    </label>
  );
}

export function Button({ variant = "primary", className = "", ...props }) {
  const base =
    "btn-hover inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60";

  const styles =
    variant === "primary"
      ? "bg-gray-900 text-white shadow-lg hover:bg-black"
      : variant === "ghost"
        ? "bg-transparent text-gray-500 hover:bg-gray-100 hover:text-gray-900"
        : variant === "danger"
          ? "bg-red-600 text-white shadow-lg hover:bg-red-700"
          : "border border-gray-200 bg-white text-gray-700 shadow-sm hover:bg-gray-50";

  return <button className={`${base} ${styles} ${className}`} {...props} />;
}

export function Input({ className = "", ...props }) {
  return (
    <input
      className={`w-full rounded-xl border border-gray-200 bg-white p-3 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:ring-2 focus:ring-blue-500/20 ${className}`}
      {...props}
    />
  );
}

export function Select({ className = "", ...props }) {
  return (
    <select
      className={`w-full appearance-none rounded-xl border border-gray-200 bg-white p-3 text-sm text-gray-900 outline-none transition focus:ring-2 focus:ring-blue-500/20 ${className}`}
      {...props}
    />
  );
}

export function Badge({ children, className = "" }) {
  return (
    <span className={`inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500 ${className}`}>
      {children}
    </span>
  );
}

export function Modal({
  open,
  title,
  headerContent,
  onClose,
  children,
  widthClassName = "max-w-3xl",
  bodyClassName = "",
  positionClassName = "items-center",
  overlayClassName = "bg-gray-900/40 backdrop-blur-md",
}) {
  if (!open) return null;

  const modal = (
    <div className={`crm-modal-overlay fixed inset-0 z-50 flex justify-center overflow-y-auto px-2 sm:px-4 ${overlayClassName} ${positionClassName}`}>
      <div className="absolute inset-0" onClick={onClose} />
      <div
        className={`crm-modal-panel relative z-10 flex w-full flex-col overflow-hidden rounded-3xl bg-white shadow-2xl sm:rounded-[32px] ${widthClassName}`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-4 py-2.5 sm:px-7 sm:py-3.5">
          {headerContent || (
            <h2 className="truncate pr-3 text-base font-bold uppercase tracking-tight text-gray-900 sm:pr-4 sm:text-xl">{title}</h2>
          )}
          <button
            className="shrink-0 rounded-full bg-gray-100 p-2 text-gray-500 transition hover:bg-gray-200"
            onClick={onClose}
            type="button"
          >
            <X size={18} />
          </button>
        </div>
        <div className={`flex-1 overflow-y-auto px-4 py-3 sm:px-7 sm:py-4 ${bodyClassName}`}>{children}</div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
