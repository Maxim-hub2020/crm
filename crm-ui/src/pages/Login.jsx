import React, { useState } from "react";
import { Briefcase } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { fetchBillingSummary, fetchMe, login } from "../api";
import { Input } from "../components/ui.jsx";

export default function Login() {
  const nav = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setErr("");
    setLoading(true);

    try {
      await login(username, password);
      await fetchMe();
      const billing = await fetchBillingSummary();
      nav(billing?.subscription?.is_active_now ? "/" : "/billing");
    } catch {
      setErr("Неверный логин или пароль");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-[#F5F5F7] p-4">
      <div className="w-full max-w-sm rounded-3xl bg-white p-8 shadow-2xl ring-1 ring-black/5 sm:rounded-[40px] sm:p-10">
        <div className="mb-6 flex justify-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-black text-white shadow-lg">
            <Briefcase size={32} />
          </div>
        </div>

        {err && <div className="mb-4 rounded-lg bg-red-100 p-4 text-center text-sm text-red-800">{err}</div>}

        <form className="space-y-4" onSubmit={onSubmit}>
          <h3 className="text-center text-2xl font-bold tracking-tighter text-gray-800">Вход в систему</h3>
          <Input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Email" required />
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Пароль"
            required
          />
          <button
            className="w-full rounded-2xl bg-gray-900 py-4 text-xs font-bold uppercase tracking-widest text-white shadow-lg transition-all hover:bg-black disabled:opacity-60"
            disabled={loading}
            type="submit"
          >
            {loading ? "Входим..." : "Войти"}
          </button>
        </form>
      </div>
    </div>
  );
}
