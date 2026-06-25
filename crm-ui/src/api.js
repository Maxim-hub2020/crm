import axios from "axios";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || "",
});

const TOKEN_KEY = "crm_token";
const REFRESH_TOKEN_KEY = "crm_refresh_token";
const USER_KEY = "crm_user";
const BILLING_KEY = "crm_billing_summary";
let refreshRequest = null;

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getAssistantLiveWebSocketUrl(options = {}) {
  const token = getToken();
  const configuredBase = import.meta.env.VITE_API_BASE || window.location.origin;
  const url = new URL(configuredBase, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/assistant/live/";
  url.search = "";
  if (token) {
    url.searchParams.set("token", token);
  }
  if (options.screen) {
    url.searchParams.set("screen", String(options.screen).slice(0, 120));
  }
  if (Array.isArray(options.history) && options.history.length) {
    url.searchParams.set("history", JSON.stringify(options.history.slice(-5)));
  }
  return url.toString();
}

export function getRefreshToken() {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
  api.defaults.headers.common.Authorization = `Bearer ${token}`;
}

export function setRefreshToken(token) {
  localStorage.setItem(REFRESH_TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(BILLING_KEY);
  delete api.defaults.headers.common.Authorization;
}

export function setUser(user) {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getUser() {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? JSON.parse(raw) : null;
}

export function setBillingSummary(summary) {
  localStorage.setItem(BILLING_KEY, JSON.stringify(summary));
}

export function getBillingSummary() {
  const raw = localStorage.getItem(BILLING_KEY);
  return raw ? JSON.parse(raw) : null;
}

export function isAdminUser(user) {
  return Boolean(user && (user.is_admin || user.role === "admin" || user.is_superuser || user.is_staff));
}

function normalizeErrorText(value, fallback) {
  const text = String(value || "").trim();
  if (!text) return fallback;
  if (/<!doctype html|<html[\s>]|<body[\s>]|<h1[\s>]/i.test(text)) {
    return "Сервер вернул HTML-страницу ошибки. Проверьте, что API-путь доступен, и повторите запрос.";
  }
  return text;
}

export function extractApiErrorMessage(error, fallback = "Ошибка запроса") {
  const data = error?.response?.data;

  if (!data && error?.message) return normalizeErrorText(error.message, fallback);
  if (!data) return fallback;
  if (typeof data === "string") return normalizeErrorText(data, fallback);
  if (Array.isArray(data)) return data.join(", ");

  if (typeof data === "object") {
    const parts = [];

    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value)) {
        parts.push(`${key}: ${value.join(", ")}`);
      } else if (typeof value === "string") {
        parts.push(`${key}: ${normalizeErrorText(value, fallback)}`);
      }
    }

    if (parts.length) return parts.join(" | ");
  }

  return fallback;
}

export function initApiAuth() {
  const token = getToken();
  if (token) {
    api.defaults.headers.common.Authorization = `Bearer ${token}`;
  }
}

export function hasDadataAddressSuggestions() {
  return true;
}

export async function fetchAddressSuggestions(query) {
  const value = String(query || "").trim();
  if (value.length < 3) {
    return [];
  }

  initApiAuth();
  const { data } = await api.get("/api/address-suggestions/", {
    params: { q: value },
    timeout: 7000,
  });
  if (data?.configured === false) {
    throw new Error(data?.detail || "DADATA_API_KEY не настроен в backend .env.");
  }

  return (data?.suggestions || []).map((item) => ({
    value: item.value || "",
    unrestrictedValue: item.unrestricted_value || item.unrestrictedValue || item.value || "",
    lat: item.lat || "",
    lon: item.lon || "",
    apartment: item.apartment || "",
    floor: item.floor || "",
  }));
}

