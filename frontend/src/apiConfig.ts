type RuntimeConfig = {
  API_BASE_URL?: string | null;
};

declare global {
  interface Window {
    __DIGITIZE_CONFIG__?: RuntimeConfig;
  }
}

const LOCAL_DEV_API_BASE = "http://localhost:8000";

export const API_BASE = resolveApiBaseUrl();

export function resolveApiBaseUrl() {
  const runtimeApiBase = typeof window === "undefined" ? "" : window.__DIGITIZE_CONFIG__?.API_BASE_URL?.trim() ?? "";
  const buildApiBase = import.meta.env.VITE_API_BASE_URL?.trim() ?? "";
  return trimTrailingSlash(runtimeApiBase || buildApiBase || defaultApiBaseUrl());
}

function defaultApiBaseUrl() {
  if (typeof window === "undefined") return LOCAL_DEV_API_BASE;
  const { hostname, port } = window.location;
  if ((hostname === "localhost" || hostname === "127.0.0.1") && port !== "8000") {
    return LOCAL_DEV_API_BASE;
  }
  return "";
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}
