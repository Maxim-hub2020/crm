import React, { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { BarChart3, FolderKanban, Percent, LogOut } from "lucide-react";
import { Button } from "./ui";
import { clearToken, getUser, fetchMe } from "../api";

export default function Layout({ children }) {
  const nav = useNavigate();
  const [user, setUser] = useState(getUser());

  useEffect(() => {
    (async () => {
      try {
        const me = await fetchMe();
        setUser(me);
      } catch {
        // token may be invalid
      }
    })();
  }, []);

  function logout() {
    clearToken();
    nav("/login");
  }

  const linkClass = ({ isActive }) =>
    `flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition ${
      isActive ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-100"
    }`;

  return (
    <div className="min-h-screen">
      <div className="mx-auto grid max-w-7xl grid-cols-12 gap-6 p-6">
        <aside className="col-span-12 md:col-span-3 lg:col-span-2">
          <div className="sticky top-6 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-zinc-200">
            <div className="mb-4">
              <div className="text-sm text-zinc-500">CRM</div>
              <div className="text-base font-semibold">Проекты и комиссии</div>
              <div className="mt-2 text-xs text-zinc-500">
                {user?.role === "admin" ? "Администратор" : "Менеджер"} • {user?.full_name || user?.username || ""}
              </div>
            </div>

            <nav className="space-y-2">
              <NavLink to="/" className={linkClass}>
                <BarChart3 size={18} /> Дашборд
              </NavLink>
              <NavLink to="/projects" className={linkClass}>
                <FolderKanban size={18} /> Проекты
              </NavLink>
              <NavLink to="/commissions" className={linkClass}>
                <Percent size={18} /> Начисления
              </NavLink>
            </nav>

            <div className="mt-6">
              <Button variant="secondary" className="w-full" onClick={logout}>
                <LogOut size={16} /> Выйти
              </Button>
            </div>
          </div>
        </aside>

        <main className="col-span-12 md:col-span-9 lg:col-span-10">{children}</main>
      </div>
    </div>
  );
}
