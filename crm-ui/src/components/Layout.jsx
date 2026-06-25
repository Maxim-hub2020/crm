import React, { useEffect, useMemo, useState } from "react";
import { Briefcase, FolderKanban, Home, ListTodo, LogOut, Menu, MessageCircle, Mic, Search, Settings, ShieldQuestion, Users, Wallet, X } from "lucide-react";
import { NavLink, Link, useLocation, useNavigate } from "react-router-dom";

import { clearToken, fetchGlobalSearch, fetchMe, getUser, isAdminUser } from "../api";
import { BrandMark } from "./BrandLogo.jsx";

const ROUTE_META = {
  "/": { title: "Дашборд", icon: Home },
  "/assistant": { title: "Ассистент", icon: Mic },
  "/projects": { title: "Проекты", icon: FolderKanban },
  "/chats": { title: "Чаты", icon: MessageCircle },
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
        `mb-2 flex h-11 w-full items-center gap-3 overflow-hidden rounded-2xl px-3 text-sm font-bold transition ${
          isActive ? "bg-blue-50 text-blue-600" : "text-slate-400 hover:bg-slate-50 hover:text-slate-700"
        }`
      }
    >
      <Icon size={18} className="shrink-0" />
      <span className="max-w-40 truncate opacity-100 transition-all duration-200 md:max-w-0 md:opacity-0 md:group-hover/sidebar:max-w-40 md:group-hover/sidebar:opacity-100">
        {label}
      </span>
    </NavLink>
  );
}

export default function Layout({ children }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [user, setUser] = useState(getUser());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [globalQuery, setGlobalQuery] = useState("");
  const [globalResults, setGlobalResults] = useState([]);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);

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

  useEffect(() => {
    if (isAssistantMode) {
      setGlobalSearchOpen(false);
      return undefined;
    }

    const query = globalQuery.trim();
    if (query.length < 2) {
      setGlobalResults([]);
      return undefined;
    }

    let active = true;
    const timerId = window.setTimeout(async () => {
      try {
        const response = await fetchGlobalSearch(query);
        if (!active) return;
        setGlobalResults(response.results || []);
        setGlobalSearchOpen(true);
      } catch {
        if (!active) return;
        setGlobalResults([]);
      }
    }, 250);

    return () => {
      active = false;
      window.clearTimeout(timerId);
    };
  }, [globalQuery, isAssistantMode]);

  useEffect(() => {
    if (!isAssistantMode) {
      localStorage.setItem("crm_last_screen", location.pathname);
    }
  }, [isAssistantMode, location.pathname]);

  function logout() {
    clearToken();
    navigate("/login");
  }

  function closeSidebar() {
    setSidebarOpen(false);
  }

  function openGlobalResult(result) {
    setGlobalQuery("");
    setGlobalResults([]);
    setGlobalSearchOpen(false);

    if (result.project_id) {
      navigate("/projects", {
        state: {
          projectId: result.project_id,
          tab: result.tab || "comments",
        },
      });
      return;
    }

    if (result.type === "client") {
      navigate("/clients", { state: { clientId: result.client_id } });
      return;
    }

    navigate(result.route || "/");
  }

  return (
    <div className="app-shell relative flex overflow-hidden bg-[#F5F5F7] selection:bg-blue-100">
      {sidebarOpen && <div className="fixed inset-0 z-40 bg-black/30 md:hidden" onClick={closeSidebar} />}

      <aside
        className={`group/sidebar fixed z-50 flex h-full w-64 shrink-0 flex-col border-r border-slate-200/70 bg-white transition-[width,transform] duration-200 md:relative md:w-20 md:translate-x-0 md:hover:w-64 ${
          isAssistantMode ? "pointer-events-none opacity-20 blur-[2px] saturate-50" : ""
        } ${sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}`}
      >
        <div className="flex h-16 shrink-0 items-center gap-3 overflow-hidden border-b border-slate-100 px-4">
          <BrandMark className="h-10 w-10" />
          <div className="min-w-0 max-w-40 opacity-100 transition-all duration-200 md:max-w-0 md:opacity-0 md:group-hover/sidebar:max-w-40 md:group-hover/sidebar:opacity-100">
            <div className="truncate text-sm font-black uppercase tracking-tight text-slate-950">Цех CRM</div>
            <div className="truncate text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">проекты и финансы</div>
          </div>
        </div>

        <nav className="mt-4 flex flex-1 flex-col px-3">
          <NavItem to="/" icon={Home} label="Дашборд" onClick={closeSidebar} />
          <NavItem to="/projects" icon={FolderKanban} label="Проекты" onClick={closeSidebar} />
          <NavItem to="/chats" icon={MessageCircle} label="Чаты" onClick={closeSidebar} />
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
            className="flex h-11 w-full items-center gap-3 overflow-hidden rounded-2xl px-3 text-sm font-bold text-slate-400 transition hover:bg-red-50 hover:text-red-500"
            type="button"
            title="Выход"
          >
            <LogOut size={17} className="shrink-0" />
            <span className="max-w-40 truncate opacity-100 transition-all duration-200 md:max-w-0 md:opacity-0 md:group-hover/sidebar:max-w-40 md:group-hover/sidebar:opacity-100">
              Выход
            </span>
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {!isAssistantMode && (
          <header className="z-10 flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200/70 bg-white px-4 py-2 sm:flex-nowrap sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <button onClick={() => setSidebarOpen(true)} className="-ml-2 p-2 text-slate-500 md:hidden" type="button">
                <Menu size={20} />
              </button>
              <h1 className="truncate text-lg font-black uppercase tracking-tight text-slate-900">{currentMeta.title}</h1>
            </div>

            <div className="relative order-3 w-full sm:order-none sm:min-w-[240px] sm:max-w-xl sm:flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                value={globalQuery}
                onChange={(event) => setGlobalQuery(event.target.value)}
                onFocus={() => {
                  if (globalResults.length) setGlobalSearchOpen(true);
                }}
                placeholder="Поиск по CRM..."
                className="h-9 w-full rounded-full border border-slate-200 bg-slate-50 px-9 text-sm font-semibold text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-blue-300 focus:bg-white focus:ring-4 focus:ring-blue-500/10"
              />
              {globalQuery ? (
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                  onClick={() => {
                    setGlobalQuery("");
                    setGlobalResults([]);
                    setGlobalSearchOpen(false);
                  }}
                >
                  <X size={14} />
                </button>
              ) : null}
              {globalSearchOpen && globalQuery.trim().length >= 2 ? (
                <div className="absolute left-0 right-0 top-11 z-50 overflow-hidden rounded-3xl border border-slate-100 bg-white shadow-2xl">
                  {globalResults.length ? (
                    <div className="max-h-[420px] overflow-auto p-2">
                      {globalResults.map((result) => (
                        <button
                          key={`${result.type}-${result.id}`}
                          type="button"
                          className="block w-full rounded-2xl px-3 py-2 text-left transition hover:bg-blue-50"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => openGlobalResult(result)}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-black text-slate-900">{result.title}</div>
                              {result.subtitle ? <div className="mt-0.5 truncate text-xs font-semibold text-slate-500">{result.subtitle}</div> : null}
                            </div>
                            <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-slate-500">
                              {result.label}
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="px-4 py-5 text-sm font-semibold text-slate-500">Ничего не найдено.</div>
                  )}
                </div>
              ) : null}
            </div>

            <Link
              to="/assistant"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-50 hover:text-slate-900"
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
