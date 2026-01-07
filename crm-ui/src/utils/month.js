export function monthStartISO(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}-01`;
}

export function monthLabel(iso) {
  const [y, m] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, 1);
  return dt.toLocaleDateString("ru-RU", { year: "numeric", month: "long" });
}
