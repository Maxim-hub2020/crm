import React, { useEffect, useMemo, useState } from "react";
import { Archive, Calendar, Check, FolderKanban, ListTodo, Plus, Trash2 } from "lucide-react";

import { createTask, deleteTask, extractApiErrorMessage, fetchTasks, updateTask } from "../api";
import { Button, Card, CardBody, CardHeader, Input, Label } from "../components/ui.jsx";

function formatDeadline(date) {
  if (!date) return "";
  return new Date(date).toLocaleDateString("ru-RU", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function TaskRow({ task, onToggle, onDelete }) {
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
        <div className="font-semibold">{task.title}</div>
        {task.notes && <div className="mt-1 text-sm text-gray-500">{task.notes}</div>}
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

function TaskSection({ title, tasks, onToggle, onDelete }) {
  if (!tasks.length) return null;

  return (
    <div className="space-y-4">
      <div className="text-[11px] font-black uppercase tracking-widest text-gray-400">{title}</div>
      <div className="space-y-3">
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} onToggle={onToggle} onDelete={onDelete} />
        ))}
      </div>
    </div>
  );
}

export default function Tasks() {
  const [tasks, setTasks] = useState([]);
  const [text, setText] = useState("");
  const [notes, setNotes] = useState("");
  const [deadline, setDeadline] = useState("");
  const [showArchive, setShowArchive] = useState(false);
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

  const grouped = useMemo(() => {
    const today = [];
    const soon = [];
    const later = [];
    const archive = [];

    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const inSevenDays = new Date(now);
    inSevenDays.setDate(inSevenDays.getDate() + 7);

    for (const task of tasks) {
      if (task.status === "done") {
        archive.push(task);
        continue;
      }

      if (!task.due_date) {
        later.push(task);
        continue;
      }

      const taskDate = new Date(task.due_date);
      taskDate.setHours(0, 0, 0, 0);

      if (taskDate <= now) {
        today.push(task);
      } else if (taskDate <= inSevenDays) {
        soon.push(task);
      } else {
        later.push(task);
      }
    }

    return { today, soon, later, archive, tomorrow };
  }, [tasks]);

  async function addTask(event) {
    event.preventDefault();
    if (!text.trim()) return;

    setError("");
    setSaving(true);

    try {
      const created = await createTask({
        title: text.trim(),
        notes: notes.trim(),
        due_date: deadline || null,
      });

      setTasks((current) => [created, ...current]);
      setText("");
      setNotes("");
      setDeadline("");
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось создать задачу."));
    } finally {
      setSaving(false);
    }
  }

  async function toggleTask(task) {
    try {
      const updated = await updateTask(task.id, {
        status: task.status === "done" ? "open" : "done",
      });
      setTasks((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось обновить задачу."));
    }
  }

  async function removeTask(taskId) {
    try {
      await deleteTask(taskId);
      setTasks((current) => current.filter((task) => task.id !== taskId));
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось удалить задачу."));
    }
  }

  async function clearArchive() {
    const archiveIds = grouped.archive.map((task) => task.id);
    if (!archiveIds.length) return;

    try {
      await Promise.all(archiveIds.map((taskId) => deleteTask(taskId)));
      setTasks((current) => current.filter((task) => task.status !== "done"));
    } catch (requestError) {
      setError(extractApiErrorMessage(requestError, "Не удалось очистить архив."));
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-xl font-black text-gray-800">
          <ListTodo size={20} className="text-blue-500" />
          Общий список задач
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
              {showArchive ? "Архив задач" : "Новая задача"}
            </div>
            <div className="text-sm font-semibold text-gray-400">{tasks.length} всего</div>
          </div>
        </CardHeader>
        <CardBody className="space-y-6">
          {!showArchive && (
            <form className="grid gap-4 rounded-2xl bg-gray-50 p-4 md:grid-cols-2" onSubmit={addTask}>
              <div className="space-y-2 md:col-span-2">
                <Label>Новая задача</Label>
                <Input value={text} onChange={(event) => setText(event.target.value)} placeholder="Что нужно сделать?" />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>Комментарий</Label>
                <Input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Краткое описание или следующий шаг" />
              </div>
              <div className="space-y-2">
                <Label>Срок</Label>
                <Input type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)} />
              </div>
              <div className="flex items-end">
                <Button className="w-full md:w-auto" disabled={saving} type="submit">
                  <Plus size={16} />
                  {saving ? "Добавляем..." : "Добавить"}
                </Button>
              </div>
            </form>
          )}

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
                    <TaskRow key={task.id} task={task} onToggle={toggleTask} onDelete={removeTask} />
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
              <TaskSection title="Сегодня" tasks={grouped.today} onToggle={toggleTask} onDelete={removeTask} />
              <TaskSection title="В ближайшие 7 дней" tasks={grouped.soon} onToggle={toggleTask} onDelete={removeTask} />
              <TaskSection title="Позже" tasks={grouped.later} onToggle={toggleTask} onDelete={removeTask} />
              {!grouped.today.length && !grouped.soon.length && !grouped.later.length && (
                <div className="rounded-2xl bg-gray-50 px-5 py-8 text-center text-sm text-gray-400">
                  Добавьте первую задачу, чтобы раздел начал работать.
                </div>
              )}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
