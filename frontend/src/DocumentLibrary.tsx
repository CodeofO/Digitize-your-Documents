import {
  Check,
  CheckSquare,
  Clipboard,
  ClipboardList,
  Copy,
  FileText,
  FolderPlus,
  FolderOpen,
  LayoutGrid,
  List as ListIcon,
  Loader2,
  Play,
  Plus,
  Search,
  Scissors,
  Sparkles,
  Trash2,
  UploadCloud,
  X
} from "lucide-react";
import { ChangeEvent, DragEvent, MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
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
  source_path?: string;
  source_note?: string;
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

type LibraryActionResponse = {
  documents: LibraryDocument[];
  folders: LibraryFolder[];
};

type UploadQueueItem = {
  id: string;
  label: string;
  files: File[];
  targetFolder: string;
  status: "pending" | "uploading" | "completed" | "failed";
  uploadedCount: number;
  error: string | null;
};

type LibraryClipboard = {
  mode: "copy" | "cut";
  documentIds: string[];
  folderPaths: string[];
} | null;

type LibraryActionTarget = "raw" | "key-info" | "classifier" | "required-checker" | "workflow";
type LibraryViewMode = "list" | "icon";
type LibraryToast = {
  id: number;
  message: string;
  type: "info" | "success" | "error";
};

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
  const [operationBusy, setOperationBusy] = useState(false);
  const [operationLabel, setOperationLabel] = useState<string | null>(null);
  const [, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<LibraryToast | null>(null);
  const [viewMode, setViewMode] = useState<LibraryViewMode>("list");
  const [clipboard, setClipboard] = useState<LibraryClipboard>(null);
  const [selectedDocumentCache, setSelectedDocumentCache] = useState<Record<string, LibraryDocument>>({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const processingQueueRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);
  const lastSelectedDocumentIdRef = useRef<string | null>(props.selectedIds[props.selectedIds.length - 1] ?? null);
  const selectedSet = useMemo(() => new Set(props.selectedIds), [props.selectedIds]);
  const selectableDocuments = documents.filter((document) => !["deleted", "failed"].includes(document.status));
  const allVisibleSelected = selectableDocuments.length > 0 && selectableDocuments.every((document) => selectedSet.has(document.document_id));
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

  useEffect(() => {
    if (!props.selectedIds.length) {
      lastSelectedDocumentIdRef.current = null;
    } else if (!lastSelectedDocumentIdRef.current || !props.selectedIds.includes(lastSelectedDocumentIdRef.current)) {
      lastSelectedDocumentIdRef.current = props.selectedIds[props.selectedIds.length - 1] ?? null;
    }
  }, [props.selectedIds]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isEditableShortcutTarget(event.target)) return;
      const modifier = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (modifier && key === "a") {
        event.preventDefault();
        void selectAllDocuments();
        return;
      }
      if (!modifier && event.key === "Escape" && props.selectedIds.length) {
        event.preventDefault();
        clearSelection();
        setToast(null);
        return;
      }
      if (modifier && key === "c" && props.selectedIds.length) {
        event.preventDefault();
        copySelected("copy");
        return;
      }
      if (modifier && key === "x" && props.selectedIds.length) {
        event.preventDefault();
        copySelected("cut");
        return;
      }
      if (modifier && key === "v" && clipboard) {
        event.preventDefault();
        void pasteClipboard();
        return;
      }
      if (!modifier && (event.key === "Delete" || event.key === "Backspace") && props.selectedIds.length) {
        event.preventDefault();
        void deleteSelectedDocuments();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeFolder, clipboard, loading, operationBusy, props.selectedIds, query, status, selectableDocuments.length, allVisibleSelected]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

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
      rememberDocuments(loadedDocuments);
    } catch (err) {
      setError(errorMessage(err));
      showToast(errorMessage(err), "error");
    } finally {
      if (!options.silent) setLoading(false);
    }
  }

  function showToast(message: string, type: LibraryToast["type"] = "info") {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ id: Date.now(), message, type });
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, type === "error" ? 4800 : 2400);
  }

  function rememberDocuments(incoming: LibraryDocument[]) {
    if (!incoming.length) return;
    setSelectedDocumentCache((current) => {
      const next = { ...current };
      incoming.forEach((document) => {
        next[document.document_id] = document;
      });
      return next;
    });
  }

  function toggleDocument(document: LibraryDocument, event?: ReactMouseEvent<HTMLButtonElement>) {
    if (document.status === "deleted" || document.status === "failed") return;
    if (event?.shiftKey && lastSelectedDocumentIdRef.current) {
      selectDocumentRange(lastSelectedDocumentIdRef.current, document.document_id);
      lastSelectedDocumentIdRef.current = document.document_id;
      return;
    }
    rememberDocuments([document]);
    const next = selectedSet.has(document.document_id)
      ? props.selectedIds.filter((id) => id !== document.document_id)
      : [...props.selectedIds, document.document_id];
    props.onSelectedIds(next);
    lastSelectedDocumentIdRef.current = document.document_id;
  }

  function selectDocumentRange(anchorId: string, targetId: string) {
    const anchorIndex = documents.findIndex((document) => document.document_id === anchorId);
    const targetIndex = documents.findIndex((document) => document.document_id === targetId);
    if (anchorIndex < 0 || targetIndex < 0) {
      const targetDocument = documents.find((document) => document.document_id === targetId);
      if (targetDocument) toggleDocument(targetDocument);
      return;
    }
    const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
    const rangeDocuments = documents.slice(start, end + 1).filter((item) => !["deleted", "failed"].includes(item.status));
    if (!rangeDocuments.length) return;
    rememberDocuments(rangeDocuments);
    props.onSelectedIds(Array.from(new Set([...props.selectedIds, ...rangeDocuments.map((item) => item.document_id)])));
  }

  function clearSelection() {
    props.onSelectedIds([]);
    lastSelectedDocumentIdRef.current = null;
  }

  async function selectAllDocuments() {
    setError(null);
    setToast(null);
    try {
      const params = libraryQueryParams();
      params.set("limit", "20000");
      const ids = await api<string[]>(`/api/documents/ids?${params.toString()}`);
      const next = allVisibleSelected ? [] : Array.from(new Set([...props.selectedIds, ...ids]));
      props.onSelectedIds(next);
      if (!allVisibleSelected && ids.length) {
        rememberDocuments(documents.filter((document) => ids.includes(document.document_id)));
      }
      if (!ids.length) {
        showToast("선택할 문서가 없습니다.");
      } else {
        showToast(allVisibleSelected ? "현재 목록 선택을 해제했습니다." : `${ids.length.toLocaleString()}개 문서를 선택했습니다.`);
      }
    } catch (err) {
      setError(errorMessage(err));
      showToast(errorMessage(err), "error");
    }
  }

  async function resolveSelectedDocuments() {
    const cached = props.selectedIds.map((id) => selectedDocumentCache[id]).filter(Boolean);
    if (cached.length === props.selectedIds.length) return cached;
    const response = await api<LibraryUploadResponse>("/api/documents/selection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document_ids: props.selectedIds })
    });
    rememberDocuments(response.documents);
    const byId = new Map(response.documents.map((document) => [document.document_id, document]));
    return props.selectedIds.map((id) => selectedDocumentCache[id] ?? byId.get(id)).filter(Boolean) as LibraryDocument[];
  }

  async function runSelected(target: LibraryActionTarget) {
    setError(null);
    try {
      const documentsToRun = await resolveSelectedDocuments();
      props.onRunSelected?.(target, documentsToRun);
    } catch (err) {
      setError(errorMessage(err));
      showToast(errorMessage(err), "error");
    }
  }

  async function applySelection() {
    setError(null);
    try {
      const documentsToApply = await resolveSelectedDocuments();
      props.onApply?.(documentsToApply);
    } catch (err) {
      setError(errorMessage(err));
      showToast(errorMessage(err), "error");
    }
  }

  function copySelected(mode: "copy" | "cut") {
    if (!props.selectedIds.length) return;
    setClipboard({ mode, documentIds: props.selectedIds, folderPaths: [] });
    showToast(`${props.selectedIds.length.toLocaleString()}개 문서를 ${mode === "copy" ? "복사" : "이동"} 대상으로 잡았습니다.`);
  }

  function confirmDeleteDocuments(count: number, label?: string) {
    const target = label ? `"${label}"` : `${count.toLocaleString()}개 문서`;
    return window.confirm(
      `${target}의 원본 파일을 삭제합니다.\n\n삭제된 원본과 페이지 이미지는 복구할 수 없습니다. 과거 실행 기록과 추출 결과 row는 남습니다. 계속할까요?`
    );
  }

  async function deleteSelectedDocuments() {
    if (!props.selectedIds.length || operationBusy) return;
    if (!confirmDeleteDocuments(props.selectedIds.length)) return;
    setOperationBusy(true);
    setOperationLabel("삭제가 진행중입니다");
    setError(null);
    try {
      const response = await api<LibraryUploadResponse>("/api/documents/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_ids: props.selectedIds })
      });
      const deletedIds = new Set(response.documents.map((document) => document.document_id));
      setDocuments((current) => current.filter((document) => !deletedIds.has(document.document_id)));
      setSelectedDocumentCache((current) => {
        const next = { ...current };
        deletedIds.forEach((id) => delete next[id]);
        return next;
      });
      props.onSelectedIds(props.selectedIds.filter((id) => !deletedIds.has(id)));
      if (clipboard?.documentIds.some((id) => deletedIds.has(id))) {
        setClipboard(null);
      }
      showToast(`${deletedIds.size.toLocaleString()}개 문서의 원본을 삭제했습니다.`, "success");
      await refreshLibrary({ silent: true });
    } catch (err) {
      setError(errorMessage(err));
      showToast(errorMessage(err), "error");
    } finally {
      setOperationBusy(false);
      setOperationLabel(null);
    }
  }

  function copyActiveFolder(mode: "copy" | "cut") {
    if (!activeFolder) {
      setError("먼저 왼쪽에서 폴더를 선택하세요.");
      showToast("먼저 왼쪽에서 폴더를 선택하세요.", "error");
      return;
    }
    setClipboard({ mode, documentIds: [], folderPaths: [activeFolder] });
    showToast(`"${activeFolder}" 폴더를 ${mode === "copy" ? "복사" : "이동"} 대상으로 잡았습니다.`);
  }

  async function pasteClipboard() {
    if (!clipboard) return;
    setOperationBusy(true);
    setOperationLabel(`${clipboard.mode === "copy" ? "복사" : "이동"} 처리 중입니다`);
    setError(null);
    try {
      const response = await api<LibraryActionResponse>(`/api/library/${clipboard.mode === "copy" ? "copy" : "move"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document_ids: clipboard.documentIds,
          folder_paths: clipboard.folderPaths,
          target_folder: activeFolder
        })
      });
      rememberDocuments(response.documents);
      setFolders(response.folders);
      if (clipboard.mode === "cut") {
        setClipboard(null);
        props.onSelectedIds([]);
      }
      showToast(`${clipboard.mode === "copy" ? "복사" : "이동"} 완료: ${response.documents.length.toLocaleString()}개 문서`, "success");
      await refreshLibrary({ silent: true });
    } catch (err) {
      setError(errorMessage(err));
      showToast(errorMessage(err), "error");
    } finally {
      setOperationBusy(false);
      setOperationLabel(null);
    }
  }

  async function createFolder() {
    const name = window.prompt("새 폴더 이름");
    const folderName = normalizeLibraryPath(name ?? "");
    if (!folderName) return;
    const folderPath = activeFolder ? `${activeFolder}/${folderName}` : folderName;
    setOperationBusy(true);
    setOperationLabel("폴더를 만드는 중입니다");
    setError(null);
    try {
      const tree = await api<{ folders: LibraryFolder[] }>("/api/library/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder_path: folderPath })
      });
      setFolders(tree.folders);
      setActiveFolder(normalizeLibraryPath(folderPath));
      showToast(`"${folderPath}" 폴더를 만들었습니다.`, "success");
    } catch (err) {
      setError(errorMessage(err));
      showToast(errorMessage(err), "error");
    } finally {
      setOperationBusy(false);
      setOperationLabel(null);
    }
  }

  function libraryQueryParams() {
    const params = new URLSearchParams();
    if (activeFolder) params.set("library_path", activeFolder);
    if (query.trim()) params.set("q", query.trim());
    if (status) params.set("status", status);
    return params;
  }

  function enqueueFiles(files: File[], label: string) {
    const supported = sortLibraryFiles(
      files.filter((file) => LIBRARY_FILE_EXTENSIONS.has(file.name.split(".").pop()?.toLowerCase() ?? ""))
    );
    if (!supported.length) {
      setError("지원하는 문서 파일이 없습니다.");
      showToast("지원하는 문서 파일이 없습니다.", "error");
      return;
    }
    const item: UploadQueueItem = {
      id: `upload_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      label: activeFolder ? `${label} → ${activeFolder}` : label,
      files: supported,
      targetFolder: activeFolder,
      status: "pending",
      uploadedCount: 0,
      error: null
    };
    setUploadQueue((current) => [...current, item]);
    setError(null);
    showToast(`${supported.length.toLocaleString()}개 파일을 업로드 대기에 추가했습니다.`);
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
        const response = await uploadLibraryFiles(chunk, item.targetFolder);
        uploadedDocuments.push(...response);
        uploadedCount += chunk.length;
        setUploadQueue((current) =>
          current.map((candidate) => (candidate.id === itemId ? { ...candidate, uploadedCount } : candidate))
        );
        setDocuments((current) => mergeDocuments(response, current));
      }
      rememberDocuments(uploadedDocuments);
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
      showToast(errorMessage(err), "error");
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
    if (!confirmDeleteDocuments(1, document.filename)) return;
    setError(null);
    setOperationBusy(true);
    setOperationLabel("삭제가 진행중입니다");
    try {
      const deleted = await api<LibraryDocument>(`/api/documents/${document.document_id}`, { method: "DELETE" });
      setDocuments((current) => current.map((item) => (item.document_id === deleted.document_id ? deleted : item)));
      props.onSelectedIds(props.selectedIds.filter((id) => id !== document.document_id));
      showToast(`"${document.filename}" 원본을 삭제했습니다.`, "success");
      await refreshLibrary({ silent: true });
    } catch (err) {
      setError(errorMessage(err));
      showToast(errorMessage(err), "error");
    } finally {
      setOperationBusy(false);
      setOperationLabel(null);
    }
  }

  const folderButtons = folders.filter((folder) => folder.path);
  const rootFolder = folders.find((folder) => folder.path === "");
  const clipboardLabel = clipboard
    ? `${clipboard.documentIds.length + clipboard.folderPaths.length}개 ${clipboard.mode === "copy" ? "복사" : "이동"} 준비됨`
    : "";

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
          <div className="document-library-folder-tools">
            <button type="button" className="secondary compact" disabled={operationBusy} onClick={() => void createFolder()}>
              <FolderPlus size={14} />
              새 폴더
            </button>
            <button type="button" className="secondary compact" disabled={!activeFolder || operationBusy} onClick={() => copyActiveFolder("copy")}>
              <Copy size={14} />
              폴더 복사
            </button>
            <button type="button" className="secondary compact" disabled={!activeFolder || operationBusy} onClick={() => copyActiveFolder("cut")}>
              <Scissors size={14} />
              폴더 이동
            </button>
            <button type="button" className="secondary compact" disabled={!clipboard || operationBusy} onClick={() => void pasteClipboard()}>
              <Clipboard size={14} />
              붙여넣기
            </button>
          </div>
          <button type="button" className={`document-library-folder-button ${activeFolder === "" ? "active" : ""}`} onClick={() => setActiveFolder("")}>
            <FolderOpen size={16} />
            <span>전체 문서</span>
            <small>{rootFolder?.total_count ?? documents.length}</small>
          </button>
          {folderButtons.map((folder) => (
            <button key={folder.path || "root"} type="button" className={`document-library-folder-button ${activeFolder === folder.path ? "active" : ""}`} onClick={() => setActiveFolder(folder.path)}>
              <FolderOpen size={16} />
              <span>{folder.path || "문서 보관함"}</span>
              <small>{folder.total_count}</small>
            </button>
          ))}
        </aside>

        <div className="document-library-main">
          <div className="document-library-selection-bar">
            <span>
              {props.selectedIds.length ? `${props.selectedIds.length.toLocaleString()}개 선택됨` : "문서를 선택하면 작업으로 보낼 수 있습니다."}
              {clipboardLabel ? ` · ${clipboardLabel}` : ""}
            </span>
            <div className="document-library-selection-actions">
              <div className="document-library-view-switch" aria-label="보기 방식">
                <button type="button" className={viewMode === "list" ? "active" : ""} onClick={() => setViewMode("list")} title="목록 보기">
                  <ListIcon size={14} />
                  목록
                </button>
                <button type="button" className={viewMode === "icon" ? "active" : ""} onClick={() => setViewMode("icon")} title="아이콘 보기">
                  <LayoutGrid size={14} />
                  아이콘
                </button>
              </div>
              <div className="document-library-selection-group">
                <button type="button" className="secondary compact" disabled={loading || operationBusy || !selectableDocuments.length} onClick={() => void selectAllDocuments()} title="Command/Ctrl + A">
                  <CheckSquare size={14} />
                  {allVisibleSelected ? "전체 해제" : "전체 선택"}
                </button>
                {props.selectedIds.length > 0 && (
                  <button type="button" className="secondary compact" onClick={clearSelection}>
                    선택 해제
                  </button>
                )}
              </div>
              <div className="document-library-selection-group">
                <button type="button" className="secondary compact" disabled={!props.selectedIds.length || operationBusy} onClick={() => copySelected("copy")} title="Command/Ctrl + C">
                  <Copy size={14} />
                  복사
                </button>
                <button type="button" className="secondary compact" disabled={!props.selectedIds.length || operationBusy} onClick={() => copySelected("cut")} title="Command/Ctrl + X">
                  <Scissors size={14} />
                  이동
                </button>
                <button type="button" className="secondary compact" disabled={!clipboard || operationBusy} onClick={() => void pasteClipboard()} title="Command/Ctrl + V">
                  <Clipboard size={14} />
                  붙여넣기
                </button>
              </div>
              <div className="document-library-selection-group">
                <button type="button" className="secondary compact danger-outline" disabled={!props.selectedIds.length || operationBusy} onClick={() => void deleteSelectedDocuments()} title="Delete">
                  <Trash2 size={14} />
                  선택 삭제
                </button>
                {props.onApply && (
                  <button type="button" className="primary compact" disabled={!props.selectedIds.length} onClick={() => void applySelection()}>
                    <Check size={14} />
                    선택 적용
                  </button>
                )}
              </div>
            </div>
          </div>

          {props.mode === "screen" && props.onRunSelected && (
            <div className="document-library-actions">
              <button type="button" disabled={!props.selectedIds.length} onClick={() => void runSelected("workflow")}>
                <Play size={15} />
                워크플로우로 실행
              </button>
              <button type="button" disabled={!props.selectedIds.length} onClick={() => void runSelected("key-info")}>
                <Sparkles size={15} />
                핵심 정보 추출
              </button>
              <button type="button" disabled={!props.selectedIds.length} onClick={() => void runSelected("classifier")}>
                <ClipboardList size={15} />
                문서 분류
              </button>
              <button type="button" disabled={!props.selectedIds.length} onClick={() => void runSelected("required-checker")}>
                <CheckSquare size={15} />
                필수 항목 확인
              </button>
              <button type="button" disabled={props.selectedIds.length !== 1} onClick={() => void runSelected("raw")}>
                <FileText size={15} />
                원문 추출
              </button>
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

          {(loading || operationBusy || toast) && (
            <div className="document-library-feedback" aria-live="polite">
              {(loading || operationBusy) && (
                <div className="document-library-busy">
                  <Loader2 size={15} className="spin" />
                  {operationBusy ? operationLabel ?? "보관함 작업 처리 중입니다" : "보관함을 불러오는 중입니다"}
                </div>
              )}
              {toast && (
                <div
                  key={toast.id}
                  className={`document-library-toast ${toast.type}`}
                  style={{ animationDuration: toast.type === "error" ? "4800ms" : "2400ms" }}
                >
                  {toast.message}
                </div>
              )}
            </div>
          )}

          <div className={`document-library-list ${viewMode === "icon" ? "icon-view" : "list-view"}`}>
            {documents.length ? (
              documents.map((document) => (
                <article key={document.document_id} className={`document-library-row ${document.status} ${selectedSet.has(document.document_id) ? "selected" : ""}`}>
                  <button type="button" className="document-library-row-main" onClick={(event) => toggleDocument(document, event)}>
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

export async function uploadLibraryFiles(files: File[], targetFolder = ""): Promise<LibraryDocument[]> {
  const form = new FormData();
  files.forEach((file) => {
    form.append("files", file);
    form.append("library_paths", normalizeLibraryPath([targetFolder, libraryPathForFile(file)].filter(Boolean).join("/")));
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

function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || target.isContentEditable;
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
