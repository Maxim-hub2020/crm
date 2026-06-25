import React, { useEffect, useMemo, useState } from "react";
import { Calendar, FolderKanban, ListTodo, Layers } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { fetchProjectStatuses, fetchProjects, fetchTasks } from "../api";

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("ru-RU");
}

function projectAge(project) {
  const source = project.updated_at || project.created_at;
  if (!source) return 0;
  const date = new Date(source);
  if (Number.isNaN(date.getTime())) return 0;
  return Math.max(0, Math.ceil((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24)));
}

function projectDisplayName(project) {
  return project?.title || project?.client_name || `Проект #${project?.id || ""}`;
}

function Panel({ icon: Icon, iconClassName, title, children }) {
  return (
    <div>
      <h2 className="mb-4 flex items-center gap-2 text-xl font-black text-gray-800">
        <Icon size={20} className={iconClassName} />
        {title}
      </h2>
      <div className="space-y-3 rounded-[32px] bg-white p-4 shadow-lg">{children}</div>
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [statuses, setStatuses] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const [projectRows, taskRows, statusRows] = await Promise.all([fetchProjects(), fetchTasks(), fetchProjectStatuses()]);
        setProjects(projectRows);
        setTasks(taskRows);
        setStatuses(statusRows);
      } catch {
        setProjects([]);
        setTasks([]);
        setStatuses([]);
      }
    })();
  }, []);

  const terminalStatusCode = statuses[statuses.length - 1]?.code || "";
  const statusMap = useMemo(() => new Map(statuses.map((status) => [status.code, status])), [statuses]);

  const stuckProjects = useMemo(() => {
    return projects
      .filter((project) => {
        if (project.status === terminalStatusCode || project.status === "closed" || project.status === "canceled") {
          return false;
        }
        const stuckAfterDays = Number(statusMap.get(project.status)?.stuck_after_days || 5);
        return projectAge(project) >= stuckAfterDays;
      })
      .sort((left, right) => projectAge(right) - projectAge(left))
      .slice(0, 8);
  }, [projects, statusMap, terminalStatusCode]);

  const upcomingTasks = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const nextWeek = new Date(today);
    nextWeek.setDate(nextWeek.getDate() + 7);

    return tasks
      .filter((task) => {
        if (task.status === "done" || !task.due_date) return false;
        const dueDate = new Date(task.due_date);
        dueDate.setHours(0, 0, 0, 0);
        return dueDate <= nextWeek;
      })
      .sort((left, right) => new Date(left.due_date) - new Date(right.due_date))
      .slice(0, 8);
  }, [tasks]);

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
      <Panel icon={Layers} iconClassName="text-orange-500" title="Зависшие проекты">
        {stuckProjects.length > 0 ? (
          stuckProjects.map((project) => (
            <button
              key={project.id}
              type="button"
              onClick={() => navigate("/projects", { state: { projectId: project.id, tab: "comments" } })}
              className="w-full rounded-2xl bg-gray-50 p-4 text-left transition hover:bg-gray-100"
            >
              <h4 className="font-bold text-gray-800">{projectDisplayName(project)}</h4>
              <p className="mt-1 text-xs text-gray-500">{project.client_name || "Клиент не указан"}</p>
              <p className="mt-1 text-xs text-gray-500">{project.object_address || "Адрес не указан"}</p>
              <p className="mt-1 text-xs font-semibold text-red-500">
                Без изменений {projectAge(project)} дн. • {formatDate(project.updated_at || project.created_at)}
              </p>
            </button>
          ))
        ) : (
          <p className="p-8 text-center text-gray-400">Нет проектов, требующих внимания.</p>
        )}
      </Panel>

      <Panel icon={ListTodo} iconClassName="text-blue-500" title="Ближайшие задачи">
        {upcomingTasks.length > 0 ? (
          upcomingTasks.map((task) => (
            <div key={task.id} className="rounded-2xl bg-gray-50 p-4">
              <p className="font-semibold text-gray-800">{task.title}</p>
              {task.notes && <p className="mt-1 text-sm text-gray-500">{task.notes}</p>}
              <div className="mt-2 flex items-center gap-1.5 text-xs font-bold text-amber-600">
                <Calendar size={12} />
                Срок: {formatDate(task.due_date)}
              </div>
            </div>
          ))
        ) : (
          <p className="p-8 text-center text-gray-400">Нет задач на ближайшее время.</p>
        )}
      </Panel>

      <div className="rounded-[32px] bg-white p-5 shadow-lg lg:col-span-2">
        <div className="flex flex-wrap items-center gap-4 text-sm text-gray-500">
          <div className="flex items-center gap-2 font-semibold text-gray-800">
            <FolderKanban size={18} className="text-blue-600" />
            Проектов: {projects.length}
          </div>
          <div className="flex items-center gap-2 font-semibold text-gray-800">
            <ListTodo size={18} className="text-blue-600" />
            Задач: {tasks.length}
          </div>
        </div>
      </div>
    </div>
  );
}
