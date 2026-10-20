import { TaskLocation, TaskLocationFields } from "../components/TaskLocation.jsx";
import React, { useEffect, useMemo, useState } from "react";
import { Archive, Calendar, Check, FolderKanban, ListTodo, Plus, Trash2 } from "lucide-react";

import { createTask, deleteTask, extractApiErrorMessage, fetchTasks, updateTask } from "../api";
import { Button, Card, CardBody, CardHeader, HeaderAddButton, Input, Label, Modal, PageHeaderAction, Select } from "../components/ui.jsx";

const PRIORITIES = {
  high: { label: "Высокий", className: "bg-red-50 text-red-600 ring-red-100", rank: 0 },
  medium: { label: "Обычный", className: "bg-amber-50 text-amber-700 ring-amber-100", rank: 1 },
  low: { label: "Низкий", className: "bg-slate-100 text-slate-500 ring-slate-200", rank: 2 },
};

function formatDeadline(date) {
  if (!date) return "";
  return new Date(date).toLocaleDateString("ru-RU", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function TaskRow({ task, children = [], onToggle, onDelete, onEdit, onAddSubtask }) {
  const priority = PRIORITIES[task.priority] || PRIORITIES.medium;
  return (
    <div
      className={`flex items-start gap-4 rounded-2xl p-4 transition ${
        task.status === "done" ? "bg-green-50 text-gray-400 line-through" : "bg-gray-50 text-gray-900 hover:bg-gray-100"
      }`}
    >
      <button
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 ${
          task.status === "done" ? "border-emerald-500 bg-emerald-500 text-white" : "border-slate-300 text-transparent"
        }`}
        onClick={() => onToggle(task)}
        type="button"
      >
        <Check size={14} />
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <div className="font-semibold">{task.title}</div>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ring-1 ${priority.className}`}>{priority.label}</span>
        </div>
        {onEdit && <button type="button" className="text-xs font-semibold text-blue-600" onClick={() => onEdit(task)}>Изменить задачу</button>}
        {task.parent_task && <div className="mt-1 text-xs text-blue-600">Подзадача: {task.parent_title}</div>}
        {children.length > 0 && <div className="mt-2 rounded-xl bg-white px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200">
          <div className="font-bold">Подзадачи: {children.filter(child => child.status === "done").length}/{children.length}</div>
          {children.map(child => <div key={child.id} className="mt-1">{child.status === "done" ? "✓" : "○"} {child.title}</div>)}
        </div>}
        {onAddSubtask && <button type="button" className="mt-2 text-xs font-semibold text-blue-600" onClick={() => onAddSubtask(task)}>+ Подзадача</button>}
        {task.notes && <div className="mt-1 text-sm text-gray-500">{task.notes}</div>}
        <TaskLocation task={task} />
        {task.project_title && (
          <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-bold text-blue-600">
            <FolderKanban size={12} />
            {task.project_title}
          </div>
        )}
        {task.due_date && (
          <div className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-amber-600">
            <Calendar size={12} />
            {formatDeadline(task.due_date)}
          </div>
        )}
      </div>

      <button className="text-slate-400 transition hover:text-red-500" onClick={() => onDelete(task.id)} type="button">
        <Trash2 size={16} />
      </button>
    </div>
  );
}

function taskCount(count) {
  const last = count % 10;
  const teen = count % 100 >= 11 && count % 100 <= 14;
  return `${count} ${teen ? "задач" : last === 1 ? "задача" : last >= 2 && last <= 4 ? "задачи" : "задач"}`;
}

function DaySection({ date, today, tomorrow, tasks, allTasks, onToggle, onDelete, onEdit, onAddSubtask }) {
  const isToday = date === today;
  const overdue = date && date < today;
  const zones = tasks.reduce((groups, task) => {
    const zone = [task.city, task.district].filter(Boolean).join(" · ") || "Место не указано";
    (groups[zone] ||= []).push(task);
    return groups;
  }, {});
  const heading = date ? new Date(`${date}T12:00:00`).toLocaleDateString("ru-RU", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  }) : "Без даты";
  const badge = isToday ? "Сегодня" : date === tomorrow ? "Завтра" : overdue ? "Просрочено" : "";

  return (
    <section className={`overflow-hidden rounded-2xl border ${isToday ? "border-blue-300 ring-2 ring-blue-50" : "border-slate-200"}`}>
      <div className={`flex flex-wrap items-center justify-between gap-3 border-b px-4 py-4 sm:px-5 ${isToday ? "border-blue-100 bg-blue-50" : "border-slate-100 bg-slate-50"}`}>
        <div className="min-w-0">
          {badge && <div className={`mb-1 text-xs font-black uppercase tracking-wider ${overdue ? "text-red-600" : "text-blue-600"}`}>{badge}</div>}
          <h3 className="text-base font-black capitalize text-slate-900 sm:text-lg">{heading}</h3>
        </div>
        <span className="rounded-full bg-white px-3 py-1 text-xs font-bold text-slate-600 ring-1 ring-slate-200">{taskCount(tasks.length)}</span>
      </div>
      <div className="space-y-5 bg-white p-3 sm:p-5">
        {tasks.length ? Object.entries(zones).sort(([a], [b]) => a.localeCompare(b, "ru")).map(([zone, rows]) => (
          <div key={zone} className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-sm font-bold text-slate-600">
              <span>{zone}</span><span className="text-xs font-medium text-slate-400">{taskCount(rows.length)}</span>
            </div>
            {[...rows].sort((a, b) => (PRIORITIES[a.priority]?.rank ?? 1) - (PRIORITIES[b.priority]?.rank ?? 1)).map(task => <TaskRow key={task.id} task={task} children={allTasks.filter(child => child.parent_task === task.id)} onToggle={onToggle} onDelete={onDelete} onEdit={onEdit} onAddSubtask={onAddSubtask} />)}
          </div>
        )) : <div className="px-1 py-3 text-sm text-slate-400">На сегодня задач пока нет.</div>}
      </div>
    </section>
  );
}