async function refreshAccessToken() {
  const refresh = getRefreshToken();
  if (!refresh) {
    throw new Error("Missing refresh token");
  }

  const { data } = await api.post("/api/auth/token/refresh/", { refresh }, { timeout: 10000 });
  setToken(data.access);

  if (data.refresh) {
    setRefreshToken(data.refresh);
  }

  return data.access;
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error?.config;
    const status = error?.response?.status;
    const requestUrl = originalRequest?.url || "";
    const isAuthRequest =
      requestUrl.includes("/api/auth/token/") || requestUrl.includes("/api/auth/token/refresh/");

    if (status !== 401 || !originalRequest || originalRequest._retry || isAuthRequest) {
      throw error;
    }

    if (!getRefreshToken()) {
      throw error;
    }

    originalRequest._retry = true;

    try {
      if (!refreshRequest) {
        refreshRequest = refreshAccessToken().finally(() => {
          refreshRequest = null;
        });
      }

      const nextAccessToken = await refreshRequest;
      originalRequest.headers = {
        ...(originalRequest.headers || {}),
        Authorization: `Bearer ${nextAccessToken}`,
      };

      return api(originalRequest);
    } catch (refreshError) {
      clearToken();
      throw refreshError;
    }
  }
);

export async function login(username, password) {
  const { data } = await api.post("/api/auth/token/", { username, password });
  setToken(data.access);
  if (data.refresh) {
    setRefreshToken(data.refresh);
  }
  return data;
}

export async function fetchMe() {
  initApiAuth();
  const { data } = await api.get("/api/me/");
  setUser(data);
  return data;
}

export async function fetchBillingSummary() {
  initApiAuth();
  const { data } = await api.get("/api/billing/summary/");
  setBillingSummary(data);
  return data;
}

export async function createBillingInvoice(planCode) {
  initApiAuth();
  const { data } = await api.post("/api/billing/invoices/", planCode ? { plan_code: planCode } : {});
  if (data?.summary) {
    setBillingSummary(data.summary);
  }
  return data;
}

export async function activateBillingInvoice(invoiceId) {
  initApiAuth();
  const { data } = await api.post("/api/billing/activate/", { invoice_id: invoiceId });
  if (data?.summary) {
    setBillingSummary(data.summary);
  }
  return data;
}

export async function fetchUsers() {
  initApiAuth();
  const { data } = await api.get("/api/users/");
  return data;
}

export async function createUser(payload) {
  initApiAuth();
  const { data } = await api.post("/api/users/", payload);
  return data;
}

export async function updateUser(userId, payload) {
  initApiAuth();
  const { data } = await api.patch(`/api/users/${userId}/`, payload);
  return data;
}

export async function fetchProjects() {
  initApiAuth();
  const { data } = await api.get("/api/projects/");
  return data;
}

export async function fetchGlobalSearch(query) {
  initApiAuth();
  const { data } = await api.get("/api/global-search/", { params: { q: query } });
  return data;
}

export async function fetchClients(params = {}) {
  initApiAuth();
  const { data } = await api.get("/api/clients/", { params });
  return data;
}

export async function createClient(payload) {
  initApiAuth();
  const { data } = await api.post("/api/clients/", payload);
  return data;
}

export async function updateClient(clientId, payload) {
  initApiAuth();
  const { data } = await api.patch(`/api/clients/${clientId}/`, payload);
  return data;
}

export async function deleteClient(clientId) {
  initApiAuth();
  await api.delete(`/api/clients/${clientId}/`);
}

export async function previewBonusPromo(payload) {
  initApiAuth();
  const { data } = await api.post("/api/bonus-promo-preview/", payload);
  return data;
}

export async function fetchProjectStatuses() {
  initApiAuth();
  const { data } = await api.get("/api/project-statuses/");
  return data;
}

export async function createProjectStatus(payload) {
  initApiAuth();
  const { data } = await api.post("/api/project-statuses/", payload);
  return data;
}

export async function updateProjectStatus(statusId, payload) {
  initApiAuth();
  const { data } = await api.patch(`/api/project-statuses/${statusId}/`, payload);
  return data;
}

export async function deleteProjectStatus(statusId) {
  initApiAuth();
  await api.delete(`/api/project-statuses/${statusId}/`);
}

export async function fetchFinanceCategories() {
  initApiAuth();
  const { data } = await api.get("/api/finance-categories/");
  return data;
}

export async function createFinanceCategory(payload) {
  initApiAuth();
  const { data } = await api.post("/api/finance-categories/", payload);
  return data;
}

