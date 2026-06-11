import { Download, History, Loader2, RefreshCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  ExportJob,
  ExportJobOwnerType,
  listExportJobs,
  openExportJobDownload,
  retryAndDownloadExportJob
} from "./exportJobs";

export function ExportJobHistory(props: {
  ownerType: ExportJobOwnerType;
  ownerId: string;
  limit?: number;
  compact?: boolean;
}) {
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const limit = props.limit ?? 5;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextJobs = await listExportJobs({ ownerType: props.ownerType, ownerId: props.ownerId, limit });
      setJobs(nextJobs);
      setError(null);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Export 이력을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [limit, props.ownerId, props.ownerType]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!jobs.some((job) => job.status === "queued" || job.status === "running")) return;
    const timer = window.setInterval(() => void refresh(), 1800);
    return () => window.clearInterval(timer);
  }, [jobs, refresh]);

  useEffect(() => {
    const onExportUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ ownerType?: string; ownerId?: string }>).detail;
      if (detail?.ownerType === props.ownerType && detail?.ownerId === props.ownerId) {
        void refresh();
      }
    };
    window.addEventListener("digitize-export-job-updated", onExportUpdated);
    return () => window.removeEventListener("digitize-export-job-updated", onExportUpdated);
  }, [props.ownerId, props.ownerType, refresh]);

  const retry = async (job: ExportJob) => {
    setBusyJobId(job.id);
    try {
      await retryAndDownloadExportJob(job.id);
      await refresh();
    } catch (exc) {
      window.alert(exc instanceof Error ? exc.message : "Export 재시도에 실패했습니다.");
    } finally {
      setBusyJobId(null);
    }
  };

  return (
    <div className={`export-history-panel ${props.compact ? "compact" : ""}`}>
      <div className="export-history-head">
        <strong><History size={15} /> 최근 export</strong>
        <button type="button" className="secondary compact" onClick={() => void refresh()} disabled={loading}>
          {loading ? <Loader2 size={14} className="spin" /> : <RefreshCcw size={14} />}
          갱신
        </button>
      </div>
      {error && <div className="export-history-error">{error}</div>}
      <div className="export-history-list">
        {jobs.length ? (
          jobs.map((job) => (
            <div className="export-history-row" key={job.id}>
              <div className="export-history-row-main">
                <div>
                  <strong>{job.filename || `${job.format.toUpperCase()} 생성 중`}</strong>
                  <div className="export-history-meta">
                    <span className={`status-badge ${job.status}`}>{exportJobStatusLabel(job.status)}</span>
                    <span className="export-format-badge">{job.format.toUpperCase()}</span>
                    <span>{formatExportJobTime(job.completed_at || job.started_at || job.created_at)}</span>
                    <span>{formatExportJobSize(job.size_bytes)}</span>
                  </div>
                  {job.error_message && <small>{job.error_message}</small>}
                </div>
                <div className="export-history-actions">
                  {job.status === "completed" && (
                    <button type="button" className="secondary compact" onClick={() => openExportJobDownload(job.id)}>
                      <Download size={14} />
                      다운로드
                    </button>
                  )}
                  {job.status === "failed" && (
                    <button type="button" className="secondary compact" onClick={() => void retry(job)} disabled={busyJobId === job.id}>
                      {busyJobId === job.id ? <Loader2 size={14} className="spin" /> : <RefreshCcw size={14} />}
                      재시도
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))
        ) : (
          <span className="export-history-empty">최근 export 없음</span>
        )}
      </div>
    </div>
  );
}

function exportJobStatusLabel(status: ExportJob["status"]) {
  const labels: Record<ExportJob["status"], string> = {
    queued: "대기",
    running: "생성 중",
    completed: "완료",
    failed: "실패"
  };
  return labels[status] ?? status;
}

function formatExportJobTime(value: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatExportJobSize(bytes: number) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
