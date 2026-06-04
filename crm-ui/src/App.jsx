import React, { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { fetchBillingSummary, fetchMe, getBillingSummary, getToken, getUser, initApiAuth, isAdminUser } from "./api";
import Layout from "./components/Layout";
import Assistant from "./pages/Assistant";
import Clients from "./pages/Clients";
import Dashboard from "./pages/Dashboard";
import Finances from "./pages/Finances";
import Login from "./pages/Login";
import Projects from "./pages/Projects";
import Requests from "./pages/Requests";
import Settings from "./pages/Settings";
import Subscription from "./pages/Subscription";
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

function SubscriptionOnly({ children }) {
  const cachedSummary = getBillingSummary();
  const [allowed, setAllowed] = useState(() => isAdminUser(getUser()) || Boolean(cachedSummary?.subscription?.is_active_now));
  const [loading, setLoading] = useState(() => Boolean(getToken()));

  useEffect(() => {
    let active = true;

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
        if (isAdminUser(me)) {
          setAllowed(true);
          return;
        }

        const summary = await fetchBillingSummary();
        if (!active) return;
        setAllowed(Boolean(summary?.subscription?.is_active_now));
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
  if (!allowed) return <Navigate to="/billing" replace />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/billing"
          element={
            <Private>
              <Subscription />
            </Private>
          }
        />
        <Route
          path="/assistant"
          element={
            <Private>
              <SubscriptionOnly>
                <Layout>
                  <Assistant />
                </Layout>
              </SubscriptionOnly>
            </Private>
          }
        />
        <Route
          path="/"
          element={
            <Private>
              <SubscriptionOnly>
                <Layout>
                  <Dashboard />
                </Layout>
              </SubscriptionOnly>
            </Private>
          }
        />
        <Route
          path="/projects"
          element={
            <Private>
              <SubscriptionOnly>
                <Layout>
                  <Projects />
                </Layout>
              </SubscriptionOnly>
            </Private>
          }
        />
        <Route
          path="/finances"
          element={
            <Private>
              <SubscriptionOnly>
                <AdminOnly>
                  <Layout>
                    <Finances />
                  </Layout>
                </AdminOnly>
              </SubscriptionOnly>
            </Private>
          }
        />
        <Route
          path="/clients"
          element={
            <Private>
              <SubscriptionOnly>
                <Layout>
                  <Clients />
                </Layout>
              </SubscriptionOnly>
            </Private>
          }
        />
        <Route
          path="/tasks"
          element={
            <Private>
              <SubscriptionOnly>
                <Layout>
                  <Tasks />
                </Layout>
              </SubscriptionOnly>
            </Private>
          }
        />
        <Route
          path="/requests"
          element={
            <Private>
              <SubscriptionOnly>
                <AdminOnly>
                  <Layout>
                    <Requests />
                  </Layout>
                </AdminOnly>
              </SubscriptionOnly>
            </Private>
          }
        />
        <Route
          path="/settings"
          element={
            <Private>
              <SubscriptionOnly>
                <AdminOnly>
                  <Layout>
                    <Settings />
                  </Layout>
                </AdminOnly>
              </SubscriptionOnly>
            </Private>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