export async function updateFinanceCategory(categoryId, payload) {
  initApiAuth();
  const { data } = await api.patch(`/api/finance-categories/${categoryId}/`, payload);
  return data;
}

export async function deleteFinanceCategory(categoryId) {
  initApiAuth();
  await api.delete(`/api/finance-categories/${categoryId}/`);
}

export async function fetchAccounts() {
  initApiAuth();
  const { data } = await api.get("/api/accounts/");
  return data;
}

export async function createAccount(payload) {
  initApiAuth();
  const { data } = await api.post("/api/accounts/", payload);
  return data;
}

export async function deleteAccount(accountId) {
  initApiAuth();
  await api.delete(`/api/accounts/${accountId}/`);
}

export async function fetchProjectCustomFields() {
  initApiAuth();
  const { data } = await api.get("/api/project-custom-fields/");
  return data;
}

export async function createProjectCustomField(payload) {
  initApiAuth();
  const { data } = await api.post("/api/project-custom-fields/", payload);
  return data;
}

export async function deleteProjectCustomField(fieldId) {
  initApiAuth();
  await api.delete(`/api/project-custom-fields/${fieldId}/`);
}

export async function fetchDocumentTemplates() {
  initApiAuth();
  const { data } = await api.get("/api/document-templates/");
  return data;
}

