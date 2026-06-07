import React, { useEffect, useMemo, useState } from "react";
import {
  Briefcase,
  FolderKanban,
  Home,
  ListTodo,
  LogOut,
  Menu,
  Mic,
  Settings,
  ShieldQuestion,
  Users,
  Wallet,
} from "lucide-react";
import { NavLink, Link, useLocation, useNavigate } from "react-router-dom";

import { clearToken, fetchMe, getUser, isAdminUser } from "../api";
import { BrandLogo } from "./BrandLogo.jsx";

const ROUTE_META = {
  "/": { title: "Дашборд", icon: Home },
  "/assistant": { title: "Ассистент", icon: Mic },
  "/projects": { title: "Проекты", icon: FolderKanban },
  "/finances": { title: "Финансы", icon: Wallet },
  "/clients": { title: "Клиенты", icon: Users },
  "/tasks": { title: "Задачи", icon: ListTodo },
  "/requests": { title: "Запросы", icon: ShieldQuestion },
  "/settings": { title: "Система", icon: Settings },
};

function NavItem({ to, icon: Icon, label, onClick }) {
  return (
    <NavLink
      to={to}
      title={label}
      onClick={onClick}
      className={({ isActive }) =>
        `mb-2 flex h-11 w-full items-center gap-3 rounded-2xl px-3 text-sm font-bold transition ${
          isActive ? "bg-blue-50 text-blue-600" : "text-slate-400 hover:bg-slate-50 hover:text-slate-700"
        }`
      }
    >
      <Icon size={18} className="shrink-0" />
      <span className="truncate">{label}</span>
    </NavLink>
  );
}

export default function Layout({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [user, setUser] = useState(getUser());
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const me = await fetchMe();
        if (active) setUser(me);
      } catch {
        // token may be invalid
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const currentMeta = useMemo(() => ROUTE_META[location.pathname] || { title: "CRM", icon: Briefcase }, [location.pathname]);
  const isAdmin = isAdminUser(user);
  const isAssistantMode = location.pathname === "/assistant";

  function logout() {
    clearToken();
    navigate("/login");
  }

  function closeSidebar() {
    setSidebarOpen(false);
  }

  return (
    <div className="app-shell relative flex overflow-hidden bg-[#F5F5F7] selection:bg-blue-100">
      {sidebarOpen && <div className="fixed inset-0 z-40 bg-black/30 md:hidden" onClick={closeSidebar} />}

      <aside
        className={`fixed z-50 flex h-full w-64 shrink-0 flex-col border-r border-slate-200/70 bg-white transition-transform md:relative md:w-56 md:translate-x-0 xl:w-60 ${
          isAssistantMode ? "pointer-events-none opacity-20 blur-[2px] saturate-50" : ""
        } ${sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}`}
      >
        <div className="flex h-16 shrink-0 items-center border-b border-slate-100 px-4">
          <BrandLogo />
        </div>

        <nav className="mt-4 flex flex-1 flex-col px-3">
          <NavItem to="/" icon={Home} label="Дашборд" onClick={closeSidebar} />
          <NavItem to="/projects" icon={FolderKanban} label="Проекты" onClick={closeSidebar} />
          {isAdmin && <NavItem to="/finances" icon={Wallet} label="Финансы" onClick={closeSidebar} />}
          <NavItem to="/tasks" icon={ListTodo} label="Задачи" onClick={closeSidebar} />
          <NavItem to="/clients" icon={Users} label="Клиенты" onClick={closeSidebar} />
          {isAdmin && <NavItem to="/requests" icon={ShieldQuestion} label="Запросы" onClick={closeSidebar} />}
          {isAdmin && <NavItem to="/settings" icon={Settings} label="Система" onClick={closeSidebar} />}
          <NavItem to="/assistant" icon={Mic} label="AI-помощник" onClick={closeSidebar} />
        </nav>

        <div className="flex shrink-0 justify-center border-t border-slate-100 px-3 py-3">
          <button
            onClick={logout}
            className="flex h-11 w-full items-center gap-3 rounded-2xl px-3 text-sm font-bold text-slate-400 transition hover:bg-red-50 hover:text-red-500"
            type="button"
            title="Выход"
          >
            <LogOut size={17} className="shrink-0" />
            <span className="truncate">Выход</span>
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {!isAssistantMode && (
          <header className="z-10 flex h-12 shrink-0 items-center justify-between border-b border-slate-200/70 bg-white px-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <button onClick={() => setSidebarOpen(true)} className="-ml-2 p-2 text-slate-500 md:hidden" type="button">
                <Menu size={20} />
              </button>
              <h1 className="truncate text-lg font-black uppercase tracking-tight text-slate-900">{currentMeta.title}</h1>
            </div>

            <Link
              to="/assistant"
              className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-50 hover:text-slate-900"
            >
              <Mic size={13} />
              AI-помощник
            </Link>
          </header>
        )}

        <main className={`no-scrollbar flex-1 overflow-auto ${isAssistantMode ? "relative p-0" : "relative p-4 sm:p-6"}`}>
          {children}
        </main>
      </div>
    </div>
  );
}
