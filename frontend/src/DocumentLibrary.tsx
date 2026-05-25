import {
  Check,
  CheckSquare,
  ClipboardList,
  FileText,
  FolderOpen,
  Loader2,
  Play,
  Plus,
  Search,
  Sparkles,
  Trash2,
  UploadCloud,
  X
} from "lucide-react";
import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "./apiClient";

const LIBRARY_FILE_ACCEPT = ".pdf,.png,.jpg,.jpeg,.docx,.xlsx,.pptx";
const LIBRARY_FILE_EXTENSIONS = new Set(["pdf", "png", "jpg", "jpeg", "docx", "xlsx", "pptx"]);
const DEFAULT_LIBRARY_UPLOAD_CHUNK_FILES = 50;

export type LibraryDocument = {
  document_id: string;
  filename: string;
  library_path: string | null;
  mime_type: string;
  size_bytes: number;
  page_count: number;
  status: string;
  error_message?: string | null;
  created_at: string;
  deleted_at?: string | null;
};

type LibraryFolder = {
  path: string;
  name: string;
  parent: string | null;
  total_count: number;
  ready_count: number;
  converting_count: number;
  failed_count: number;
  deleted_count: number;
};

type LibraryUploadResponse = {
  documents: LibraryDocument[];
};

type UploadQueueItem = {
  id: string;
  label: string;
  files: File[];
  status: "pending" | "uploading" | "completed" | "failed";
  uploadedCount: number;
  error: string | null;
};

type LibraryActionTarget = "raw" | "key-info" | "classifier" | "required-checker" | "workflow";

type DocumentLibraryPanelProps = {
  mode: "screen" | "picker";
  uploadChunkFiles?: number;
  selectedIds: string[];
  onSelectedIds: (ids: string[]) => void;
  onApply?: (documents: LibraryDocument[]) => void;
  onRunSelected?: (target: LibraryActionTarget, documents: LibraryDocument[]) => void;
};