export async function uploadDocumentTemplate(templateType, file, existingId) {
  initApiAuth();
  const formData = new FormData();
  formData.append("type", templateType);
  formData.append("file", file);
  formData.append("original_name", file.name);

  const url = existingId ? `/api/document-templates/${existingId}/` : "/api/document-templates/";
  const method = existingId ? "put" : "post";
  const { data } = await api[method](url, formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return data;
}

export async function deleteDocumentTemplate(templateId) {
  initApiAuth();
  await api.delete(`/api/document-templates/${templateId}/`);
}

export async function uploadProjectCustomFieldFile(projectId, fieldId, files) {
  initApiAuth();
  const formData = new FormData();
  formData.append("field_id", String(fieldId));
  const fileList = Array.isArray(files) ? files : [files];
  fileList.filter(Boolean).forEach((file) => formData.append("files", file));

  const { data } = await api.post(`/api/projects/${projectId}/custom-field-files/`, formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return data;
}

export async function fetchChatSettings() {
  initApiAuth();
  const { data } = await api.get("/api/chat-settings/");
  return data;
}

export async function updateChatSettings(payload) {
  initApiAuth();
  const { data } = await api.patch("/api/chat-settings/", payload);
  return data;
}

export async function fetchYandexDiskSettings() {
  initApiAuth();
  const { data } = await api.get("/api/yandex-disk-settings/");
  return data;
}

export async function fetchYandexDiskFolders(path = "disk:/") {
  initApiAuth();
  const { data } = await api.get("/api/yandex-disk-folders/", { params: { path } });
  return data;
}

export async function startYandexDiskOAuth() {
  initApiAuth();
  const { data } = await api.post("/api/yandex-disk/oauth/start/");
  return data;
}

export async function completeYandexDiskOAuth(code) {
  initApiAuth();
  const { data } = await api.post("/api/yandex-disk/oauth/complete/", { code });
  return data;
}

export async function updateYandexDiskSettings(payload) {
  initApiAuth();
  const { data } = await api.patch("/api/yandex-disk-settings/", payload);
  return data;
}

export async function downloadProjectDocument(projectId, documentType) {
  initApiAuth();
  const { data, headers } = await api.get(`/api/projects/${projectId}/documents/${documentType}/`, {
    responseType: "blob",
  });
  return { blob: data, headers };
}

export async function createProject(payload) {
  initApiAuth();
  const { data } = await api.post("/api/projects/", payload);
  return data;
}

export async function updateProject(projectId, payload) {
  initApiAuth();
  const { data } = await api.patch(`/api/projects/${projectId}/`, payload);
  return data;
}

export async function deleteProject(projectId) {
  initApiAuth();
  await api.delete(`/api/projects/${projectId}/`);
}

export async function createProjectYandexDiskFolder(projectId) {
  initApiAuth();
  const { data } = await api.post(`/api/projects/${projectId}/yandex-disk-folder/`);
  return data;
}

export async function fetchProjectActivity(projectId) {
  initApiAuth();
  const { data } = await api.get(`/api/projects/${projectId}/activity/`);
  return data;
}

export async function fetchProjectStatusChecks(projectId) {
  initApiAuth();
  const { data } = await api.get(`/api/projects/${projectId}/status-checks/`);
  return data;
}

export async function fetchPayments() {
  initApiAuth();
  const { data } = await api.get("/api/payments/");
  return data;
}

export async function fetchFinanceAnalytics(params = {}) {
  initApiAuth();
  const { data } = await api.get("/api/finance-analytics/", { params });
  return data;
}

export async function requestFinanceAiAnalysis(payload = {}) {
  initApiAuth();
  const { data } = await api.post("/api/finance-analytics/ai/", payload);
  return data;
}

export async function fetchCashForecast(params = {}) {
  initApiAuth();
  const { data } = await api.get("/api/cash-forecast/", { params });
  return data;
}

export async function requestCashForecastAi(payload = {}) {
  initApiAuth();
  const { data } = await api.post("/api/cash-forecast/ai/", payload);
  return data;
}

export async function fetchTasks(params) {
  initApiAuth();
  const { data } = await api.get("/api/tasks/", {
    params: params || undefined,
  });
  return data;
}

export async function createTask(payload) {
  initApiAuth();
  const { data } = await api.post("/api/tasks/", payload);
  return data;
}

export async function updateTask(taskId, payload) {
  initApiAuth();
  const { data } = await api.patch(`/api/tasks/${taskId}/`, payload);
  return data;
}

export async function deleteTask(taskId) {
  initApiAuth();
  await api.delete(`/api/tasks/${taskId}/`);
}

export async function fetchTaskTemplates() {
  initApiAuth();
  const { data } = await api.get("/api/task-templates/");
  return data;
}

export async function createTaskTemplate(payload) {
  initApiAuth();
  const { data } = await api.post("/api/task-templates/", payload);
  return data;
}

export async function updateTaskTemplate(templateId, payload) {
  initApiAuth();
  const { data } = await api.patch(`/api/task-templates/${templateId}/`, payload);
  return data;
}

export async function deleteTaskTemplate(templateId) {
  initApiAuth();
  await api.delete(`/api/task-templates/${templateId}/`);
}

export async function createPayment(payload) {
  initApiAuth();
  const { data } = await api.post("/api/payments/", payload);
  return data;
}

export async function updatePayment(paymentId, payload) {
  initApiAuth();
  const { data } = await api.patch(`/api/payments/${paymentId}/`, payload);
  return data;
}

export async function deletePayment(paymentId) {
  initApiAuth();
  await api.delete(`/api/payments/${paymentId}/`);
}

export async function fetchProjectComments(projectId) {
  initApiAuth();
  const { data } = await api.get("/api/project-comments/", {
    params: projectId ? { project: projectId } : undefined,
  });
  return data;
}

export async function createProjectComment(payload) {
  initApiAuth();
  const { data } = await api.post("/api/project-comments/", payload);
  return data;
}

export async function updateProjectComment(commentId, payload) {
  initApiAuth();
  const { data } = await api.patch(`/api/project-comments/${commentId}/`, payload);
  return data;
}

export async function deleteProjectComment(commentId) {
  initApiAuth();
  await api.delete(`/api/project-comments/${commentId}/`);
}

export async function sendAssistantMessage(payload) {
  initApiAuth();
  const { data } = await api.post("/api/assistant/chat/", payload, { timeout: 20000 });
  return data;
}

export async function sendAssistantVoiceMessage({ audioBlob, history, includeAudio = true }) {
  initApiAuth();
  const formData = new FormData();
  formData.append("audio", audioBlob, "voice-command.wav");
  formData.append("history", JSON.stringify(history || []));
  formData.append("include_audio", includeAudio ? "1" : "0");
  const { data } = await api.post("/api/assistant/voice/", formData, { timeout: 60000 });
  return data;
}

export default api;
