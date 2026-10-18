import React, { useEffect, useMemo, useState } from "react";
import { Briefcase, Calculator, FolderKanban, Home, ListTodo, LogOut, MapPin, Menu, MessageCircle, Phone, Search, Settings, ShieldQuestion, Users, Wallet, X } from "lucide-react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";

import { clearToken, fetchGlobalSearch, fetchMe, fetchProjects, getUser, isAdminUser } from "../api";
import { BrandMark } from "./BrandLogo.jsx";
import { Button, Modal } from "./ui.jsx";
import { clearNativeVisitLocations, syncNativeVisitLocations } from "../utils/visitLocations.js";
import { openNativeYandexRoute } from "../utils/appLinks.js";

const PENDING_VISIT_KEY = "crm_pending_visit_project_id";

function consumePendingVisitProjectId() {
  const projectId = localStorage.getItem(PENDING_VISIT_KEY);
  if (projectId) localStorage.removeItem(PENDING_VISIT_KEY);
  return projectId;
}

function visitRouteLinks(project) {
  const lat = Number(project?.object_lat);
  const lon = Number(project?.object_lon);
  const hasCoordinates = Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
  const destination = hasCoordinates ? `${lat},${lon}` : String(project?.object_address || "").trim();
  if (!destination) return null;
  const params = new URLSearchParams({ mode: "routes", rtext: `~${destination}`, rtt: "auto" });
  const webUrl = `https://yandex.ru/maps/?${params.toString()}`;
  if (!hasCoordinates) return { webUrl, mapsUrl: `yandexmaps://maps.yandex.ru/?${params.toString()}`, navigatorUrl: "" };
  const routeParams = new URLSearchParams({ lat_to: String(lat), lon_to: String(lon) });
  return {
    webUrl,
    mapsUrl: `yandexmaps://build_route_on_map/?${routeParams.toString()}`,
    navigatorUrl: `yandexnavi://build_route_on_map?${routeParams.toString()}`,
  };
}