export default function Tasks() {
  const [location, setLocation] = useState({});
  const [editingId, setEditingId] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [text, setText] = useState("");
  const [notes, setNotes] = useState("");
  const [deadline, setDeadline] = useState("");
  const [priority, setPriority] = useState("medium");
  const [parentTask, setParentTask] = useState("");
  const [projectId, setProjectId] = useState(null);
  const [showArchive, setShowArchive] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function reloadTasks() {
    const rows = await fetchTasks();
    setTasks(rows);
  }

  useEffect(() => {
    reloadTasks().catch(() => {
      setTasks([]);
      setError("Не удалось загрузить задачи.");
    });
  }, []);

  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(new Date());
  const tomorrowDate = new Date(`${today}T12:00:00Z`);
  tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
  const tomorrow = tomorrowDate.toISOString().slice(0, 10);
  const grouped = useMemo(() => {
    const days = { [today]: [] };
    const archive = [];
    const undated = [];
    for (const task of tasks) {
      if (task.status === "done") {
        archive.push(task);
      } else {
        const date = task.scheduled_date || task.due_date;
        if (date) (days[date] ||= []).push(task);
        else undated.push(task);
      }
    }
    return { days: Object.entries(days).sort(([a], [b]) => a.localeCompare(b)), archive, undated };
  }, [tasks, today]);

  async function addTask(event) {
    event.preventDefault();
    if (!text.trim()) return;

    setError("");
    setSaving(true);

    try {
      const payload = {
        title: text.trim(),
        notes: notes.trim(),
        due_date: deadline || null,
        priority,
        parent_task: parentTask ? Number(parentTask) : null,
        project: projectId,
        ...location,
        scheduled_date: location.scheduled_date || null,
      };
      const created = editingId ? await updateTask(editingId, payload) : await createTask(payload);

      await reloadTasks();
      setEditingId(null);
      setLocation({});
      setText("");
      setNotes("");
      setDeadline("");
      setPriority("medium");
      setParentTask("");
      setProjectId(null);
      setShowCreate(false);
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось создать задачу."));
    } finally {
      setSaving(false);
    }
  }

  function editTask(task) {
    setEditingId(task.id);
    setText(task.title);
    setNotes(task.notes || "");
    setDeadline(task.due_date || "");
    setPriority(task.priority || "medium");
    setParentTask(task.parent_task ? String(task.parent_task) : "");
    setProjectId(task.project || null);
    setLocation({ city: task.city || "", district: task.district || "", address: task.address || "", scheduled_date: task.scheduled_date || "" });
    setShowCreate(true);
  }

  function openTaskCreate() {
    setEditingId(null);
    setText("");
    setNotes("");
    setDeadline("");
    setPriority("medium");
    setParentTask("");
    setProjectId(null);
    setLocation({});
    setShowArchive(false);
    setShowCreate(true);
  }

  function closeTaskCreate() {
    setEditingId(null);
    setText("");
    setNotes("");
    setDeadline("");
    setPriority("medium");
    setParentTask("");
    setProjectId(null);
    setLocation({});
    setShowCreate(false);
  }

  function addSubtask(task) {
    openTaskCreate();
    setParentTask(String(task.id));
    setProjectId(task.project || null);
    setPriority(task.priority);
    setDeadline(task.due_date || "");
    setLocation({ scheduled_date: task.scheduled_date || "" });
  }

  async function toggleTask(task) {
    try {
      const updated = await updateTask(task.id, {
        status: task.status === "done" ? "open" : "done",
      });
      await reloadTasks();
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось обновить задачу."));
    }
  }

  async function removeTask(taskId) {
    try {
      await deleteTask(taskId);
      await reloadTasks();
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось удалить задачу."));
    }
  }

  async function clearArchive() {
    const archiveIds = grouped.archive.map((task) => task.id);
    if (!archiveIds.length) return;

    try {
      await Promise.all(archiveIds.map((taskId) => deleteTask(taskId)));
      await reloadTasks();
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось очистить архив."));
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeaderAction>
        <HeaderAddButton label="Добавить задачу" onClick={openTaskCreate} />
      </PageHeaderAction>

      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-xl font-black text-gray-800">
          <ListTodo size={20} className="text-blue-500" />
          План задач по дням
        </h2>
        <Button variant="secondary" onClick={() => setShowArchive((value) => !value)}>
          <Archive size={16} />
          {showArchive ? "К списку задач" : "Архив"}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="text-lg font-black tracking-tight text-gray-900">
              {showArchive ? "Архив задач" : "Задачи"}
            </div>
            <div className="text-sm font-semibold text-gray-400">{tasks.length} всего</div>
          </div>
        </CardHeader>
        <CardBody className="space-y-6">
          {error && <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

          {showArchive ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-black uppercase tracking-[0.24em] text-slate-400">Архив</div>
                {grouped.archive.length > 0 && (
                  <button className="text-xs font-bold text-red-500" onClick={clearArchive} type="button">
                    Очистить архив
                  </button>
                )}
              </div>
              <div className="space-y-3">
                {grouped.archive.length > 0 ? (
                  grouped.archive.map((task) => (
                    <TaskRow key={task.id} task={task} children={tasks.filter(child => child.parent_task === task.id)} onToggle={toggleTask} onDelete={removeTask} onEdit={editTask} onAddSubtask={addSubtask} />
                  ))
                ) : (
                    <div className="rounded-2xl bg-gray-50 px-5 py-8 text-center text-sm text-gray-400">
                    В архиве пока нет задач.
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-8">
              {grouped.days.map(([date, rows]) => (
                <DaySection key={date} date={date} today={today} tomorrow={tomorrow} tasks={rows} allTasks={tasks} onToggle={toggleTask} onDelete={removeTask} onEdit={editTask} onAddSubtask={addSubtask} />
              ))}
              {grouped.undated.length > 0 && <DaySection today={today} tomorrow={tomorrow} tasks={grouped.undated} allTasks={tasks} onToggle={toggleTask} onDelete={removeTask} onEdit={editTask} onAddSubtask={addSubtask} />}
            </div>
          )}
        </CardBody>
      </Card>

      <Modal
        open={showCreate}
        title={editingId ? "Изменить задачу" : "Новая задача"}
        onClose={closeTaskCreate}
        widthClassName="max-w-2xl"
        mobileSheet
      >
        <form className="grid gap-4 md:grid-cols-2" onSubmit={addTask}>
          <div className="space-y-2 md:col-span-2">
            <Label>Наименование задачи</Label>
            <Input value={text} onChange={(event) => setText(event.target.value)} placeholder="Что нужно сделать?" />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label>Комментарий</Label>
            <Input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Краткое описание или следующий шаг" />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label>Основная задача</Label>
            <Select value={parentTask} onChange={event => setParentTask(event.target.value)}>
              <option value="">Самостоятельная задача</option>
              {tasks.filter(task => task.id !== editingId && task.project === projectId && task.status !== "done").map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Крайний срок</Label>
            <Input type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Приоритет</Label>
            <Select value={priority} onChange={(event) => setPriority(event.target.value)}>
              <option value="high">Высокий</option>
              <option value="medium">Обычный</option>
              <option value="low">Низкий</option>
            </Select>
          </div>
          <TaskLocationFields value={location} onChange={patch => setLocation(prev => ({ ...prev, ...patch }))} />
          {error ? <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700 md:col-span-2">{error}</div> : null}
          <div className="flex items-end gap-2 md:col-span-2 md:justify-end">
            <Button className="w-full md:w-auto" disabled={saving} type="submit">
              <Plus size={16} />
              {saving ? "Сохраняем..." : editingId ? "Сохранить изменения" : "Добавить задачу"}
            </Button>
            {editingId ? <Button type="button" variant="secondary" onClick={closeTaskCreate}>Отмена</Button> : null}
          </div>
        </form>
      </Modal>
    </div>
  );
}