export function DocumentLibraryScreen(props: {
  uploadChunkFiles?: number;
  onRunSelected: (target: LibraryActionTarget, documents: LibraryDocument[]) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  return (
    <main className="document-library-screen">
      <DocumentLibraryPanel
        mode="screen"
        uploadChunkFiles={props.uploadChunkFiles}
        selectedIds={selectedIds}
        onSelectedIds={setSelectedIds}
        onRunSelected={props.onRunSelected}
      />
    </main>
  );
}

export function DocumentPickerButton(props: {
  label?: string;
  disabled?: boolean;
  multiple?: boolean;
  selectedDocuments: LibraryDocument[];
  uploadChunkFiles?: number;
  onSelected: (documents: LibraryDocument[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftSelectedIds, setDraftSelectedIds] = useState<string[]>([]);
  const selectedIds = props.selectedDocuments.map((document) => document.document_id);
  const label = props.label ?? "문서 보관함";

  useEffect(() => {
    if (open) setDraftSelectedIds(selectedIds);
  }, [open, selectedIds.join("|")]);

  return (
    <>
      <button type="button" className="secondary library-picker-trigger" disabled={props.disabled} onClick={() => setOpen(true)}>
        <FolderOpen size={16} />
        {selectedIds.length ? `${selectedIds.length.toLocaleString()}개 문서 선택됨` : label}
      </button>
      {open && (
        <div className="library-picker-backdrop" role="dialog" aria-modal="true">
          <section className="library-picker-modal">
            <div className="library-picker-header">
              <div>
                <p className="eyebrow">문서 보관함</p>
                <h2>실행할 문서 선택</h2>
              </div>
              <button type="button" className="icon-only secondary" aria-label="닫기" onClick={() => setOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <DocumentLibraryPanel
              mode="picker"
              uploadChunkFiles={props.uploadChunkFiles}
              selectedIds={draftSelectedIds}
              onSelectedIds={(ids) => setDraftSelectedIds(props.multiple === false ? ids.slice(-1) : ids)}
              onApply={(documents) => {
                props.onSelected(props.multiple === false ? documents.slice(0, 1) : documents);
                setOpen(false);
              }}
            />
          </section>
        </div>
      )}
    </>
  );
}

function DocumentLibraryPanel(props: DocumentLibraryPanelProps) {
  const [documents, setDocuments] = useState<LibraryDocument[]>([]);
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [activeFolder, setActiveFolder] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [uploadQueue, setUploadQueue] = useState<UploadQueueItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const processingQueueRef = useRef(false);
  const selectedSet = useMemo(() => new Set(props.selectedIds), [props.selectedIds]);
  const selectedDocuments = documents.filter((document) => selectedSet.has(document.document_id));
  const pendingUploadCount = uploadQueue.filter((item) => item.status === "pending" || item.status === "uploading").length;
  const hasConvertingDocuments = documents.some((document) => ["queued", "preprocessing"].includes(document.status));

  useEffect(() => {
    void refreshLibrary();
  }, [activeFolder, query, status]);

  useEffect(() => {
    if (!hasConvertingDocuments && !pendingUploadCount) return;
    const timer = window.setInterval(() => void refreshLibrary({ silent: true }), 2500);
    return () => window.clearInterval(timer);
  }, [hasConvertingDocuments, pendingUploadCount, activeFolder, query, status]);

  useEffect(() => {
    if (processingQueueRef.current) return;
    const nextItem = uploadQueue.find((item) => item.status === "pending");
    if (!nextItem) return;
    void processQueueItem(nextItem.id);
  }, [uploadQueue]);

  async function refreshLibrary(options: { silent?: boolean } = {}) {
    if (!options.silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const params = new URLSearchParams({ limit: "300" });
      if (activeFolder) params.set("library_path", activeFolder);
      if (query.trim()) params.set("q", query.trim());
      if (status) params.set("status", status);
      const [loadedDocuments, tree] = await Promise.all([
        api<LibraryDocument[]>(`/api/documents?${params.toString()}`),
        api<{ folders: LibraryFolder[] }>("/api/library/tree")
      ]);
      setDocuments(loadedDocuments);
      setFolders(tree.folders);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      if (!options.silent) setLoading(false);
    }
  }

  function toggleDocument(document: LibraryDocument) {
    if (document.status === "deleted" || document.status === "failed") return;
    const next = selectedSet.has(document.document_id)
      ? props.selectedIds.filter((id) => id !== document.document_id)
      : [...props.selectedIds, document.document_id];
    props.onSelectedIds(next);
  }

  function clearSelection() {
    props.onSelectedIds([]);
  }

  function enqueueFiles(files: File[], label: string) {
    const supported = sortLibraryFiles(
      files.filter((file) => LIBRARY_FILE_EXTENSIONS.has(file.name.split(".").pop()?.toLowerCase() ?? ""))
    );
    if (!supported.length) {
      setError("지원하는 문서 파일이 없습니다.");
      return;
    }
    const item: UploadQueueItem = {
      id: `upload_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      label,
      files: supported,
      status: "pending",
      uploadedCount: 0,
      error: null
    };
    setUploadQueue((current) => [...current, item]);
    setError(null);
  }

  async function processQueueItem(itemId: string) {
    const item = uploadQueue.find((candidate) => candidate.id === itemId);
    if (!item) return;
    processingQueueRef.current = true;
    setUploadQueue((current) => current.map((candidate) => (candidate.id === itemId ? { ...candidate, status: "uploading", error: null } : candidate)));
    try {
      let uploadedCount = 0;
      const uploadedDocuments: LibraryDocument[] = [];
      const chunkSize = Math.max(1, props.uploadChunkFiles ?? DEFAULT_LIBRARY_UPLOAD_CHUNK_FILES);
      for (let start = 0; start < item.files.length; start += chunkSize) {
        const chunk = item.files.slice(start, start + chunkSize);
        const response = await uploadLibraryFiles(chunk);
        uploadedDocuments.push(...response);
        uploadedCount += chunk.length;
        setUploadQueue((current) =>
          current.map((candidate) => (candidate.id === itemId ? { ...candidate, uploadedCount } : candidate))
        );
        setDocuments((current) => mergeDocuments(response, current));
      }
      setUploadQueue((current) =>
        current.map((candidate) => (candidate.id === itemId ? { ...candidate, status: "completed", uploadedCount } : candidate))
      );
      props.onSelectedIds([...new Set([...props.selectedIds, ...uploadedDocuments.map((document) => document.document_id)])]);
      await refreshLibrary({ silent: true });
    } catch (err) {
      setUploadQueue((current) =>
        current.map((candidate) =>
          candidate.id === itemId ? { ...candidate, status: "failed", error: errorMessage(err) } : candidate
        )
      );
      setError(errorMessage(err));
    } finally {
      processingQueueRef.current = false;
    }
  }

  async function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    enqueueFiles(await filesFromDataTransfer(event.dataTransfer), "드래그한 항목");
  }

  function onFileInput(event: ChangeEvent<HTMLInputElement>) {
    enqueueFiles(Array.from(event.target.files ?? []), "선택한 파일");
    event.target.value = "";
  }

  function onFolderInput(event: ChangeEvent<HTMLInputElement>) {
    enqueueFiles(Array.from(event.target.files ?? []), "선택한 폴더");
    event.target.value = "";
  }

  async function deleteDocument(document: LibraryDocument) {
    setError(null);
    try {
      const deleted = await api<LibraryDocument>(`/api/documents/${document.document_id}`, { method: "DELETE" });
      setDocuments((current) => current.map((item) => (item.document_id === deleted.document_id ? deleted : item)));
      props.onSelectedIds(props.selectedIds.filter((id) => id !== document.document_id));
      await refreshLibrary({ silent: true });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const folderButtons = folders.filter((folder) => folder.path || folder.total_count);
  const rootFolder = folders.find((folder) => folder.path === "");

  return (
    <section className={props.mode === "screen" ? "document-library-panel full" : "document-library-panel compact"}>
      <div className="document-library-toolbar" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
        <div className="document-library-title">
          <p className="eyebrow">문서 보관함</p>
          <h2>업로드한 문서를 보관하고 준비되면 실행합니다</h2>
          <span>
            {rootFolder?.total_count.toLocaleString() ?? documents.length.toLocaleString()}개 문서
            {pendingUploadCount ? ` · 업로드 대기 ${pendingUploadCount}건` : ""}
          </span>
        </div>
        <div className="document-library-controls">
          <label className="library-search">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="파일명 또는 경로 검색" />
          </label>
          <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="상태 필터">
            <option value="">전체 상태</option>
            <option value="ready">준비 완료</option>
            <option value="queued">변환 대기</option>
            <option value="preprocessing">변환 중</option>
            <option value="failed">실패</option>
          </select>
          <button type="button" className="secondary" onClick={() => fileInputRef.current?.click()}>
            <UploadCloud size={16} />
            파일 추가
          </button>
          <button type="button" className="secondary" onClick={() => folderInputRef.current?.click()}>
            <FolderOpen size={16} />
            폴더 추가
          </button>
          <input ref={fileInputRef} className="visually-hidden" type="file" multiple accept={LIBRARY_FILE_ACCEPT} onChange={onFileInput} />
          <input
            ref={folderInputRef}
            className="visually-hidden"
            type="file"
            multiple
            accept={LIBRARY_FILE_ACCEPT}
            onChange={onFolderInput}
            {...{ webkitdirectory: "", directory: "" }}
          />
        </div>
      </div>

      <div className="document-library-body">
        <aside className="document-library-folders">
          <button type="button" className={activeFolder === "" ? "active" : ""} onClick={() => setActiveFolder("")}>
            <FolderOpen size={16} />
            <span>전체 문서</span>
            <small>{rootFolder?.total_count ?? documents.length}</small>
          </button>
          {folderButtons.map((folder) => (
            <button key={folder.path || "root"} type="button" className={activeFolder === folder.path ? "active" : ""} onClick={() => setActiveFolder(folder.path)}>
              <FolderOpen size={16} />
              <span>{folder.path || "문서 보관함"}</span>
              <small>{folder.total_count}</small>
            </button>
          ))}
        </aside>

        <div className="document-library-main">
          <div className="document-library-selection-bar">
            <span>{props.selectedIds.length ? `${props.selectedIds.length.toLocaleString()}개 선택됨` : "문서를 선택하면 작업으로 보낼 수 있습니다."}</span>
            <div>
              {props.selectedIds.length > 0 && (
                <button type="button" className="secondary compact" onClick={clearSelection}>
                  선택 해제
                </button>
              )}
              {props.onApply && (
                <button type="button" className="primary compact" disabled={!selectedDocuments.length} onClick={() => props.onApply?.(selectedDocuments)}>
                  <Check size={14} />
                  선택 적용
                </button>
              )}
            </div>
          </div>

          {props.mode === "screen" && props.onRunSelected && (
            <div className="document-library-actions">
              <button type="button" disabled={!selectedDocuments.length} onClick={() => props.onRunSelected?.("workflow", selectedDocuments)}>
                <Play size={15} />
                워크플로우로 실행
              </button>
              <button type="button" disabled={!selectedDocuments.length} onClick={() => props.onRunSelected?.("key-info", selectedDocuments)}>
                <Sparkles size={15} />
                핵심 정보 추출
              </button>
              <button type="button" disabled={!selectedDocuments.length} onClick={() => props.onRunSelected?.("classifier", selectedDocuments)}>
                <ClipboardList size={15} />
                문서 분류
              </button>
              <button type="button" disabled={!selectedDocuments.length} onClick={() => props.onRunSelected?.("required-checker", selectedDocuments)}>
                <CheckSquare size={15} />
                필수 항목 확인
              </button>
              <button type="button" disabled={selectedDocuments.length !== 1} onClick={() => props.onRunSelected?.("raw", selectedDocuments)}>
                <FileText size={15} />
                원문 추출
              </button>
            </div>
          )}

          {(error || loading) && (
            <div className="document-library-message">
              {loading && (
                <span>
                  <Loader2 size={15} className="spin" />
                  보관함을 불러오는 중
                </span>
              )}
              {error && <span className="module-error">{error}</span>}
            </div>
          )}

          {uploadQueue.length > 0 && (
            <div className="document-upload-queue">
              <div>
                <strong>업로드 대기</strong>
                <span>업로드 중에도 파일이나 폴더를 계속 추가할 수 있습니다.</span>
              </div>
              {uploadQueue.map((item) => (
                <div key={item.id} className={`document-upload-queue-row ${item.status}`}>
                  <div>
                    <strong>{item.label}</strong>
                    <span>
                      {item.uploadedCount.toLocaleString()} / {item.files.length.toLocaleString()} 업로드
                      {item.error ? ` · ${item.error}` : ""}
                    </span>
                  </div>
                  <small>{uploadQueueStatusLabel(item.status)}</small>
                </div>
              ))}
            </div>
          )}

          <div className="document-library-list">
            {documents.length ? (
              documents.map((document) => (
                <article key={document.document_id} className={`document-library-row ${document.status} ${selectedSet.has(document.document_id) ? "selected" : ""}`}>
                  <button type="button" className="document-library-row-main" onClick={() => toggleDocument(document)}>
                    <span className="document-library-check">{selectedSet.has(document.document_id) ? <Check size={15} /> : null}</span>
                    <span className="document-library-icon">
                      <FileText size={18} />
                    </span>
                    <span className="document-library-info">
                      <strong>{document.filename}</strong>
                      <small>
                        {document.library_path || document.filename} · {document.page_count.toLocaleString()}p · {formatBytes(document.size_bytes)} · {formatDate(document.created_at)}
                      </small>
                      {document.error_message && <small className="module-error">{document.error_message}</small>}
                    </span>
                    <span className={`document-status-pill ${document.status}`}>{libraryStatusLabel(document.status)}</span>
                  </button>
                  <button type="button" className="secondary compact danger-outline" disabled={document.status === "deleted"} onClick={() => void deleteDocument(document)}>
                    <Trash2 size={14} />
                    원본 삭제
                  </button>
                </article>
              ))
            ) : (
              <div className="document-library-empty" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
                <UploadCloud size={36} />
                <strong>문서를 업로드하세요</strong>
                <span>파일이나 폴더를 끌어오거나 상단의 추가 버튼을 사용할 수 있습니다.</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export async function uploadLibraryFiles(files: File[]): Promise<LibraryDocument[]> {
  const form = new FormData();
  files.forEach((file) => {
    form.append("files", file);
    form.append("library_paths", libraryPathForFile(file));
  });
  const response = await api<LibraryUploadResponse>("/api/library/uploads", { method: "POST", body: form });
  return response.documents;
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, options);
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(formatApiDetail(detail?.detail) || response.statusText);
  }
  return response.json() as Promise<T>;
}

function mergeDocuments(incoming: LibraryDocument[], current: LibraryDocument[]) {
  const byId = new Map<string, LibraryDocument>();
  [...incoming, ...current].forEach((document) => byId.set(document.document_id, document));
  return Array.from(byId.values()).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function sortLibraryFiles(files: File[]) {
  return [...files].sort((left, right) => libraryPathForFile(left).localeCompare(libraryPathForFile(right), "ko"));
}

function libraryPathForFile(file: File) {
  return normalizeLibraryPath((file as File & { webkitRelativePath?: string; libraryPath?: string }).webkitRelativePath || (file as File & { libraryPath?: string }).libraryPath || file.name);
}

function normalizeLibraryPath(path: string) {
  return path.replaceAll("\\", "/").split("/").filter((part) => part && part !== "." && part !== "..").join("/");
}

function libraryStatusLabel(status: string) {
  if (status === "ready") return "준비 완료";
  if (status === "queued") return "변환 대기";
  if (status === "preprocessing") return "변환 중";
  if (status === "failed") return "실패";
  if (status === "deleted") return "원본 삭제";
  return status;
}

function uploadQueueStatusLabel(status: UploadQueueItem["status"]) {
  if (status === "pending") return "대기";
  if (status === "uploading") return "업로드 중";
  if (status === "completed") return "완료";
  return "실패";
}

function formatDate(value: string) {
  try {
    return new Intl.DateTimeFormat("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  } catch {
    return value;
  }
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "요청을 처리하지 못했습니다.";
}

function formatApiDetail(detail: unknown): string {
  if (!detail) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail.map(formatApiDetail).filter(Boolean).join(", ");
  }
  if (typeof detail === "object" && "msg" in detail) {
    return String((detail as { msg?: unknown }).msg ?? "");
  }
  return JSON.stringify(detail);
}

type WebkitFileSystemEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
};

type WebkitFileSystemFileEntry = WebkitFileSystemEntry & {
  file: (success: (file: File) => void, error?: (error: DOMException) => void) => void;
};

type WebkitFileSystemDirectoryEntry = WebkitFileSystemEntry & {
  createReader: () => {
    readEntries: (success: (entries: WebkitFileSystemEntry[]) => void, error?: (error: DOMException) => void) => void;
  };
};

type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry?: () => WebkitFileSystemEntry | null;
};

async function filesFromDataTransfer(dataTransfer: DataTransfer) {
  const items = Array.from(dataTransfer.items ?? []) as DataTransferItemWithEntry[];
  const entries = items.map((item) => item.webkitGetAsEntry?.()).filter(Boolean) as WebkitFileSystemEntry[];
  if (!entries.length) return Array.from(dataTransfer.files ?? []);
  const nested = await Promise.all(entries.map((entry) => filesFromEntry(entry)));
  return sortLibraryFiles(nested.flat());
}

async function filesFromEntry(entry: WebkitFileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      (entry as WebkitFileSystemFileEntry).file(resolve, reject);
    });
    (file as File & { libraryPath?: string }).libraryPath = entry.fullPath || file.name;
    return [file];
  }
  if (!entry.isDirectory) return [];
  const reader = (entry as WebkitFileSystemDirectoryEntry).createReader();
  const children: WebkitFileSystemEntry[] = [];
  while (true) {
    const entries = await new Promise<WebkitFileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!entries.length) break;
    children.push(...entries);
  }
  const nested = await Promise.all(children.map((child) => filesFromEntry(child)));
  return nested.flat();
}