const ROUTE_META = {
  "/": { title: "Дашборд", icon: Home },
  "/projects": { title: "Проекты", icon: FolderKanban },
  "/calculator": { title: "Калькулятор", icon: Calculator },
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
  const [hiddenMenuSections, setHiddenMenuSections] = useState(() => getUser()?.workspace?.hidden_menu_sections || []);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [globalQuery, setGlobalQuery] = useState("");
  const [globalResults, setGlobalResults] = useState([]);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [visitProjects, setVisitProjects] = useState([]);
  const [visitProjectId, setVisitProjectId] = useState(consumePendingVisitProjectId);

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const me = await fetchMe();
        if (active) {
          setUser(me);
          setHiddenMenuSections(me?.workspace?.hidden_menu_sections || []);
        }
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
  const hiddenMenuSectionSet = useMemo(() => new Set(hiddenMenuSections), [hiddenMenuSections]);

  useEffect(() => {
    function handleMenuSettingsUpdated(event) {
      setHiddenMenuSections(event.detail?.hidden_sections || []);
    }

    window.addEventListener("crm-menu-settings-updated", handleMenuSettingsUpdated);
    return () => window.removeEventListener("crm-menu-settings-updated", handleMenuSettingsUpdated);
  }, []);

  useEffect(() => {
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
  }, [globalQuery]);

  useEffect(() => {
    if (!new URLSearchParams(location.search).has("visit")) {
      localStorage.setItem("crm_last_screen", location.pathname);
    }
  }, [location.pathname, location.search]);

  useEffect(() => {
    function handleVisitProject(event) {
      const projectId = event.detail?.projectId;
      if (!projectId) return;
      localStorage.removeItem(PENDING_VISIT_KEY);
      setVisitProjectId(String(projectId));
    }
    window.addEventListener("cehcrm:visit-project", handleVisitProject);
    return () => window.removeEventListener("cehcrm:visit-project", handleVisitProject);
  }, []);

  useEffect(() => {
    if (!window.CEHCRMNative?.capabilities?.visitAlerts) return undefined;
    let active = true;
    const sync = () => {
      if (document.visibilityState === "hidden") return;
      void fetchProjects().then((projects) => {
        if (active) {
          setVisitProjects(projects);
          syncNativeVisitLocations(projects);
        }
      }).catch((error) => {
        if (active && error?.response?.status === 401) {
          clearNativeVisitLocations();
        }
      });
    };
    sync();
    const interval = window.setInterval(sync, 5 * 60 * 1000);
    document.addEventListener("visibilitychange", sync);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  const visitProject = visitProjects.find((project) => String(project.id) === String(visitProjectId)) || null;

  function closeVisitCard() {
    localStorage.removeItem(PENDING_VISIT_KEY);
    setVisitProjectId(null);
  }

  function openVisitRoute() {
    const links = visitRouteLinks(visitProject);
    if (!links) return;
    if (!openNativeYandexRoute(links)) window.open(links.webUrl, "_blank", "noopener,noreferrer");
  }

  function logout() {
    clearNativeVisitLocations();
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
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        <div className="flex h-16 shrink-0 items-center gap-3 overflow-hidden border-b border-slate-100 px-4">
          <BrandMark className="h-10 w-10" />
          <div className="min-w-0 max-w-40 opacity-100 transition-all duration-200 md:max-w-0 md:opacity-0 md:group-hover/sidebar:max-w-40 md:group-hover/sidebar:opacity-100">
            <div className="truncate text-sm font-black uppercase tracking-tight text-slate-950">Цех CRM</div>
            <div className="truncate text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">проекты и финансы</div>
          </div>
        </div>

        <nav className="mt-4 flex flex-1 flex-col px-3">
          {!hiddenMenuSectionSet.has("dashboard") && <NavItem to="/" icon={Home} label="Дашборд" onClick={closeSidebar} />}
          <NavItem to="/projects" icon={FolderKanban} label="Проекты" onClick={closeSidebar} />
          {!hiddenMenuSectionSet.has("calculator") && <NavItem to="/calculator" icon={Calculator} label="Калькулятор" onClick={closeSidebar} />}
          {!hiddenMenuSectionSet.has("chats") && <NavItem to="/chats" icon={MessageCircle} label="Чаты" onClick={closeSidebar} />}
          {isAdmin && !hiddenMenuSectionSet.has("finances") && <NavItem to="/finances" icon={Wallet} label="Финансы" onClick={closeSidebar} />}
          {!hiddenMenuSectionSet.has("tasks") && <NavItem to="/tasks" icon={ListTodo} label="Задачи" onClick={closeSidebar} />}
          {!hiddenMenuSectionSet.has("clients") && <NavItem to="/clients" icon={Users} label="Клиенты" onClick={closeSidebar} />}
          {isAdmin && !hiddenMenuSectionSet.has("requests") && <NavItem to="/requests" icon={ShieldQuestion} label="Запросы" onClick={closeSidebar} />}
          {isAdmin && <NavItem to="/settings" icon={Settings} label="Система" onClick={closeSidebar} />}
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

            <div id="crm-header-action" className="ml-auto flex shrink-0 items-center" />

        </header>

        <main className={`no-scrollbar relative min-h-0 flex-1 overflow-auto ${location.pathname === "/calculator" ? "p-0" : "p-4 sm:p-6"}`}>{children}</main>
      </div>

      <Modal open={Boolean(visitProject)} title="Карточка выезда" onClose={closeVisitCard} widthClassName="max-w-lg">
        {visitProject ? (
          <div className="space-y-5">
            <div>
              <div className="text-xl font-black text-slate-900">
                {visitProject.order_number_label ? `№${visitProject.order_number_label} · ` : ""}{visitProject.title}
              </div>
              <div className="mt-2 text-sm font-semibold text-slate-500">{visitProject.client_name || "Клиент не указан"}</div>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-700">
              <div className="font-bold">{visitProject.object_address}</div>
              {[visitProject.entrance && `Подъезд ${visitProject.entrance}`, visitProject.floor && `Этаж ${visitProject.floor}`, visitProject.apartment && `Квартира ${visitProject.apartment}`].filter(Boolean).length ? (
                <div className="mt-2 text-slate-500">
                  {[visitProject.entrance && `Подъезд ${visitProject.entrance}`, visitProject.floor && `Этаж ${visitProject.floor}`, visitProject.apartment && `Квартира ${visitProject.apartment}`].filter(Boolean).join(" · ")}
                </div>
              ) : null}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {visitProject.client_phone ? (
                <a className="btn-hover inline-flex items-center justify-center gap-2 rounded-full border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-700" href={`tel:${String(visitProject.client_phone).replace(/[^\d+]/g, "")}`}>
                  <Phone size={16} />Позвонить
                </a>
              ) : null}
              <Button type="button" variant="secondary" onClick={openVisitRoute}><MapPin size={16} />Маршрут</Button>
            </div>
            <Button type="button" className="w-full" onClick={() => {
              closeVisitCard();
              navigate("/projects", { state: { projectId: visitProject.id, tab: "comments" } });
            }}>Открыть проект</Button>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
