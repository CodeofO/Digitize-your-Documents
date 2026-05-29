import { apiFetch } from "./apiClient";
import { API_BASE } from "./apiConfig";

export type ExportJobOwnerType = "workflow_run" | "batch" | "classification_batch" | "required_field_check_batch";
export type ExportJobFormat = "csv" | "json" | "xlsx";
export type ExportJobStatus = "queued" | "running" | "completed" | "failed";

export type ExportJob = {
  id: string;
  owner_type: ExportJobOwnerType;
  owner_id: string;
  format: ExportJobFormat;
  status: ExportJobStatus;
  filename: string | null;
  content_type: string | null;
  size_bytes: number;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export async function createAndDownloadExportJob(ownerType: ExportJobOwnerType, ownerId: string, format: ExportJobFormat) {
  const downloadWindow = openPendingExportWindow();
  try {
    const created = await exportApi<ExportJob>("/api/export-jobs", {
      method: "POST",
      body: JSON.stringify({ owner_type: ownerType, owner_id: ownerId, format })
    });
    notifyExportJobUpdated(created);
    const completed = await waitAndOpenExportDownload(created.id, downloadWindow);
    notifyExportJobUpdated(completed);
    return completed;
  } catch (exc) {
    downloadWindow?.close();
    throw exc;
  }
}

export async function retryAndDownloadExportJob(jobId: string) {
  const downloadWindow = openPendingExportWindow();
  try {
    const created = await exportApi<ExportJob>(`/api/export-jobs/${jobId}/retry`, { method: "POST" });
    notifyExportJobUpdated(created);
    const completed = await waitAndOpenExportDownload(created.id, downloadWindow);
    notifyExportJobUpdated(completed);
    return completed;
  } catch (exc) {
    downloadWindow?.close();
    throw exc;
  }
}

export async function listExportJobs(filters: {
  ownerType?: ExportJobOwnerType;
  ownerId?: string;
  status?: ExportJobStatus;
  limit?: number;
}) {
  const params = new URLSearchParams();
  if (filters.ownerType) params.set("owner_type", filters.ownerType);
  if (filters.ownerId) params.set("owner_id", filters.ownerId);
  if (filters.status) params.set("status", filters.status);
  if (filters.limit) params.set("limit", String(filters.limit));
  const query = params.toString();
  return exportApi<ExportJob[]>(`/api/export-jobs${query ? `?${query}` : ""}`);
}

export function openExportJobDownload(jobId: string) {
  window.open(exportJobDownloadUrl(jobId), "_blank", "noopener,noreferrer");
}

async function waitForExportJob(jobId: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await exportApi<ExportJob>(`/api/export-jobs/${jobId}`);
    if (job.status === "completed" || job.status === "failed") return job;
    await delay(1500);
  }
  return exportApi<ExportJob>(`/api/export-jobs/${jobId}`);
}

async function waitAndOpenExportDownload(jobId: string, downloadWindow: Window | null) {
  const completed = await waitForExportJob(jobId);
  if (completed.status !== "completed") {
    throw new Error(completed.error_message || "Export 생성에 실패했습니다.");
  }
  const downloadUrl = exportJobDownloadUrl(completed.id);
  if (downloadWindow) downloadWindow.location.href = downloadUrl;
  else window.open(downloadUrl, "_blank", "noopener,noreferrer");
  return completed;
}

function openPendingExportWindow() {
  const downloadWindow = window.open("about:blank", "_blank");
  if (downloadWindow) {
    downloadWindow.opener = null;
    downloadWindow.document.title = "Export";
    downloadWindow.document.body.textContent = "Export 준비 중...";
  }
  return downloadWindow;
}

function exportJobDownloadUrl(jobId: string) {
  return `${API_BASE}/api/export-jobs/${jobId}/download`;
}

function notifyExportJobUpdated(job: ExportJob) {
  window.dispatchEvent(
    new CustomEvent("digitize-export-job-updated", {
      detail: { ownerType: job.owner_type, ownerId: job.owner_id, jobId: job.id, status: job.status }
    })
  );
}

async function exportApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, options);
  if (!response.ok) throw new Error(await exportErrorMessage(response));
  return response.json() as Promise<T>;
}

async function exportErrorMessage(response: Response) {
  try {
    const payload = await response.json();
    if (typeof payload?.detail === "string") return payload.detail;
  } catch {
    // Fall back to status text below.
  }
  return response.statusText || "Export 요청에 실패했습니다.";
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
