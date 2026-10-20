import React, { useLayoutEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { Plus, X } from "lucide-react";

const MOBILE_SHEET_TYPES = new Set(["text", "tel", "number", "email", "search", "url"]);

function mobileSheetAvailable(type, disabled, readOnly, enabled) {
  if (enabled === false || disabled || readOnly || typeof window === "undefined") return false;
  return MOBILE_SHEET_TYPES.has(type || "text") && window.matchMedia("(max-width: 767px)").matches;
}

function closestFieldLabel(input, explicitLabel, placeholder) {
  if (explicitLabel) return explicitLabel;
  if (input?.getAttribute("aria-label")) return input.getAttribute("aria-label");
  let parent = input?.parentElement;
  for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement) {
    const label = parent.querySelector(":scope > label");
    const fields = parent.querySelectorAll("input, textarea, select");
    const text = label?.textContent?.trim();
    if (text && fields.length === 1 && fields[0] === input) return text;
  }
  return placeholder || "Введите значение";
}

function MobileFieldSheet({ open, title, multiline, value, inputProps, onValueChange, onClose }) {
  const fieldRef = useRef(null);
  const closeTimerRef = useRef(null);
  const revealTimerRef = useRef(null);
  const blurTimerRef = useRef(null);
  const dragRef = useRef({ pointerId: null, startY: 0, startedAt: 0 });
  const [entered, setEntered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dragY, setDragY] = useState(0);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    setDragY(0);
    setDragging(false);
    // iOS only opens the software keyboard when focus happens during the
    // original tap. The sheet is mounted synchronously by begin().
    fieldRef.current?.focus({ preventScroll: true });
    const reveal = () => {
      window.clearTimeout(revealTimerRef.current);
      revealTimerRef.current = window.setTimeout(() => {
        window.requestAnimationFrame(() => setEntered(true));
      }, 60);
    };
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", reveal);
    revealTimerRef.current = window.setTimeout(() => {
      window.requestAnimationFrame(() => setEntered(true));
    }, 120);
    return () => {
      viewport?.removeEventListener("resize", reveal);
      window.clearTimeout(revealTimerRef.current);
      window.clearTimeout(closeTimerRef.current);
      window.clearTimeout(blurTimerRef.current);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;

  const close = () => {
    if (closeTimerRef.current) return;
    setDragging(false);
    setEntered(false);
    blurTimerRef.current = window.setTimeout(() => fieldRef.current?.blur(), 90);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setDragY(0);
      onClose();
    }, 280);
  };

  const startDrag = (event) => {
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startedAt: window.performance.now(),
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };

  const moveDrag = (event) => {
    if (dragRef.current.pointerId !== event.pointerId) return;
    setDragY(Math.max(0, event.clientY - dragRef.current.startY));
  };

  const finishDrag = (event) => {
    if (dragRef.current.pointerId !== event.pointerId) return;
    const distance = Math.max(0, event.clientY - dragRef.current.startY);
    const elapsed = Math.max(1, window.performance.now() - dragRef.current.startedAt);
    dragRef.current.pointerId = null;
    setDragging(false);
    if (distance > 90 || distance / elapsed > 0.65) close();
    else setDragY(0);
  };

  const sharedProps = {
    ref: fieldRef,
    value,
    onChange: (event) => onValueChange(event.target.value),
    placeholder: inputProps.placeholder,
    inputMode: inputProps.inputMode || (
      inputProps.type === "number" ? "decimal" :
        inputProps.type === "tel" ? "tel" :
          inputProps.type === "email" ? "email" :
            inputProps.type === "search" ? "search" :
              inputProps.type === "url" ? "url" : undefined
    ),
    autoComplete: inputProps.autoComplete,
    maxLength: inputProps.maxLength,
    enterKeyHint: multiline ? undefined : "done",
    "data-mobile-sheet-field": "true",
    className: multiline
      ? "min-h-36 w-full resize-none rounded-3xl border border-slate-200 bg-slate-50 px-5 py-4 text-lg font-semibold leading-relaxed text-slate-900 outline-none transition focus:border-blue-400 focus:bg-white focus:ring-4 focus:ring-blue-500/10"
      : "h-16 w-full rounded-3xl border border-slate-200 bg-slate-50 px-5 text-xl font-bold text-slate-900 outline-none transition placeholder:text-slate-300 focus:border-blue-400 focus:bg-white focus:ring-4 focus:ring-blue-500/10",
    onKeyDown: (event) => {
      if (!multiline && event.key === "Enter") {
        event.preventDefault();
        close();
      }
    },
  };

  return createPortal(
    <div className="fixed inset-0 z-[90]" role="presentation">
      <button
        type="button"
        aria-label="Закрыть ввод"
        className="absolute inset-0 cursor-default bg-slate-950/45 backdrop-blur-sm transition-opacity duration-200"
        style={{ opacity: entered ? 1 : 0 }}
        onClick={close}
      />
      <section
        className="fixed inset-x-0 bottom-0 z-10 w-full rounded-t-[34px] bg-white px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-24px_70px_rgba(15,23,42,0.24)] will-change-transform"
        style={{
          transform: entered ? `translate3d(0, ${dragY}px, 0)` : "translate3d(0, 100%, 0)",
          transition: dragging ? "none" : "transform 280ms cubic-bezier(0.22, 1, 0.36, 1)",
          backfaceVisibility: "hidden",
        }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div
          className="cursor-grab touch-none pb-4 active:cursor-grabbing"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
        >
          <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-slate-200" />
          <h2 className="truncate px-4 text-center text-lg font-black text-slate-900">{title}</h2>
        </div>
        {multiline ? <textarea {...sharedProps} rows={5} /> : <input {...sharedProps} type={inputProps.type || "text"} />}
      </section>
    </div>,
    document.body
  );
}

