import React, { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { fetchMe, getToken, getUser, initApiAuth, isAdminUser } from "./api";
import Layout from "./components/Layout";
import Chats from "./pages/Chats";
import Clients from "./pages/Clients";
import Dashboard from "./pages/Dashboard";
import Finances from "./pages/Finances";
import Login from "./pages/Login";
import Projects from "./pages/Projects";
import Requests from "./pages/Requests";
import Settings from "./pages/Settings";
import Tasks from "./pages/Tasks";

initApiAuth();

function Private({ children }) {
  const token = getToken();
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

function AdminOnly({ children }) {
  const [allowed, setAllowed] = useState(() => isAdminUser(getUser()));
  const [loading, setLoading] = useState(() => !isAdminUser(getUser()) && Boolean(getToken()));

  useEffect(() => {
    let active = true;
    const currentUser = getUser();

    if (isAdminUser(currentUser)) {
      setAllowed(true);
      setLoading(false);
      return () => {
        active = false;
      };
    }

    if (!getToken()) {
      setAllowed(false);
      setLoading(false);
      return () => {
        active = false;
      };
    }

    (async () => {
      try {
        const me = await fetchMe();
        if (!active) return;
        setAllowed(isAdminUser(me));
      } catch {
        if (!active) return;
        setAllowed(false);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  if (loading) return <div className="app-screen bg-[#f5f5f7]" />;
  if (!allowed) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <Private>
              <Layout>
                <Dashboard />
              </Layout>
            </Private>
          }
        />
        <Route
          path="/projects"
          element={
            <Private>
              <Layout>
                <Projects />
              </Layout>
            </Private>
          }
        />
        <Route
          path="/chats"
          element={
            <Private>
              <Layout>
                <Chats />
              </Layout>
            </Private>
          }
        />
        <Route
          path="/finances"
          element={
            <Private>
              <AdminOnly>
                <Layout>
                  <Finances />
                </Layout>
              </AdminOnly>
            </Private>
          }
        />
        <Route
          path="/clients"
          element={
            <Private>
              <Layout>
                <Clients />
              </Layout>
            </Private>
          }
        />
        <Route
          path="/tasks"
          element={
            <Private>
              <Layout>
                <Tasks />
              </Layout>
            </Private>
          }
        />
        <Route
          path="/requests"
          element={
            <Private>
              <AdminOnly>
                <Layout>
                  <Requests />
                </Layout>
              </AdminOnly>
            </Private>
          }
        />
        <Route
          path="/settings"
          element={
            <Private>
              <AdminOnly>
                <Layout>
                  <Settings />
                </Layout>
              </AdminOnly>
            </Private>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
