import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

let viewportWidth = window.innerWidth;

function isFormControl(element) {
  return element instanceof HTMLElement && (
    element.matches("input, textarea, select, [contenteditable='true']") ||
    Boolean(element.closest("input, textarea, select, [contenteditable='true']"))
  );
}

function setAppHeight(force = false) {
  const widthChanged = Math.abs(window.innerWidth - viewportWidth) > 2;
  if (!force && !widthChanged && isFormControl(document.activeElement)) return;
  viewportWidth = window.innerWidth;
  document.documentElement.style.setProperty("--app-height", `${window.innerHeight}px`);
}

setAppHeight(true);
window.addEventListener("resize", () => setAppHeight(false));
window.addEventListener("orientationchange", () => window.setTimeout(() => setAppHeight(true), 180));

// WKWebView keeps the iOS keyboard open when the user taps outside a field.
// Blurring here also prevents the whole modal from jumping while focus changes.
document.addEventListener("pointerdown", (event) => {
  const active = document.activeElement;
  if (!isFormControl(active) || active === event.target || active?.contains?.(event.target)) return;
  if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable='true']")) return;
  active.blur();
}, true);

document.addEventListener("focusout", () => {
  window.setTimeout(() => {
    if (!isFormControl(document.activeElement)) setAppHeight(true);
  }, 220);
});

let revealFocusedControlTimer;
document.addEventListener("focusin", (event) => {
  const control = event.target;
  if (!(control instanceof HTMLElement) || !control.matches("input, textarea, [contenteditable='true']") || window.innerWidth > 639) return;
  window.clearTimeout(revealFocusedControlTimer);
  revealFocusedControlTimer = window.setTimeout(() => {
    if (document.activeElement !== control) return;
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop || 0;
    const viewportBottom = viewportTop + (viewport?.height || window.innerHeight);
    const rect = control.getBoundingClientRect();
    if (rect.top < viewportTop + 12 || rect.bottom > viewportBottom - 12) {
      control.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    }
  }, 180);
});

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