function useMobileFieldSheet({ value, defaultValue, type = "text", disabled, readOnly, mobileSheet, mobileLabel, placeholder, onChange, onBlur, multiline = false }) {
  const inputRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [title, setTitle] = useState("");

  const emitChange = (nextValue) => {
    setDraft(nextValue);
    onChange?.({
      target: { value: nextValue, name: inputRef.current?.name || "" },
      currentTarget: { value: nextValue, name: inputRef.current?.name || "" },
    });
  };

  const begin = (event) => {
    if (!mobileSheetAvailable(type, disabled, readOnly, mobileSheet)) return false;
    event?.preventDefault?.();
    const currentValue = String(value ?? inputRef.current?.value ?? defaultValue ?? "");
    inputRef.current?.blur();
    // Commit the portal before the tap handler returns so WKWebView accepts
    // focus on its real field and opens the matching keyboard immediately.
    flushSync(() => {
      setDraft(currentValue);
      setTitle(closestFieldLabel(inputRef.current, mobileLabel, placeholder));
      setOpen(true);
    });
    return true;
  };

  const close = () => {
    setOpen(false);
    onBlur?.({ target: { value: draft }, currentTarget: { value: draft } });
  };

  const preventsNativeEditing = mobileSheetAvailable(type, disabled, readOnly, mobileSheet);

  return { inputRef, open, draft, title, begin, emitChange, close, multiline, preventsNativeEditing };
}

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

export function PageHeaderAction({ children }) {
  const [target, setTarget] = useState(null);

  useLayoutEffect(() => {
    setTarget(document.getElementById("crm-header-action"));
  }, []);

  return target ? createPortal(children, target) : null;
}

export function HeaderAddButton({ label, className = "", ...props }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`group flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-950 text-white shadow-lg shadow-slate-950/20 transition duration-200 ease-out hover:scale-105 hover:bg-black active:scale-90 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      {...props}
    >
      <Plus
        size={27}
        strokeWidth={2.6}
        className="transition-transform duration-200 ease-out group-active:rotate-90 group-active:scale-110"
      />
    </button>
  );
}

export function Input({ className = "", onKeyDown, onPointerDown, onClick, onFocus, enterKeyHint, mobileSheet = true, mobileLabel, ...props }) {
  const numeric = props.inputMode === "numeric" || props.inputMode === "decimal";
  const sheet = useMobileFieldSheet({ ...props, mobileSheet, mobileLabel, multiline: false });
  return (
    <>
      <input
        ref={sheet.inputRef}
        className={`w-full rounded-xl border border-gray-200 bg-white p-3 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:ring-2 focus:ring-blue-500/20 ${className}`}
        enterKeyHint={enterKeyHint || (numeric ? "done" : undefined)}
        onPointerDown={(event) => {
          onPointerDown?.(event);
        }}
        onFocus={(event) => {
          onFocus?.(event);
        }}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) sheet.begin(event);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && numeric) event.currentTarget.blur();
          onKeyDown?.(event);
        }}
        {...props}
        readOnly={sheet.preventsNativeEditing || props.readOnly}
      />
      <MobileFieldSheet
        open={sheet.open}
        title={sheet.title}
        value={sheet.draft}
        inputProps={props}
        onValueChange={sheet.emitChange}
        onClose={sheet.close}
      />
    </>
  );
}

export function Textarea({ className = "", onPointerDown, onClick, onFocus, mobileSheet = true, mobileLabel, ...props }) {
  const sheet = useMobileFieldSheet({ ...props, type: "text", mobileSheet, mobileLabel, multiline: true });
  return (
    <>
      <textarea
        ref={sheet.inputRef}
        className={`w-full rounded-xl border border-gray-200 bg-white p-3 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:ring-2 focus:ring-blue-500/20 ${className}`}
        onPointerDown={(event) => {
          onPointerDown?.(event);
        }}
        onFocus={(event) => {
          onFocus?.(event);
        }}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) sheet.begin(event);
        }}
        {...props}
        readOnly={sheet.preventsNativeEditing || props.readOnly}
      />
      <MobileFieldSheet
        open={sheet.open}
        title={sheet.title}
        multiline
        value={sheet.draft}
        inputProps={props}
        onValueChange={sheet.emitChange}
        onClose={sheet.close}
      />
    </>
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
  mobileSheet = false,
}) {
  if (!open) return null;

  const modal = (
    <div className={`crm-modal-overlay fixed inset-0 z-50 flex justify-center overflow-y-auto px-2 sm:px-4 ${overlayClassName} ${mobileSheet ? "crm-modal-bottom-sheet-overlay items-end sm:items-center" : positionClassName}`}>
      <div className="absolute inset-0" onClick={onClose} />
      <div
        className={`crm-modal-panel relative z-10 flex min-w-0 w-full flex-col overflow-hidden bg-white shadow-2xl ${mobileSheet ? "crm-modal-bottom-sheet rounded-b-none rounded-t-[32px] sm:rounded-[32px]" : "rounded-3xl sm:rounded-[32px]"} ${widthClassName}`}
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
        <div className={`min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-3 sm:px-7 sm:py-4 ${bodyClassName}`}>{children}</div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
