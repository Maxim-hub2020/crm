import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardHeader, CardBody, Button, Input } from "../components/ui";
import { login, fetchMe } from "../api";

export default function Login() {
  const nav = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");

  async function onSubmit(e) {
    e.preventDefault();
    setErr("");
    try {
      await login(username, password);
      await fetchMe();
      nav("/");
    } catch {
      setErr("Неверный логин или пароль");
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="mx-auto flex min-h-screen max-w-7xl items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="text-sm text-zinc-500">Вход</div>
            <div className="text-xl font-semibold">CRM — проекты и комиссии</div>
          </CardHeader>
          <CardBody>
            <form className="space-y-4" onSubmit={onSubmit}>
              <div>
                <div className="mb-2 text-sm text-zinc-600">Логин</div>
                <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" />
              </div>
              <div>
                <div className="mb-2 text-sm text-zinc-600">Пароль</div>
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
              </div>

              {err && <div className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{err}</div>}

              <Button className="w-full" type="submit">
                Войти
              </Button>

              <div className="text-xs text-zinc-500">
                Backend: http://localhost:8000 • UI: http://localhost:5173
              </div>
            </form>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
