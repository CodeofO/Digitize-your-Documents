import { API_BASE } from "./apiConfig";

export function apiUrl(path: string) {
  return `${API_BASE}${path}`;
}

export async function apiFetch(path: string, options: RequestInit = {}) {
  const isForm = options.body instanceof FormData;
  const headers = new Headers(options.headers ?? {});
  if (!isForm && options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(apiUrl(path), {
    cache: "no-store",
    ...options,
    headers
  });
}
