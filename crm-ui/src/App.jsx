import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { initApiAuth, getToken } from "./api";

import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Projects from "./pages/Projects";
import Commissions from "./pages/Commissions";
import Layout from "./components/Layout";

initApiAuth();

function Private({ children }) {
  const token = getToken();
  if (!token) return <Navigate to="/login" replace />;
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
          path="/commissions"
          element={
            <Private>
              <Layout>
                <Commissions />
              </Layout>
            </Private>
          }
        />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
