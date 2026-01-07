import axios from "axios";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE,
});

const TOKEN_KEY = "crm_token";
const USER_KEY = "crm_user";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
  api.defaults.headers.common.Authorization = `Bearer ${token}`;
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  delete api.defaults.headers.common.Authorization;
}

export function setUser(user) {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getUser() {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? JSON.parse(raw) : null;
}

export function initApiAuth() {
  const t = getToken();
  if (t) api.defaults.headers.common.Authorization = `Bearer ${t}`;
}

export async function login(username, password) {
  const { data } = await api.post("/api/auth/token/", { username, password });
  setToken(data.access);
  return data;
}

export async function fetchMe() {
  const { data } = await api.get("/api/me/");
  setUser(data);
  return data;
}

export async function fetchProjects() {
  const { data } = await api.get("/api/projects/");
  return data;
}

export async function createProject(payload) {
  const { data } = await api.post("/api/projects/", payload);
  return data;
}

export async function fetchPayments() {
  const { data } = await api.get("/api/payments/");
  return data;
}

export async function createPayment(payload) {
  const { data } = await api.post("/api/payments/", payload);
  return data;
}

export async function fetchCommissions() {
  const { data } = await api.get("/api/commissions/");
  return data;
}

export async function fetchTop(periodMonthISO) {
  const { data } = await api.get(`/api/dashboard/top?period=${periodMonthISO}`);
  return data;
}

export default api;
