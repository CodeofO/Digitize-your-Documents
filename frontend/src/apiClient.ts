import { API_BASE } from "./apiConfig";

const CSRF_STORAGE_KEY = "digitize_csrf_token";

type AuthSession = {
  authenticated: boolean;
  csrf_token: string | null;
  expires_at: number | null;
  auth_required: boolean;
};

export function apiUrl(path: string) {
  return `${API_BASE}${path}`;
}

export async function apiFetch(path: string, options: RequestInit = {}) {
  const isForm = options.body instanceof FormData;
  const headers = new Headers(options.headers ?? {});
  if (!isForm && options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const csrfToken = readCsrfToken();
  const method = (options.method ?? "GET").toUpperCase();
  if (csrfToken && ["POST", "PUT", "PATCH", "DELETE"].includes(method) && !headers.has("X-CSRF-Token")) {
    headers.set("X-CSRF-Token", csrfToken);
  }
  return fetch(apiUrl(path), {
    cache: "no-store",
    credentials: "include",
    ...options,
    headers
  });
}

export async function exchangeAccessFragment() {
  const accessCode = readAccessCodeFromHash();
  if (!accessCode) return false;
  const response = await fetch(apiUrl("/api/auth/session"), {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_code: accessCode })
  });
  if (!response.ok) {
    clearCsrfToken();
    throw new Error("공유 접근 코드가 올바르지 않습니다.");
  }
  const session = (await response.json()) as AuthSession;
  persistCsrfToken(session.csrf_token);
  removeAccessCodeFromHash();
  return true;
}

export async function refreshAuthSession() {
  const response = await fetch(apiUrl("/api/auth/session"), {
    credentials: "include",
    cache: "no-store"
  });
  if (!response.ok) return null;
  const session = (await response.json()) as AuthSession;
  persistCsrfToken(session.csrf_token);
  return session;
}

function readAccessCodeFromHash() {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash.startsWith("access=")) return "";
  return decodeURIComponent(hash.slice("access=".length));
}

function removeAccessCodeFromHash() {
  if (!window.location.hash.replace(/^#/, "").startsWith("access=")) return;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

function readCsrfToken() {
  try {
    return window.sessionStorage.getItem(CSRF_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function persistCsrfToken(token: string | null) {
  try {
    if (token) window.sessionStorage.setItem(CSRF_STORAGE_KEY, token);
    else window.sessionStorage.removeItem(CSRF_STORAGE_KEY);
  } catch {
    // sessionStorage can be unavailable in restricted browser contexts.
  }
}

function clearCsrfToken() {
  persistCsrfToken(null);
}
