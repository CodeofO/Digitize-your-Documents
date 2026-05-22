import {
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleHelp,
  ClipboardList,
  Download,
  FileDown,
  FileJson,
  FileSpreadsheet,
  FileUp,
  Filter,
  GripVertical,
  History,
  Loader2,
  Maximize2,
  PanelLeft,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Save,
  Settings,
  Sparkles,
  Trash2,
  UploadCloud,
  X,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { ChangeEvent, DragEvent, PointerEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode, UIEvent } from "react";
import { ModuleWorkspace } from "./ModuleWorkspace";
import { WorkflowBuilder } from "./WorkflowBuilder";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";
const WORKSPACE_STATE_KEY = "digitize_workspace_state_v1";
const LEFT_PANE_PERCENT_KEY = "digitize_left_pane_percent_v1";
const OUTPUT_FORMATS = ["string", "float", "date", "bool"] as const;
const KIE_FILE_ACCEPT = ".pdf,.png,.jpg,.jpeg,.docx,.pptx";
const KIE_FILE_EXTENSIONS = new Set(["pdf", "png", "jpg", "jpeg", "docx", "pptx"]);
const BATCH_FILE_ROW_HEIGHT = 84;
const BATCH_FILE_OVERSCAN = 8;
const SAMPLE_SCHEMA_FIELDS: FieldDefinition[] = [
  {
    key_name: "문서번호",
    description: "문서 상단 근처의 문서번호, 영수증 번호, 신청 번호 또는 거래 번호입니다.",
    output_format: "string"
  },
  {
    key_name: "문서일자",
    description: "문서에 인쇄된 발급일, 제출일 또는 효력 발생일입니다.",
    output_format: "date"
  },
  {
    key_name: "발급기관",
    description: "문서를 발급한 기관, 은행, 업체 또는 권한 있는 조직입니다.",
    output_format: "string"
  },
  {
    key_name: "수신자",
    description: "문서의 수신자 또는 문서가 귀속되는 사람/조직입니다.",
    output_format: "string"
  },
  {
    key_name: "금액",
    description: "보이는 경우 최종 합계, 잔액, 거래 금액 또는 결제 금액입니다.",
    output_format: "float"
  }
];

type OutputFormat = (typeof OUTPUT_FORMATS)[number];
type AppMode = "home" | "raw" | "key-info" | "classifier" | "required-checker" | "workflow";
type Step = "upload" | "schema" | "review";
type ReviewFilter = "needs_review" | "all" | "warning" | "null" | "changed" | "low_confidence" | "unreviewed";
type HistoryTab = "documents" | "schemas" | "jobs";
type ZoomMode = "manual" | "fitWidth" | "fitPage";

type RawExtractionOptions = {
  includeImages: boolean;
  includeFormulas: boolean;
};

type FieldRegion = {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type SchemaRegion = FieldRegion & {
  id: string;
  name: string;
};

type DocumentPage = {
  id: string;
  page: number;
  image_url: string;
  width: number;
  height: number;
};

type RegionEditorPage = {
  id: string;
  page: number;
  image_url: string;
};

type RegionEditorTarget = {
  page_count: number;
  pages: RegionEditorPage[];
};

type UploadedDocument = {
  document_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  page_count: number;
  status: string;
  document_type: string | null;
  language: string | null;
  ai_summary: string | null;
  recommendation_reasoning: string | null;
  pages: DocumentPage[];
  created_at: string;
};

type FieldDefinition = {
  key_name: string;
  description: string;
  output_format: OutputFormat;
  region_id?: string | null;
  region?: FieldRegion | null;
};

type SchemaField = FieldDefinition & {
  local_id: string;
};

type SavedSchema = {
  id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  is_template: boolean;
  template_category: string | null;
  pinned: boolean;
  ephemeral: boolean;
  archived: boolean;
  regions: SchemaRegion[];
  fields: FieldDefinition[];
  created_at: string;
  updated_at: string;
};

type SchemaRecommendation = {
  name: string;
  display_name: string | null;
  description: string | null;
  document_type: string | null;
  language: string | null;
  reasoning: string | null;
  fields: FieldDefinition[];
};

type SchemaDescriptionRecommendation = {
  description: string;
  reasoning: string | null;
};

type ExtractionValue = {
  value: unknown;
  normalized_value: unknown;
  page: number | null;
  confidence: number | null;
  evidence: string | null;
  warnings: string[];
};

type ValidatedOutput = {
  document_id: string;
  schema_id: string;
  status: string;
  values: Record<string, ExtractionValue>;
};

type ExtractionResult = {
  id: string;
  job_id: string;
  raw_model_output: Record<string, unknown>;
  validated_output: ValidatedOutput;
  corrected_output: ValidatedOutput | null;
  validation_warnings: string[];
  reviewed_fields: string[];
  created_at: string;
  updated_at: string;
};

type ExtractionJob = {
  job_id: string;
  document_id: string;
  schema_id: string;
  status: string;
  error_message: string | null;
  result_id: string | null;
  result: ExtractionResult | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type RawExtraction = {
  id: string;
  filename: string;
  source_format: string;
  size_bytes: number;
  status: string;
  pdf_url: string | null;
  html_url: string | null;
  warnings: string[];
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

type SystemStatus = {
  app_env: string;
  vlm_provider: string;
  vlm_model_name: string | null;
  has_vlm_credentials: boolean;
  is_mock: boolean;
};

type VlmSettings = {
  provider: string;
  model_name: string | null;
  libreoffice_path: string | null;
  reasoning_effort: string | null;
  verbosity: string | null;
  max_completion_tokens: string | null;
  top_p: string | null;
  service_tier: string | null;
  batch_max_workers: number;
  has_api_key: boolean;
  env_path: string;
};

type HomeWorkflowRun = {
  id: string;
  status: string;
  total_count: number;
  completed_count: number;
  failed_count: number;
  needs_review_count: number;
  progress: number;
  created_at: string;
};

type MaintenanceClearResponse = {
  status: string;
  counts: Record<string, number>;
  removed_paths: string[];
};

type ExportPresetField = {
  key_name: string;
  column_name?: string | null;
  include: boolean;
};

type ExportPreset = {
  id: string;
  schema_id: string | null;
  name: string;
  fields: ExportPresetField[];
  created_at: string;
  updated_at: string;
};

type BatchItem = {
  id: string;
  document_id: string;
  job_id: string;
  filename: string;
  status: string;
  result_id: string | null;
  error_message: string | null;
  created_at: string;
};

type Batch = {
  id: string;
  schema_id: string;
  status: string;
  total_count: number;
  completed_count: number;
  failed_count: number;
  canceled_count: number;
  progress: number;
  items: BatchItem[];
  created_at: string;
  completed_at: string | null;
};

type ArchiveSearchResult = {
  document_id: string;
  filename: string;
  document_type: string | null;
  language: string | null;
  job_id: string | null;
  result_id: string | null;
  schema_id: string | null;
  schema_name: string | null;
  status: string | null;
  matched_text: string | null;
  created_at: string;
};

type PersistedWorkspaceState = {
  mode: AppMode;
  step: Step;
  document_id: string | null;
  schema_id: string | null;
  job_id: string | null;
  batch_id: string | null;
  batch_item_id: string | null;
  raw_id: string | null;
  active_page: number;
};

type AuditEvent = {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

type WebkitFileSystemEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath?: string;
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

const initialFields: SchemaField[] = [
  {
    local_id: "field_1",
    key_name: "",
    description: "",
    output_format: "string"
  }
];

function modeFromLocation(): AppMode {
  const hash = window.location.hash.replace("#", "");
  if (isAppMode(hash)) return hash;
  return "home";
}

function isAppMode(value: unknown): value is AppMode {
  return value === "home" || value === "raw" || value === "key-info" || value === "classifier" || value === "required-checker" || value === "workflow";
}

function replaceModeHash(nextMode: AppMode) {
  const hash = nextMode === "home" ? "" : `#${nextMode}`;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${hash}`);
}

function savePersistedWorkspaceState(state: PersistedWorkspaceState) {
  try {
    window.localStorage.setItem(WORKSPACE_STATE_KEY, JSON.stringify(state));
  } catch {
    // localStorage can be unavailable in private or restricted browser contexts.
  }
}

function readPersistedWorkspaceState(): PersistedWorkspaceState | null {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedWorkspaceState>;
    const mode = isAppMode(parsed.mode) ? parsed.mode : "home";
    const step = parsed.step === "upload" || parsed.step === "schema" || parsed.step === "review" ? parsed.step : "upload";
    return {
      mode,
      step,
      document_id: typeof parsed.document_id === "string" ? parsed.document_id : null,
      schema_id: typeof parsed.schema_id === "string" ? parsed.schema_id : null,
      job_id: typeof parsed.job_id === "string" ? parsed.job_id : null,
      batch_id: typeof parsed.batch_id === "string" ? parsed.batch_id : null,
      batch_item_id: typeof parsed.batch_item_id === "string" ? parsed.batch_item_id : null,
      raw_id: typeof parsed.raw_id === "string" ? parsed.raw_id : null,
      active_page: typeof parsed.active_page === "number" ? parsed.active_page : 0
    };
  } catch {
    return null;
  }
}

function clearPersistedWorkspaceState() {
  try {
    window.localStorage.removeItem(WORKSPACE_STATE_KEY);
  } catch {
    // Ignore unavailable storage.
  }
}

function readPersistedLeftPanePercent() {
  try {
    const raw = window.localStorage.getItem(LEFT_PANE_PERCENT_KEY);
    if (!raw) return 50;
    const parsed = Number.parseFloat(raw);
    if (Number.isNaN(parsed)) return 50;
    return Math.min(78, Math.max(35, parsed));
  } catch {
    return 50;
  }
}

function savePersistedLeftPanePercent(percent: number) {
  try {
    window.localStorage.setItem(LEFT_PANE_PERCENT_KEY, String(percent));
  } catch {
    // Ignore unavailable storage.
  }
}

function useObjectUrl(file: File | null) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const nextUrl = URL.createObjectURL(file);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);

  return url;
}

function useVirtualFileList(count: number, activeIndex: number) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const updateHeight = () => setViewportHeight(element.clientHeight || 480);
    updateHeight();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateHeight);
      return () => window.removeEventListener("resize", updateHeight);
    }

    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || activeIndex < 0 || count <= 0) return;

    const rowTop = activeIndex * BATCH_FILE_ROW_HEIGHT;
    const rowBottom = rowTop + BATCH_FILE_ROW_HEIGHT;
    const viewTop = element.scrollTop;
    const viewBottom = viewTop + element.clientHeight;
    if (rowTop < viewTop) {
      element.scrollTop = Math.max(0, rowTop - BATCH_FILE_ROW_HEIGHT * 2);
      setScrollTop(element.scrollTop);
    } else if (rowBottom > viewBottom) {
      element.scrollTop = Math.max(0, rowBottom - element.clientHeight + BATCH_FILE_ROW_HEIGHT * 2);
      setScrollTop(element.scrollTop);
    }
  }, [activeIndex, count]);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  const start = Math.max(0, Math.floor(scrollTop / BATCH_FILE_ROW_HEIGHT) - BATCH_FILE_OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / BATCH_FILE_ROW_HEIGHT) + BATCH_FILE_OVERSCAN * 2;
  const end = Math.min(count, start + visibleCount);
  const spacerStyle = useMemo<CSSProperties>(
    () => ({ height: Math.max(1, count) * BATCH_FILE_ROW_HEIGHT }),
    [count]
  );
  const windowStyle = useMemo<CSSProperties>(
    () => ({ transform: `translateY(${start * BATCH_FILE_ROW_HEIGHT}px)` }),
    [start]
  );

  return { containerRef, onScroll, start, end, spacerStyle, windowStyle };
}

async function filesFromDataTransfer(dataTransfer: DataTransfer) {
  const items = Array.from(dataTransfer.items ?? []);
  if (!items.length) return Array.from(dataTransfer.files ?? []);

  const files: File[] = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const entry = (item as DataTransferItemWithEntry).webkitGetAsEntry?.();
    if (entry) {
      files.push(...(await filesFromEntry(entry)));
    } else {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files.length ? files : Array.from(dataTransfer.files ?? []);
}

async function filesFromEntry(entry: WebkitFileSystemEntry, parentPath = ""): Promise<File[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      (entry as WebkitFileSystemFileEntry).file(resolve, reject);
    });
    const relativePath = `${parentPath}${file.name}`;
    try {
      Object.defineProperty(file, "webkitRelativePath", {
        configurable: true,
        value: relativePath
      });
    } catch {
      // Some browsers keep File metadata read-only. The file is still usable.
    }
    return [file];
  }

  if (!entry.isDirectory) return [];

  const directory = entry as WebkitFileSystemDirectoryEntry;
  const reader = directory.createReader();
  const entries: WebkitFileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<WebkitFileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (!batch.length) break;
    entries.push(...batch);
  }

  const nextPath = `${parentPath}${entry.name}/`;
  const nested = await Promise.all(entries.map((item) => filesFromEntry(item, nextPath)));
  return nested.flat();
}

export default function App() {
  const [mode, setMode] = useState<AppMode>(() => modeFromLocation());
  const [step, setStep] = useState<Step>("upload");
  const [document, setDocument] = useState<UploadedDocument | null>(null);
  const [schemaName, setSchemaName] = useState("document_schema");
  const [schemaDescription, setSchemaDescription] = useState("");
  const [fields, setFields] = useState<SchemaField[]>(initialFields);
  const [regions, setRegions] = useState<SchemaRegion[]>([]);
  const [schema, setSchema] = useState<SavedSchema | null>(null);
  const [schemaDirty, setSchemaDirty] = useState(false);
  const [schemaSaveStatus, setSchemaSaveStatus] = useState<"idle" | "pending" | "saving" | "saved" | "error">("idle");
  const [schemaSaveMessage, setSchemaSaveMessage] = useState<string | null>(null);
  const [schemaJsonInput, setSchemaJsonInput] = useState("");
  const [job, setJob] = useState<ExtractionJob | null>(null);
  const [edits, setEdits] = useState<Record<string, ExtractionValue>>({});
  const [editedKeys, setEditedKeys] = useState<string[]>([]);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [activePage, setActivePage] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [zoomMode, setZoomMode] = useState<ZoomMode>("fitWidth");
  const [rotation, setRotation] = useState(0);
  const [regionsVisible, setRegionsVisible] = useState(false);
  const [leftPanePercent, setLeftPanePercent] = useState(() => readPersistedLeftPanePercent());
  const [recentDocuments, setRecentDocuments] = useState<UploadedDocument[]>([]);
  const [recentSchemas, setRecentSchemas] = useState<SavedSchema[]>([]);
  const [recentJobs, setRecentJobs] = useState<ExtractionJob[]>([]);
  const [rawExtraction, setRawExtraction] = useState<RawExtraction | null>(null);
  const [recentRawExtractions, setRecentRawExtractions] = useState<RawExtraction[]>([]);
  const [rawOptions, setRawOptions] = useState<RawExtractionOptions>({ includeImages: true, includeFormulas: false });
  const [rawHistoryCollapsed, setRawHistoryCollapsed] = useState(false);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [vlmSettings, setVlmSettings] = useState<VlmSettings | null>(null);
  const [homeWorkflowRuns, setHomeWorkflowRuns] = useState<HomeWorkflowRun[]>([]);
  const [vlmApiKey, setVlmApiKey] = useState("");
  const [vlmModelName, setVlmModelName] = useState("");
  const [libreOfficePath, setLibreOfficePath] = useState("/Applications/LibreOffice.app/Contents/MacOS/soffice");
  const [vlmReasoningEffort, setVlmReasoningEffort] = useState("minimal");
  const [vlmVerbosity, setVlmVerbosity] = useState("low");
  const [vlmMaxCompletionTokens, setVlmMaxCompletionTokens] = useState("");
  const [vlmTopP, setVlmTopP] = useState("");
  const [vlmServiceTier, setVlmServiceTier] = useState("");
  const [batchMaxWorkers, setBatchMaxWorkers] = useState("4");
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingRecommendation, setPendingRecommendation] = useState<SchemaRecommendation | null>(null);
  const [archiveQuery, setArchiveQuery] = useState("");
  const [archiveStatus, setArchiveStatus] = useState("");
  const [archiveResults, setArchiveResults] = useState<ArchiveSearchResult[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [exportPresets, setExportPresets] = useState<ExportPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [reviewedFields, setReviewedFields] = useState<string[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [historyTab, setHistoryTab] = useState<HistoryTab>("documents");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [schemaLibraryOpen, setSchemaLibraryOpen] = useState(false);
  const [batchFiles, setBatchFiles] = useState<File[]>([]);
  const [draftBatchIndex, setDraftBatchIndex] = useState(0);
  const [batchMessage, setBatchMessage] = useState<string | null>(null);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [activeBatchItemId, setActiveBatchItemId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspaceRestored, setWorkspaceRestored] = useState(false);
  const documentCacheRef = useRef<Map<string, UploadedDocument>>(new Map());
  const schemaCacheRef = useRef<Map<string, SavedSchema>>(new Map());
  const jobCacheRef = useRef<Map<string, ExtractionJob>>(new Map());
  const loadJobRequestRef = useRef(0);
  const loadJobAbortRef = useRef<AbortController | null>(null);
  const schemaAutoSaveTimerRef = useRef<number | null>(null);
  const schemaAutoSaveRequestRef = useRef(0);
  const schemaDraftKeyRef = useRef("");

  useEffect(() => {
    void bootstrapWorkspace();
  }, []);

  useEffect(() => {
    if (!workspaceRestored) return;
    savePersistedWorkspaceState({
      mode,
      step,
      document_id: document?.document_id ?? null,
      schema_id: schema?.id ?? null,
      job_id: job?.job_id ?? null,
      batch_id: activeBatchId,
      batch_item_id: activeBatchItemId,
      raw_id: rawExtraction?.id ?? null,
      active_page: activePage
    });
  }, [
    workspaceRestored,
    mode,
    step,
    document?.document_id,
    schema?.id,
    job?.job_id,
    activeBatchId,
    activeBatchItemId,
    rawExtraction?.id,
    activePage
  ]);

  useEffect(() => {
    const onPopState = () => setMode(modeFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (schema?.id) {
      void loadExportPresets(schema.id);
    }
  }, [schema?.id]);

  useEffect(() => {
    if (!batchFiles.length) {
      setDraftBatchIndex(0);
      return;
    }
    setDraftBatchIndex((index) => Math.min(index, batchFiles.length - 1));
  }, [batchFiles.length]);

  const schemaPayloadFields = useMemo(() => fields.map(stripLocalId), [fields]);
  const schemaPayloadRegions = useMemo(() => regions.map(normalizeSchemaRegion).filter(Boolean) as SchemaRegion[], [regions]);
  const schemaPreview = useMemo(
    () =>
      JSON.stringify(
        {
          name: schemaName,
          display_name: schemaName,
          description: schemaDescription || null,
          regions: schemaPayloadRegions,
          fields: schemaPayloadFields
        },
        null,
        2
      ),
    [schemaName, schemaDescription, schemaPayloadFields, schemaPayloadRegions]
  );

  useEffect(() => {
    schemaDraftKeyRef.current = schemaPreview;
  }, [schemaPreview]);

  const schemaDownloadUrl = useMemo(
    () => `data:application/json;charset=utf-8,${encodeURIComponent(schemaPreview)}`,
    [schemaPreview]
  );

  const activeImageUrl = useMemo(() => {
    if (!document?.pages.length) return null;
    return documentPageImageSrc(document.pages[activePage]);
  }, [document, activePage]);

  const rawPdfUrl = useMemo(() => (rawExtraction?.pdf_url ? `${API_BASE}${rawExtraction.pdf_url}` : null), [rawExtraction]);
  const rawHtmlUrl = useMemo(() => (rawExtraction?.html_url ? `${API_BASE}${rawExtraction.html_url}` : null), [rawExtraction]);
  const selectedDraftFile = batchFiles[draftBatchIndex] ?? batchFiles[0] ?? null;
  const selectedDraftUrl = useObjectUrl(selectedDraftFile && isImageFile(selectedDraftFile) ? selectedDraftFile : null);
  const draftRegionTarget = useMemo<RegionEditorTarget | null>(() => {
    if (!selectedDraftFile || !selectedDraftUrl || !isImageFile(selectedDraftFile)) return null;
    return {
      page_count: 1,
      pages: [{ id: `draft_${draftBatchIndex}`, page: 1, image_url: selectedDraftUrl }]
    };
  }, [draftBatchIndex, selectedDraftFile, selectedDraftUrl]);
  const documentRegionTarget = useMemo<RegionEditorTarget | null>(() => {
    if (!document) return null;
    return {
      page_count: document.page_count,
      pages: document.pages.map((page) => ({ id: page.id, page: page.page, image_url: page.image_url }))
    };
  }, [document]);
  const activeRegionTarget = documentRegionTarget ?? draftRegionTarget;
  const activeRegionPage = document ? activePage : 0;

  const result = job?.result ?? null;
  const currentValues = Object.keys(edits).length ? edits : result?.corrected_output?.values ?? result?.validated_output.values ?? {};
  const templates = recentSchemas.filter((item) => item.is_template || item.pinned);
  const schemaNameConflict = useMemo(
    () => findSavedSchemaNameConflict(schemaName, recentSchemas, schema?.ephemeral ? null : schema),
    [schemaName, recentSchemas, schema]
  );
  const schemaValidationError = useMemo(
    () => validateFields(schemaPayloadFields, schemaPayloadRegions),
    [schemaPayloadFields, schemaPayloadRegions]
  );
  const activeSchemaSummary = {
    name: schema?.display_name || schema?.name || schemaName.trim() || "Untitled schema",
    fieldCount: schemaPayloadFields.length,
    regionCount: schemaPayloadRegions.length,
    ready: Boolean(schemaName.trim()) && !schemaValidationError && !schemaNameConflict,
    status: schemaSaveStatusLabel(schemaSaveStatus, schema),
    message: !schemaName.trim()
      ? "Schema 이름을 입력하세요."
      : schemaNameConflict
        ? `이미 같은 이름의 schema가 있습니다: ${schemaNameConflict.display_name || schemaNameConflict.name}`
        : schemaValidationHint(schemaValidationError)
  };
  const activeBatch = useMemo(
    () => (activeBatchId ? batches.find((batch) => batch.id === activeBatchId) ?? null : null),
    [batches, activeBatchId]
  );
  const activeBatchItem = useMemo(() => {
    if (!activeBatch) return null;
    return activeBatch.items.find((item) => item.id === activeBatchItemId) ?? activeBatch.items[0] ?? null;
  }, [activeBatch, activeBatchItemId]);
  const hasActiveBatch = useMemo(
    () =>
      batches.some(
        (batch) =>
          batch.status === "running" ||
          batch.items.some((item) => item.status === "queued" || item.status === "running")
      ),
    [batches]
  );
  const shouldPollActiveBatch = Boolean(activeBatchId && (!activeBatch || batchCanCancel(activeBatch)));
  const batchPollingActive = shouldPollActiveBatch || hasActiveBatch;
  const hasPreparedSchema =
    Boolean(document) || Boolean(schema) || batchFiles.length > 0 || schemaDirty || hasMeaningfulSchema(fields);
  const schemaLibraryVisible = schemaLibraryOpen && hasPreparedSchema;
  const keyInfoWorkspaceColumns = schemaLibraryVisible ? "minmax(0, 1fr) minmax(420px, 460px)" : "minmax(0, 1fr)";
  const keyInfoPaneColumns = `minmax(320px, ${leftPanePercent}%) 12px minmax(380px, 1fr)`;

  useEffect(() => {
    if (!workspaceRestored || mode !== "key-info") return;
    if (schemaAutoSaveTimerRef.current) {
      window.clearTimeout(schemaAutoSaveTimerRef.current);
      schemaAutoSaveTimerRef.current = null;
    }

    if (!schemaDirty) {
      setSchemaSaveStatus(schema ? "saved" : "idle");
      setSchemaSaveMessage(null);
      return;
    }
    if (!schemaName.trim()) {
      setSchemaSaveStatus("pending");
      setSchemaSaveMessage("Schema 이름을 입력하면 자동 저장됩니다.");
      return;
    }
    if (schemaValidationError) {
      setSchemaSaveStatus("pending");
      setSchemaSaveMessage(schemaValidationError);
      return;
    }
    if (schemaNameConflict) {
      setSchemaSaveStatus("error");
      setSchemaSaveMessage(`이미 저장된 schema 이름입니다: ${schemaNameConflict.display_name || schemaNameConflict.name}`);
      return;
    }

    setSchemaSaveStatus("pending");
    setSchemaSaveMessage(null);
    const draftKey = schemaPreview;
    schemaAutoSaveTimerRef.current = window.setTimeout(() => {
      void autoSaveSchema(draftKey);
    }, 900);

    return () => {
      if (schemaAutoSaveTimerRef.current) {
        window.clearTimeout(schemaAutoSaveTimerRef.current);
        schemaAutoSaveTimerRef.current = null;
      }
    };
  }, [
    workspaceRestored,
    mode,
    schemaDirty,
    schemaName,
    schemaPreview,
    schemaValidationError,
    schemaNameConflict,
    schema
  ]);

  useEffect(() => {
    if (!batchPollingActive) return;
    const pollBatch = () => {
      if (activeBatchId && shouldPollActiveBatch) {
        void refreshBatch(activeBatchId);
      } else {
        void refreshBatches();
      }
      void refreshActiveBatchItemJob();
    };
    pollBatch();
    const intervalId = window.setInterval(() => {
      pollBatch();
    }, 1000);
    return () => window.clearInterval(intervalId);
  }, [batchPollingActive, shouldPollActiveBatch, activeBatchId, activeBatchItemId, job?.job_id, job?.result_id]);

  async function bootstrapWorkspace() {
    await refreshAll(false);
    await restoreWorkspaceState();
    setWorkspaceRestored(true);
  }

  async function refreshAll(reloadCurrent = true) {
    await Promise.all([refreshHistory(), refreshRawHistory(), refreshSystemStatus(), loadVlmSettings(), refreshHomeWorkflowRuns(), refreshBatches(), searchArchive()]);
    if (reloadCurrent) {
      await refreshCurrentWorkspace();
    }
  }

  async function refreshCurrentWorkspace() {
    try {
      if (mode === "raw" && rawExtraction?.id) {
        await loadRawExtraction(rawExtraction.id);
        return;
      }
      if (mode === "key-info" && activeBatchId && activeBatchItem) {
        await refreshBatches();
        await refreshActiveBatchItemJob();
        return;
      }
      if (job?.job_id) {
        await loadJob(job.job_id);
        return;
      }
      if (document?.document_id) {
        const loadedDocument = await api<UploadedDocument>(`/api/documents/${document.document_id}`);
        setDocument(loadedDocument);
        setActivePage((page) => Math.min(Math.max(0, page), Math.max(0, loadedDocument.page_count - 1)));
      }
      if (schema?.id) {
        const loadedSchema = await api<SavedSchema>(`/api/schemas/${schema.id}`);
        applySchema(loadedSchema);
      }
    } catch (err) {
      setError(toFriendlyError(err));
    }
  }

  async function restoreWorkspaceState() {
    const saved = readPersistedWorkspaceState();
    if (!saved) return;
    const savedMode = isAppMode(saved.mode) ? saved.mode : modeFromLocation();
    replaceModeHash(savedMode);
    setMode(savedMode);
    try {
      if (savedMode === "raw" && saved.raw_id) {
        const loadedRaw = await api<RawExtraction>(`/api/raw-extractions/${saved.raw_id}`);
        setRawExtraction(loadedRaw);
        return;
      }

      if (savedMode !== "key-info") {
        return;
      }

      if (savedMode === "key-info" && saved.batch_id) {
        const loadedBatch = await api<Batch>(`/api/batches/${saved.batch_id}`);
        setBatches((current) => [loadedBatch, ...current.filter((batch) => batch.id !== loadedBatch.id)].slice(0, 12));
        const selectedItem =
          loadedBatch.items.find((item) => item.id === saved.batch_item_id) ?? loadedBatch.items[0] ?? null;
        setActiveBatchId(loadedBatch.id);
        setActiveBatchItemId(selectedItem?.id ?? null);
        if (selectedItem) {
          await loadJob(selectedItem.job_id, { preserveBatch: true, forceReviewStep: true, silent: true });
          setStep("review");
        }
        return;
      }

      if (saved.job_id) {
        const loadedJob = await api<ExtractionJob>(`/api/extraction-jobs/${saved.job_id}`);
        const [loadedDocument, loadedSchema] = await Promise.all([
          api<UploadedDocument>(`/api/documents/${loadedJob.document_id}`),
          api<SavedSchema>(`/api/schemas/${loadedJob.schema_id}`)
        ]);
        applyDocument(loadedDocument);
        applySchema(loadedSchema);
        setJob(loadedJob);
        if (loadedJob.result) {
          setEdits(loadedJob.result.corrected_output?.values ?? loadedJob.result.validated_output.values);
          setReviewedFields(loadedJob.result.reviewed_fields ?? []);
          setEditedKeys([]);
          setReviewFilter("all");
          void loadAuditEvents("extraction_result", loadedJob.result.id);
        }
        setStep(saved.step ?? (loadedJob.result ? "review" : "schema"));
        setActivePage(Math.min(Math.max(0, saved.active_page ?? 0), Math.max(0, loadedDocument.page_count - 1)));
        return;
      }

      if (saved.document_id) {
        const loadedDocument = await api<UploadedDocument>(`/api/documents/${saved.document_id}`);
        applyDocument(loadedDocument);
        setActivePage(Math.min(Math.max(0, saved.active_page ?? 0), Math.max(0, loadedDocument.page_count - 1)));
      }
      if (saved.schema_id) {
        const loadedSchema = await api<SavedSchema>(`/api/schemas/${saved.schema_id}`);
        applySchema(loadedSchema);
      }
      if (saved.document_id || saved.schema_id) {
        setStep(saved.step === "review" ? "schema" : saved.step);
      }
    } catch {
      clearPersistedWorkspaceState();
    }
  }

  async function refreshHistory() {
    try {
      const [documents, schemas, jobs] = await Promise.all([
        api<UploadedDocument[]>("/api/documents?limit=12"),
        api<SavedSchema[]>("/api/schemas"),
        api<ExtractionJob[]>("/api/extraction-jobs?limit=12")
      ]);
      setRecentDocuments(documents);
      setRecentSchemas(schemas);
      setRecentJobs(jobs);
    } catch {
      // History should not block the primary workflow.
    }
  }

  async function refreshSystemStatus() {
    try {
      setSystemStatus(await api<SystemStatus>("/api/system/status"));
    } catch {
      setSystemStatus(null);
    }
  }

  async function refreshHomeWorkflowRuns() {
    try {
      setHomeWorkflowRuns(await api<HomeWorkflowRun[]>("/api/workflow-runs?limit=3"));
    } catch {
      setHomeWorkflowRuns([]);
    }
  }

  async function loadVlmSettings() {
    try {
      const settings = await api<VlmSettings>("/api/settings/vlm");
      setVlmSettings(settings);
      setVlmModelName(settings.model_name ?? "");
      setLibreOfficePath(settings.libreoffice_path ?? "/Applications/LibreOffice.app/Contents/MacOS/soffice");
      setVlmReasoningEffort(settings.reasoning_effort ?? "minimal");
      setVlmVerbosity(settings.verbosity ?? "low");
      setVlmMaxCompletionTokens(settings.max_completion_tokens ?? "");
      setVlmTopP(settings.top_p ?? "");
      setVlmServiceTier(settings.service_tier ?? "");
      setBatchMaxWorkers(String(settings.batch_max_workers ?? 4));
    } catch {
      setVlmSettings(null);
    }
  }

  async function saveVlmSettings() {
    setBusy(".env 저장 중");
    setError(null);
    setSettingsMessage(null);
    try {
      const settings = await api<VlmSettings>("/api/settings/vlm", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: vlmApiKey,
          model_name: vlmModelName,
          libreoffice_path: libreOfficePath,
          reasoning_effort: vlmReasoningEffort,
          verbosity: vlmVerbosity,
          max_completion_tokens: vlmMaxCompletionTokens,
          top_p: vlmTopP,
          service_tier: vlmServiceTier,
          batch_max_workers: Number.parseInt(batchMaxWorkers, 10) || 4,
          provider: "auto"
        })
      });
      setVlmSettings(settings);
      setVlmApiKey("");
      setSettingsMessage(".env 저장 완료");
      setSettingsOpen(false);
      await refreshSystemStatus();
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  async function clearParsingHistory() {
    const confirmed = window.confirm(
      "저장된 문서, 추출 job/result, batch, raw extraction 기록을 모두 삭제합니다. 저장된 schema는 유지됩니다. 계속할까요?"
    );
    if (!confirmed) return;
    setBusy("파싱 기록 삭제 중");
    setError(null);
    setSettingsMessage(null);
    try {
      const cleared = await api<MaintenanceClearResponse>("/api/maintenance/parsing-history", { method: "DELETE" });
      setDocument(null);
      setJob(null);
      setRawExtraction(null);
      setActiveBatchId(null);
      setActiveBatchItemId(null);
      setBatchFiles([]);
      setBatches([]);
      setRecentDocuments([]);
      setRecentJobs([]);
      setRecentRawExtractions([]);
      setArchiveResults([]);
      setEdits({});
      setEditedKeys([]);
      setReviewedFields([]);
      setAuditEvents([]);
      setReviewFilter("all");
      setStep("upload");
      clearPersistedWorkspaceState();
      await refreshHistory();
      setSettingsMessage(`파싱 기록 삭제 완료: ${cleared.counts.documents ?? 0}개 문서, ${cleared.counts.extraction_jobs ?? 0}개 job`);
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  async function refreshBatches() {
    try {
      const items = await api<Batch[]>("/api/batches?limit=12");
      if (activeBatchId && !items.some((batch) => batch.id === activeBatchId)) {
        try {
          const active = await api<Batch>(`/api/batches/${activeBatchId}`);
          setBatches([active, ...items].slice(0, 12));
          return;
        } catch {
          // If the active batch no longer exists, fall back to recent batches.
        }
      }
      setBatches(items);
    } catch {
      // Keep the current UI state. A transient polling failure should not stop the next polling tick.
    }
  }

  async function refreshBatch(batchId: string) {
    try {
      const nextBatch = await api<Batch>(`/api/batches/${batchId}`);
      setBatches((current) => [nextBatch, ...current.filter((item) => item.id !== nextBatch.id)].slice(0, 12));
    } catch {
      await refreshBatches();
    }
  }

  async function refreshRawHistory() {
    try {
      const items = await api<RawExtraction[]>("/api/raw-extractions?limit=12");
      setRecentRawExtractions(items);
    } catch {
      setRecentRawExtractions([]);
    }
  }

  async function uploadRawFile(file: File, options: RawExtractionOptions) {
    setBusy("원문 데이터 추출 중");
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("include_images", String(options.includeImages));
      form.append("include_formulas", String(options.includeFormulas));
      const extracted = await api<RawExtraction>("/api/raw-extractions", {
        method: "POST",
        body: form
      });
      setRawExtraction(extracted);
      await refreshRawHistory();
      if (extracted.status === "failed") {
        setError(extracted.error_message || "원문 데이터 추출에 실패했습니다.");
      }
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  async function loadRawExtraction(rawId: string) {
    setBusy("원문 추출 결과 로드 중");
    setError(null);
    try {
      const loaded = await api<RawExtraction>(`/api/raw-extractions/${rawId}`);
      setRawExtraction(loaded);
      if (loaded.status === "failed") {
        setError(loaded.error_message || "원문 데이터 추출에 실패했습니다.");
      }
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  async function searchArchive(nextQuery = archiveQuery, nextStatus = archiveStatus) {
    try {
      const params = new URLSearchParams();
      if (nextQuery.trim()) params.set("q", nextQuery.trim());
      if (nextStatus) params.set("status", nextStatus);
      params.set("limit", "12");
      setArchiveResults(await api<ArchiveSearchResult[]>(`/api/archive/search?${params.toString()}`));
    } catch {
      setArchiveResults([]);
    }
  }

  async function loadAuditEvents(entityType: string, entityId: string) {
    try {
      setAuditEvents(await api<AuditEvent[]>(`/api/audit-events?entity_type=${entityType}&entity_id=${entityId}&limit=8`));
    } catch {
      setAuditEvents([]);
    }
  }

  async function loadExportPresets(schemaId: string) {
    try {
      setExportPresets(await api<ExportPreset[]>(`/api/export-presets?schema_id=${schemaId}`));
    } catch {
      setExportPresets([]);
    }
  }

  async function uploadFile(file: File) {
    setBusy("문서 업로드 중");
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const uploaded = await api<UploadedDocument>("/api/documents", {
        method: "POST",
        body: form
      });
      setActiveBatchId(null);
      setActiveBatchItemId(null);
      applyDocument(uploaded);
      setStep("schema");
      await refreshHistory();
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  async function recommendSchema() {
    if (!document) {
      setError("AI 추천 schema를 사용하려면 먼저 문서를 업로드하세요.");
      return;
    }
    setBusy("AI schema 추천 중");
    setError(null);
    try {
      const recommendation = await api<SchemaRecommendation>("/api/schemas/recommendations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_id: document.document_id })
      });
      if (schemaDirty || hasMeaningfulSchema(fields)) {
        setPendingRecommendation(recommendation);
      } else {
        applyRecommendation(recommendation);
      }
      const updatedDocument = await api<UploadedDocument>(`/api/documents/${document.document_id}`);
      setDocument(updatedDocument);
      await refreshHistory();
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  async function recommendSchemaDescription() {
    const validationError = validateFields(schemaPayloadFields, schemaPayloadRegions);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy("스키마 설명 수정 중");
    setError(null);
    try {
      const recommendation = await api<SchemaDescriptionRecommendation>("/api/schemas/description-recommendations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document_id: document?.document_id ?? null,
          name: schemaName.trim() || "draft_schema",
          current_description: schemaDescription || null,
          regions: schemaPayloadRegions,
          fields: schemaPayloadFields
        })
      });
      setSchemaDescription(recommendation.description);
      setSchemaDirty(true);
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  function applyRecommendation(recommendation: SchemaRecommendation) {
    setSchema(null);
    setSchemaName(recommendation.name || "ai_recommended_schema");
    setSchemaDescription(recommendation.description ?? "");
    setFields(toSchemaFields(recommendation.fields));
    setRegions([]);
    setSchemaDirty(true);
    setPendingRecommendation(null);
    setStep("schema");
  }

  async function persistSchema(options: { silent: boolean; draftKey?: string }) {
    const validationError = validateFields(schemaPayloadFields, schemaPayloadRegions);
    if (validationError) {
      if (!options.silent) setError(validationError);
      setSchemaSaveMessage(validationError);
      return null;
    }
    const conflict = findSavedSchemaNameConflict(schemaName, recentSchemas, schema?.ephemeral ? null : schema);
    if (conflict) {
      const message = `이미 저장된 schema 이름입니다: ${conflict.display_name || conflict.name}. 드롭다운에서 불러오거나 다른 이름으로 저장하세요.`;
      if (!options.silent) {
        setError(message);
      }
      setSchemaSaveMessage(message);
      return null;
    }
    if (!options.silent) {
      setBusy(schema ? "Schema 저장 중" : "Schema 생성 중");
      setError(null);
    }
    try {
      const body = JSON.stringify({
        name: schemaName,
        display_name: schemaName,
        description: schemaDescription || null,
        regions: schemaPayloadRegions,
        fields: schemaPayloadFields
      });
      const saved = await api<SavedSchema>(schema ? `/api/schemas/${schema.id}` : "/api/schemas", {
        method: schema ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body
      });
      setSchema(saved);
      schemaCacheRef.current.set(saved.id, saved);
      if (!options.draftKey || schemaDraftKeyRef.current === options.draftKey) {
        setSchemaDirty(false);
        setSchemaSaveStatus("saved");
        setSchemaSaveMessage(null);
      }
      await refreshHistory();
      return saved;
    } catch (err) {
      const message = toFriendlyError(err);
      setSchemaSaveMessage(message);
      if (!options.silent) setError(message);
      return null;
    } finally {
      if (!options.silent) setBusy(null);
    }
  }

  async function autoSaveSchema(draftKey: string) {
    const requestId = ++schemaAutoSaveRequestRef.current;
    setSchemaSaveStatus("saving");
    const saved = await persistSchema({ silent: true, draftKey });
    if (requestId !== schemaAutoSaveRequestRef.current) return;
    if (saved) {
      setSchemaSaveStatus(schemaDraftKeyRef.current === draftKey ? "saved" : "pending");
    } else {
      setSchemaSaveStatus("error");
    }
  }

  async function runExtraction() {
    if (!document) {
      setError("먼저 문서를 업로드하세요.");
      return;
    }
    const validationError = validateFields(schemaPayloadFields, schemaPayloadRegions);
    if (validationError) {
      setError(validationError);
      return;
    }
    const useSavedSchema = Boolean(schema && !schemaDirty && !schema.ephemeral);

    setBusy("핵심 정보 추출 중");
    setError(null);
    try {
      const created = useSavedSchema
        ? await api<ExtractionJob>("/api/extraction-jobs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              document_id: document.document_id,
              schema_id: schema!.id
            })
          })
        : await api<ExtractionJob>("/api/extraction-jobs/draft", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              document_id: document.document_id,
              schema: {
                name: schemaName.trim() || "draft_schema",
                display_name: schemaName.trim() || "draft_schema",
                description: schemaDescription || null,
                regions: schemaPayloadRegions,
                fields: schemaPayloadFields
              }
            })
          });
      setActiveBatchId(null);
      setActiveBatchItemId(null);
      setJob(created);
      const completed = await pollJob(created.job_id);
      setJob(completed);
      if (completed.result) {
        const nextValues = completed.result.corrected_output?.values ?? completed.result.validated_output.values;
        setEdits(nextValues);
        setEditedKeys([]);
        setReviewedFields(completed.result.reviewed_fields ?? []);
        setReviewFilter("all");
        setStep("review");
        void loadAuditEvents("extraction_result", completed.result.id);
      }
      if (completed.status === "failed") {
        setError(completed.error_message || "추출에 실패했습니다.");
      }
      await refreshHistory();
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  async function saveCorrections() {
    if (!result) return;
    setBusy("수정 결과 저장 중");
    setError(null);
    try {
      const correctedOutput: ValidatedOutput = {
        ...(result.corrected_output ?? result.validated_output),
        values: edits
      };
      const updated = await api<ExtractionResult>(`/api/extraction-results/${result.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ corrected_output: correctedOutput, reviewed_fields: reviewedFields })
      });
      setJob((current) => (current ? { ...current, result: updated } : current));
      setReviewedFields(updated.reviewed_fields ?? []);
      await loadAuditEvents("extraction_result", updated.id);
      await refreshHistory();
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  async function loadDocument(documentId: string) {
    setBusy("문서 로드 중");
    setError(null);
    try {
      setActiveBatchId(null);
      setActiveBatchItemId(null);
      const loaded = await api<UploadedDocument>(`/api/documents/${documentId}`);
      applyDocument(loaded);
      void loadAuditEvents("document", loaded.document_id);
      const jobs = await api<ExtractionJob[]>(`/api/extraction-jobs?document_id=${documentId}&limit=1`);
      if (jobs[0]) {
        setJob(jobs[0]);
        const loadedSchema = await api<SavedSchema>(`/api/schemas/${jobs[0].schema_id}`);
        applySchema(loadedSchema);
        if (jobs[0].result) {
          setEdits(jobs[0].result.corrected_output?.values ?? jobs[0].result.validated_output.values);
          setReviewedFields(jobs[0].result.reviewed_fields ?? []);
          setEditedKeys([]);
          setReviewFilter("all");
          setStep("review");
          void loadAuditEvents("extraction_result", jobs[0].result.id);
        } else {
          setStep("schema");
        }
      } else {
        setStep("schema");
      }
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  async function loadSchema(schemaId: string) {
    setBusy("Schema 로드 중");
    setError(null);
    try {
      setActiveBatchId(null);
      setActiveBatchItemId(null);
      const loaded = await getCachedSchema(schemaId, { force: true });
      applySchema(loaded);
      setStep("schema");
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  async function deleteSchema(schemaId: string) {
    const target = recentSchemas.find((item) => item.id === schemaId) ?? (schema?.id === schemaId ? schema : null);
    if (!target) return;
    setBusy("Schema 삭제 중");
    setError(null);
    try {
      await api<SavedSchema>(`/api/schemas/${schemaId}`, { method: "DELETE" });
      schemaCacheRef.current.delete(schemaId);
      setRecentSchemas((current) => current.filter((item) => item.id !== schemaId));
      if (schema?.id === schemaId) {
        startNewSchemaDraft();
      }
      await refreshHistory();
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  async function getCachedDocument(documentId: string, options: { signal?: AbortSignal } = {}) {
    const cached = documentCacheRef.current.get(documentId);
    if (cached) return cached;
    const loaded = await api<UploadedDocument>(`/api/documents/${documentId}`, { signal: options.signal });
    documentCacheRef.current.set(documentId, loaded);
    return loaded;
  }

  async function getCachedSchema(schemaId: string, options: { force?: boolean; signal?: AbortSignal } = {}) {
    const cached = schemaCacheRef.current.get(schemaId);
    if (cached && !options.force) return cached;
    const loaded = await api<SavedSchema>(`/api/schemas/${schemaId}`, { signal: options.signal });
    schemaCacheRef.current.set(schemaId, loaded);
    return loaded;
  }

  function applyLoadedJob(
    loadedJob: ExtractionJob,
    loadedDocument: UploadedDocument,
    loadedSchema: SavedSchema,
    options: { forceReviewStep?: boolean } = {}
  ) {
    applyDocument(loadedDocument, { clearExtractionState: false });
    if (!schema || schema.id !== loadedSchema.id) {
      applySchema(loadedSchema);
    }
    setJob(loadedJob);
    if (loadedJob.result) {
      setEdits(loadedJob.result.corrected_output?.values ?? loadedJob.result.validated_output.values);
      setReviewedFields(loadedJob.result.reviewed_fields ?? []);
      setEditedKeys([]);
      setReviewFilter("all");
      setStep("review");
      void loadAuditEvents("extraction_result", loadedJob.result.id);
    } else {
      setStep(options.forceReviewStep ? "review" : "schema");
    }
  }

  async function loadJob(
    jobId: string,
    options: { preserveBatch?: boolean; forceReviewStep?: boolean; silent?: boolean } = {}
  ) {
    const requestId = ++loadJobRequestRef.current;
    loadJobAbortRef.current?.abort();
    const controller = new AbortController();
    loadJobAbortRef.current = controller;
    if (!options.silent) setBusy("추출 결과 로드 중");
    setError(null);
    try {
      if (!options.preserveBatch) {
        setActiveBatchId(null);
        setActiveBatchItemId(null);
      }

      const cachedJob = jobCacheRef.current.get(jobId);
      const cachedDocument = cachedJob ? documentCacheRef.current.get(cachedJob.document_id) : null;
      const cachedSchema = cachedJob ? schemaCacheRef.current.get(cachedJob.schema_id) : null;
      if (cachedJob && cachedDocument && cachedSchema) {
        applyLoadedJob(cachedJob, cachedDocument, cachedSchema, { forceReviewStep: options.forceReviewStep });
      }

      const loadedJob = await api<ExtractionJob>(`/api/extraction-jobs/${jobId}`, { signal: controller.signal });
      jobCacheRef.current.set(jobId, loadedJob);
      const [loadedDocument, loadedSchema] = await Promise.all([
        getCachedDocument(loadedJob.document_id, { signal: controller.signal }),
        getCachedSchema(loadedJob.schema_id, { signal: controller.signal })
      ]);
      if (requestId !== loadJobRequestRef.current || controller.signal.aborted) return;
      applyLoadedJob(loadedJob, loadedDocument, loadedSchema, { forceReviewStep: options.forceReviewStep });
    } catch (err) {
      if (isAbortError(err)) return;
      setError(toFriendlyError(err));
    } finally {
      if (loadJobAbortRef.current === controller) loadJobAbortRef.current = null;
      if (!options.silent && requestId === loadJobRequestRef.current) setBusy(null);
    }
  }

  async function openBatchItem(batchId: string, itemId: string, batchOverride?: Batch) {
    const sourceBatch = batchOverride ?? batches.find((batch) => batch.id === batchId) ?? (await api<Batch>(`/api/batches/${batchId}`));
    const item = sourceBatch.items.find((candidate) => candidate.id === itemId) ?? sourceBatch.items[0];
    if (!item) return;
    if (sourceBatch.id === activeBatchId && item.id === activeBatchItemId && job?.job_id === item.job_id) return;
    setBatches((current) => [sourceBatch, ...current.filter((batch) => batch.id !== sourceBatch.id)].slice(0, 12));
    setActiveBatchId(sourceBatch.id);
    setActiveBatchItemId(item.id);
    setStep("review");
    await loadJob(item.job_id, { preserveBatch: true, forceReviewStep: true, silent: true });
  }

  async function refreshActiveBatchItemJob() {
    if (!activeBatchItem) return;
    try {
      const loadedJob = await api<ExtractionJob>(`/api/extraction-jobs/${activeBatchItem.job_id}`);
      jobCacheRef.current.set(loadedJob.job_id, loadedJob);
      if (loadedJob.job_id !== job?.job_id) {
        await loadJob(loadedJob.job_id, { preserveBatch: true, forceReviewStep: true, silent: true });
        return;
      }
      setJob(loadedJob);
      if (loadedJob.result && (loadedJob.result_id !== job?.result_id || !result)) {
        setEdits(loadedJob.result.corrected_output?.values ?? loadedJob.result.validated_output.values);
        setReviewedFields(loadedJob.result.reviewed_fields ?? []);
        setEditedKeys([]);
        setReviewFilter("all");
        setStep("review");
        void loadAuditEvents("extraction_result", loadedJob.result.id);
      }
    } catch {
      // Polling should not interrupt the visible batch review workflow.
    }
  }

  function applyDocument(nextDocument: UploadedDocument, options: { clearExtractionState?: boolean } = {}) {
    const isSameDocument = document?.document_id === nextDocument.document_id;
    documentCacheRef.current.set(nextDocument.document_id, nextDocument);
    setDocument((current) => (current?.document_id === nextDocument.document_id ? current : nextDocument));
    if (!isSameDocument) {
      setActivePage(0);
      setRotation(0);
    }
    if (options.clearExtractionState === false) return;
    setJob(null);
    setEdits({});
    setEditedKeys([]);
    setReviewedFields([]);
    setAuditEvents([]);
  }

  function clearDocumentForNewUpload() {
    setDocument(null);
    setActivePage(0);
    setRotation(0);
    setJob(null);
    setActiveBatchId(null);
    setActiveBatchItemId(null);
    setEdits({});
    setEditedKeys([]);
    setReviewedFields([]);
    setAuditEvents([]);
    setReviewFilter("all");
    setStep("upload");
  }

  function applySchema(nextSchema: SavedSchema) {
    const normalized = normalizeSchemaFieldsAndRegions(nextSchema.fields, nextSchema.regions ?? []);
    schemaCacheRef.current.set(nextSchema.id, nextSchema);
    setSchema(nextSchema.ephemeral ? null : nextSchema);
    setSchemaName(nextSchema.name);
    setSchemaDescription(nextSchema.description ?? "");
    setRegions(normalized.regions);
    if (normalized.regions.length) setRegionsVisible(true);
    setFields(toSchemaFields(normalized.fields));
    setSchemaDirty(false);
  }

  function startNewSchemaDraft() {
    setSchema(null);
    setSchemaName("document_schema");
    setSchemaDescription("");
    setRegions([]);
    setFields(initialFields.map((field) => ({ ...field, local_id: createLocalId() })));
    setSchemaDirty(true);
    setSchemaSaveStatus("pending");
    setSchemaSaveMessage("Schema 이름과 필드를 입력하면 자동 저장됩니다.");
    setStep("schema");
  }

  function applySampleSchema() {
    setSchema(null);
    setSchemaName("sample_document_schema");
    setSchemaDescription("일반 업무 문서에 바로 쓸 수 있는 시작용 schema입니다.");
    setRegions([]);
    setFields(toSchemaFields(SAMPLE_SCHEMA_FIELDS));
    setSchemaDirty(true);
    setStep("schema");
  }

  function importSchemaJson() {
    try {
      const parsed = JSON.parse(schemaJsonInput) as Partial<SchemaRecommendation>;
      if (!parsed.name || !Array.isArray(parsed.fields)) {
        setError("Schema JSON에는 name과 fields가 필요합니다.");
        return;
      }
      const fieldsFromJson = parsed.fields.map((field) => ({
        key_name: String(field.key_name ?? "").trim(),
        description: String(field.description ?? "").trim(),
        output_format: field.output_format as OutputFormat,
        region_id: typeof field.region_id === "string" ? field.region_id.trim() || null : null,
        region: normalizeRegion(field.region)
      }));
      const regionsFromJson = Array.isArray((parsed as { regions?: unknown }).regions)
        ? ((parsed as { regions?: unknown[] }).regions ?? []).map(normalizeSchemaRegion).filter(Boolean) as SchemaRegion[]
        : [];
      const normalized = normalizeSchemaFieldsAndRegions(fieldsFromJson, regionsFromJson);
      const validationError = validateFields(normalized.fields, normalized.regions);
      if (validationError) {
        setError(validationError);
        return;
      }
      setSchema(null);
      setSchemaName(parsed.name);
      setSchemaDescription(parsed.description ?? "");
      setRegions(normalized.regions);
      if (normalized.regions.length) setRegionsVisible(true);
      setFields(toSchemaFields(normalized.fields));
      setSchemaDirty(true);
      setError(null);
    } catch {
      setError("Schema JSON을 해석할 수 없습니다.");
    }
  }

  function updateField(index: number, patch: Partial<FieldDefinition>) {
    setSchemaDirty(true);
    setFields((current) => current.map((field, fieldIndex) => (fieldIndex === index ? { ...field, ...patch } : field)));
  }

  function saveRegion(region: SchemaRegion) {
    const normalized = normalizeSchemaRegion(region);
    if (!normalized) return;
    setSchemaDirty(true);
    setRegionsVisible(true);
    setRegions((current) => {
      const exists = current.some((item) => item.id === normalized.id);
      return exists ? current.map((item) => (item.id === normalized.id ? normalized : item)) : [...current, normalized];
    });
  }

  function removeRegion(regionId: string) {
    setSchemaDirty(true);
    setRegions((current) => current.filter((region) => region.id !== regionId));
    setFields((current) =>
      current.map((field) => (field.region_id === regionId ? { ...field, region_id: null } : field))
    );
  }

  function addField() {
    setSchemaDirty(true);
    setFields((current) => [
      ...current,
      {
        local_id: createLocalId(),
        key_name: `field_${current.length + 1}`,
        description: "",
        output_format: "string"
      }
    ]);
  }

  function removeField(index: number) {
    setSchemaDirty(true);
    setFields((current) => current.filter((_, fieldIndex) => fieldIndex !== index));
  }

  function updateEdit(key: string, rawValue: string) {
    const field = fields.find((item) => item.key_name === key);
    const parsed = parseEditedValue(rawValue, field?.output_format ?? "string");
    setEditedKeys((current) => (current.includes(key) ? current : [...current, key]));
    setEdits((current) => ({
      ...current,
      [key]: {
        ...current[key],
        value: parsed,
        normalized_value: parsed
      }
    }));
  }

  function toggleReviewed(key: string) {
    setReviewedFields((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));
  }

  async function markSchemaAsTemplate(category = "일반") {
    if (!schema) {
      setError("템플릿으로 추가하기 전에 schema를 저장하세요.");
      return;
    }
    setBusy("템플릿 저장 중");
    setError(null);
    try {
      const updated = await api<SavedSchema>(`/api/schemas/${schema.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_template: true, template_category: category, pinned: true })
      });
      applySchema(updated);
      await refreshHistory();
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  function openBatchExtraction() {
    setBatchMessage(null);
    setBatchOpen(true);
    void refreshBatches();
  }

  function selectBatchFiles(files: FileList | null) {
    const selected = files ? Array.from(files) : [];
    const supported = sortFilesByDisplayName(
      selected.filter((file) => KIE_FILE_EXTENSIONS.has(file.name.split(".").pop()?.toLowerCase() ?? ""))
    );
    const ignoredCount = selected.length - supported.length;
    setBatchMessage(ignoredCount ? `지원하지 않는 파일 ${ignoredCount}개는 제외했습니다.` : null);
    setBatchFiles(supported);
  }

  function selectKieUploadFiles(files: FileList | File[] | null) {
    const selected = files ? Array.from(files) : [];
    const supported = sortFilesByDisplayName(
      selected.filter((file) => KIE_FILE_EXTENSIONS.has(file.name.split(".").pop()?.toLowerCase() ?? ""))
    );
    const ignoredCount = selected.length - supported.length;
    if (!supported.length) {
      setBatchFiles([]);
      setDraftBatchIndex(0);
      setBatchMessage(ignoredCount ? `지원하지 않는 파일 ${ignoredCount}개는 제외했습니다.` : null);
      return;
    }
    if (supported.length === 1) {
      setBatchFiles([]);
      setDraftBatchIndex(0);
      setBatchMessage(null);
      void uploadFile(supported[0]);
      return;
    }
    setBatchFiles(supported);
    setDraftBatchIndex(0);
    setBatchMessage(ignoredCount ? `지원하지 않는 파일 ${ignoredCount}개는 제외했습니다.` : null);
  }

  async function runBatchUpload() {
    if (!batchFiles.length) {
      setBatchMessage("배치 처리할 파일이나 폴더를 선택하세요.");
      return;
    }
    if (!schemaName.trim()) {
      setBatchMessage("우측 schema 영역에서 schema 이름을 먼저 입력하세요.");
      return;
    }
    if (schemaValidationError) {
      setBatchMessage(`우측 schema를 먼저 완성하세요. ${schemaValidationError}`);
      return;
    }
    setBusy("배치 추출 준비 중");
    setError(null);
    setBatchMessage(null);
    try {
      let selectedSchema = schema && !schema.ephemeral ? schema : null;
      if (schemaDirty || !selectedSchema) {
        setSchemaSaveStatus("saving");
        const saved = await persistSchema({ silent: true, draftKey: schemaDraftKeyRef.current });
        if (!saved) {
          setBatchMessage("현재 활성 schema를 저장하지 못해 배치 추출을 시작하지 않았습니다. 우측 schema 상태를 확인하세요.");
          return;
        }
        selectedSchema = saved;
      }
      const form = new FormData();
      form.append("schema_id", selectedSchema.id);
      batchFiles.forEach((file) => form.append("files", file));
      const batch = await api<Batch>("/api/batches", { method: "POST", body: form });
      setBatches((current) => [batch, ...current.filter((item) => item.id !== batch.id)].slice(0, 12));
      setActiveBatchId(batch.id);
      setActiveBatchItemId(batch.items[0]?.id ?? null);
      setBatchFiles([]);
      setBatchMessage(`${batch.total_count}개 파일의 배치 추출을 시작했습니다. 좌측 파일 목록에서 항목을 선택해 결과를 확인하세요.`);
      if (batch.items[0]) {
        await openBatchItem(batch.id, batch.items[0].id, batch);
      } else {
        setStep("review");
      }
      await refreshBatches();
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  async function cancelBatch(batchId: string) {
    setBusy("배치 추출 중단 중");
    setError(null);
    setBatchMessage(null);
    try {
      const canceled = await api<Batch>(`/api/batches/${batchId}/cancel`, { method: "POST" });
      setBatches((current) => current.map((item) => (item.id === canceled.id ? canceled : item)));
      setBatchMessage("배치 중단을 요청했습니다. 이미 VLM 호출 중인 항목은 현재 호출이 끝난 뒤 중단 상태로 정리됩니다.");
      await refreshBatches();
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  async function saveDefaultExportPreset() {
    if (!schema) {
      setError("Export preset을 만들기 전에 schema를 저장하세요.");
      return;
    }
    const name = `${schemaName || "schema"} export`;
    setBusy("Export preset 저장 중");
    setError(null);
    try {
      const preset = await api<ExportPreset>("/api/export-presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema_id: schema.id,
          name,
          fields: fields.map((field) => ({ key_name: field.key_name, column_name: field.key_name, include: true }))
        })
      });
      setExportPresets((current) => [preset, ...current]);
      setSelectedPresetId(preset.id);
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  async function loadArchiveResult(item: ArchiveSearchResult) {
    if (item.job_id) {
      await loadJob(item.job_id);
    } else {
      await loadDocument(item.document_id);
    }
  }

  function navigateMode(nextMode: AppMode) {
    const hash = nextMode === "home" ? "" : `#${nextMode}`;
    window.history.pushState(null, "", `${window.location.pathname}${window.location.search}${hash}`);
    if (nextMode !== "key-info") setSchemaLibraryOpen(false);
    setMode(nextMode);
  }

  function modeTitle(currentMode: AppMode) {
    if (currentMode === "home") return "Digitize Your Document";
    if (currentMode === "raw") return "원문 데이터 추출";
    if (currentMode === "classifier") return "문서 분류";
    if (currentMode === "required-checker") return "필수 항목 확인";
    if (currentMode === "workflow") return "워크플로우 빌더";
    return "핵심 정보 추출";
  }

  function goToPage(page: number | null) {
    if (!document || !page) return;
    setActivePage(Math.min(document.page_count - 1, Math.max(0, page - 1)));
  }

  function startResize(event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const workspace =
      event.currentTarget.closest<HTMLElement>(".resize-scope") ??
      event.currentTarget.closest<HTMLElement>(".workspace");
    if (!workspace) return;
    const rect = workspace.getBoundingClientRect();
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);

    const update = (clientX: number) => {
      const percent = ((clientX - rect.left) / rect.width) * 100;
      const minLeftWidth = 320;
      const minRightWidth = 380;
      const splitterWidth = 12;
      const minPercent = Math.max(28, (minLeftWidth / rect.width) * 100);
      const maxPercent = Math.min(78, ((rect.width - splitterWidth - minRightWidth) / rect.width) * 100);
      const lowerBound = Math.min(minPercent, maxPercent);
      const upperBound = Math.max(minPercent, maxPercent);
      const nextPercent = Math.min(upperBound, Math.max(lowerBound, percent));
      setLeftPanePercent(nextPercent);
      savePersistedLeftPanePercent(nextPercent);
    };

    update(event.clientX);
    const onMove = (moveEvent: globalThis.PointerEvent) => update(moveEvent.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Digitize Your Document</p>
          <h1>{modeTitle(mode)}</h1>
        </div>
        <div className="status-strip">
          <ProviderPill status={systemStatus} />
          {mode !== "home" && (
            <button type="button" className="secondary compact" onClick={() => navigateMode("home")}>
              홈
            </button>
          )}
          {mode === "key-info" && (
            <>
              <StepPill label="업로드" active={step === "upload"} done={Boolean(document)} />
              <StepPill label="Schema" active={step === "schema"} done={Boolean(schema) && !schemaDirty} />
              <StepPill label="검수" active={step === "review"} done={Boolean(result)} />
            </>
          )}
          <button type="button" className="secondary compact" onClick={() => void refreshAll()} title="작업 화면 새로고침">
            <RefreshCw size={16} />
            새로고침
          </button>
          {mode === "home" && (
            <button
              type="button"
              className="secondary compact"
              disabled={Boolean(busy)}
              onClick={() => {
                setSettingsMessage(null);
                setSettingsOpen(true);
              }}
              title="VLM과 LibreOffice 설정"
            >
              <Settings size={16} />
              설정
            </button>
          )}
          <div className="help-trigger">
            <button type="button" className="help-button" aria-label="사용 가이드">
              <CircleHelp size={18} />
            </button>
            <div className="help-panel" role="tooltip">
              <strong>사용 흐름</strong>
              <span>문서를 업로드한 뒤 직접 schema를 정의하거나 AI 추천을 사용하세요.</span>
              <span>Schema 변경은 필드 수정 후 자동 저장됩니다.</span>
              <span>Export 전에 경고, 누락값, 수정값, 근거, 페이지를 검수하세요.</span>
            </div>
          </div>
        </div>
      </header>

      {error && <div className="alert">{error}</div>}
      {busy && (
        <div className="busy-line">
          <Loader2 size={16} className="spin" />
          {busy}
        </div>
      )}

      {mode === "home" ? (
        <HomeScreen
          onRaw={() => navigateMode("raw")}
          onKie={() => navigateMode("key-info")}
          onClassifier={() => navigateMode("classifier")}
          onRequiredChecker={() => navigateMode("required-checker")}
          onWorkflow={() => navigateMode("workflow")}
          systemStatus={systemStatus}
          vlmSettings={vlmSettings}
          workflowRuns={homeWorkflowRuns}
        />
      ) : mode === "raw" ? (
        <RawWorkspace
          rawExtraction={rawExtraction}
          recentRawExtractions={recentRawExtractions}
          rawOptions={rawOptions}
          historyCollapsed={rawHistoryCollapsed}
          pdfUrl={rawPdfUrl}
          htmlUrl={rawHtmlUrl}
          leftPanePercent={leftPanePercent}
          onUpload={(file, options) => void uploadRawFile(file, options)}
          onLoad={(id) => void loadRawExtraction(id)}
          onRawOptions={setRawOptions}
          onToggleHistory={() => setRawHistoryCollapsed((collapsed) => !collapsed)}
          onResize={startResize}
        />
      ) : mode === "classifier" || mode === "required-checker" ? (
        <ModuleWorkspace kind={mode} leftPanePercent={leftPanePercent} onResize={startResize} />
      ) : mode === "workflow" ? (
        <WorkflowBuilder
          onCreateSchema={() => navigateMode("key-info")}
          onCreateClassifier={() => navigateMode("classifier")}
          onCreateChecklist={() => navigateMode("required-checker")}
        />
      ) : (
        <main
          className="workspace"
          style={{ gridTemplateColumns: keyInfoWorkspaceColumns }}
        >
        <div className="key-info-main-grid resize-scope" style={{ gridTemplateColumns: keyInfoPaneColumns }}>
          <section className="document-pane">
            {!document ? (
              <KieUploadPanel
                selectedFiles={batchFiles}
                selectedFileUrl={selectedDraftUrl}
                selectedFileIndex={draftBatchIndex}
                regions={regions}
                showRegions={regionsVisible}
                message={batchMessage}
                activeSchemaName={activeSchemaSummary.name}
                activeSchemaFieldCount={activeSchemaSummary.fieldCount}
                activeSchemaRegionCount={activeSchemaSummary.regionCount}
                activeSchemaReady={activeSchemaSummary.ready}
                activeSchemaStatus={activeSchemaSummary.status}
                activeSchemaMessage={activeSchemaSummary.message}
                onSelectFile={setDraftBatchIndex}
                onSelectFiles={selectKieUploadFiles}
                onShowRegions={setRegionsVisible}
                onClearFiles={() => {
                  setBatchFiles([]);
                  setDraftBatchIndex(0);
                  setBatchMessage(null);
                }}
                onRunBatch={() => void runBatchUpload()}
              />
            ) : (
              <div className={activeBatch ? "document-workbench batch-active" : "document-workbench"}>
                {activeBatch && (
                  <BatchFileRail
                    batch={activeBatch}
                    activeItemId={activeBatchItem?.id ?? null}
                    onOpenItem={(itemId) => void openBatchItem(activeBatch.id, itemId)}
                    onCancelBatch={(batchId) => void cancelBatch(batchId)}
                    onRefresh={() => void refreshBatches()}
                  />
                )}
                <div className="document-viewer-panel">
                  <DocumentViewer
                    document={document}
                    activePage={activePage}
                    activeImageUrl={activeImageUrl}
                    regions={regions}
                    showRegions={regionsVisible}
                    zoom={zoom}
                    zoomMode={zoomMode}
                    rotation={rotation}
                    onPage={setActivePage}
                    onShowRegions={setRegionsVisible}
                    onZoom={setZoom}
                    onZoomMode={setZoomMode}
                    onRotation={setRotation}
                    onReplaceFile={(file) => void uploadFile(file)}
                    onClear={clearDocumentForNewUpload}
                  />
                </div>
              </div>
            )}
          </section>

          <button
            className="splitter"
            type="button"
            title="영역 너비 조절"
            aria-label="영역 너비 조절"
            onPointerDown={startResize}
          >
            <GripVertical size={18} />
          </button>

          <aside className="side-pane">
            {!hasPreparedSchema ? (
              <UploadNotes onSampleSchema={applySampleSchema} />
            ) : step !== "review" ? (
              <SchemaBuilder
                schemaName={schemaName}
                schemaDescription={schemaDescription}
                fields={fields}
                regions={regions}
                schemaPreview={schemaPreview}
                schemaDownloadUrl={schemaDownloadUrl}
                schemaJsonInput={schemaJsonInput}
                savedSchema={schema}
                schemaDirty={schemaDirty}
                schemaSaveStatus={schemaSaveStatus}
                schemaSaveMessage={schemaSaveMessage}
                document={document}
                regionTarget={activeRegionTarget}
                activePage={activeRegionPage}
                systemStatus={systemStatus}
                savedSchemas={recentSchemas}
                schemaNameConflict={schemaNameConflict}
                templates={templates}
                onSchemaName={(value) => {
                  setSchemaName(value);
                  setSchemaDirty(true);
                }}
                onSchemaDescription={(value) => {
                  setSchemaDescription(value);
                  setSchemaDirty(true);
                }}
                onLoadSavedSchema={(schemaId) => void loadSchema(schemaId)}
                onNewSchema={startNewSchemaDraft}
                onDeleteSchema={(schemaId) => void deleteSchema(schemaId)}
                onSchemaJsonInput={setSchemaJsonInput}
                onImportSchemaJson={importSchemaJson}
                onUpdateField={updateField}
                onSaveRegion={saveRegion}
                onRemoveRegion={removeRegion}
                onAddField={addField}
                onRemoveField={removeField}
                onRunExtraction={runExtraction}
                onRecommendSchema={recommendSchema}
                onRecommendSchemaDescription={recommendSchemaDescription}
                onSampleSchema={applySampleSchema}
                onLoadTemplate={(template) => {
                  applySchema(template);
                  setSchema(null);
                  setSchemaDirty(true);
                }}
                onSaveTemplate={() => void markSchemaAsTemplate()}
                onOpenLibrary={() => setSchemaLibraryOpen(true)}
                canExtract={Boolean(document)}
              />
            ) : result ? (
              <ReviewPanel
                fields={fields}
                result={result}
                values={currentValues}
                editedKeys={editedKeys}
                reviewedFields={reviewedFields}
                filter={reviewFilter}
                exportPresets={exportPresets}
                selectedPresetId={selectedPresetId}
                auditEvents={auditEvents}
                onFilter={setReviewFilter}
                onEdit={updateEdit}
                onToggleReviewed={toggleReviewed}
                onSaveCorrections={saveCorrections}
                onGoToPage={goToPage}
                onPreset={setSelectedPresetId}
                onSavePreset={() => void saveDefaultExportPreset()}
              />
            ) : activeBatch && activeBatchItem ? (
              <BatchItemStatusPanel
                batch={activeBatch}
                item={activeBatchItem}
                onRefresh={() => void refreshBatches()}
                onCancelBatch={(batchId) => void cancelBatch(batchId)}
              />
            ) : (
              <ReviewPanel
                fields={fields}
                result={result}
                values={currentValues}
                editedKeys={editedKeys}
                reviewedFields={reviewedFields}
                filter={reviewFilter}
                exportPresets={exportPresets}
                selectedPresetId={selectedPresetId}
                auditEvents={auditEvents}
                onFilter={setReviewFilter}
                onEdit={updateEdit}
                onToggleReviewed={toggleReviewed}
                onSaveCorrections={saveCorrections}
                onGoToPage={goToPage}
                onPreset={setSelectedPresetId}
                onSavePreset={() => void saveDefaultExportPreset()}
              />
            )}
            <KieUtilityDock
              onArchive={() => setArchiveOpen(true)}
              onBatch={openBatchExtraction}
            />
          </aside>
        </div>
        {schemaLibraryVisible && (
          <SchemaLibraryPanel
            schemaName={schemaName}
            schemaDescription={schemaDescription}
            fields={fields}
            regions={regions}
            schemaPreview={schemaPreview}
            schemaDownloadUrl={schemaDownloadUrl}
            schemaJsonInput={schemaJsonInput}
            savedSchema={schema}
            schemaSaveStatus={schemaSaveStatus}
            schemaSaveMessage={schemaSaveMessage}
            document={document}
            regionTarget={activeRegionTarget}
            activePage={activeRegionPage}
            systemStatus={systemStatus}
            savedSchemas={recentSchemas}
            templates={templates}
            onSchemaName={(value) => {
              setSchemaName(value);
              setSchemaDirty(true);
            }}
            onSchemaDescription={(value) => {
              setSchemaDescription(value);
              setSchemaDirty(true);
            }}
            onLoadSavedSchema={(schemaId) => void loadSchema(schemaId)}
            onNewSchema={startNewSchemaDraft}
            onDeleteSchema={(schemaId) => void deleteSchema(schemaId)}
            onSchemaJsonInput={setSchemaJsonInput}
            onImportSchemaJson={importSchemaJson}
            onSaveRegion={saveRegion}
            onRemoveRegion={removeRegion}
            onRecommendSchemaDescription={recommendSchemaDescription}
            onSampleSchema={applySampleSchema}
            onLoadTemplate={(template) => {
              applySchema(template);
              setSchema(null);
              setSchemaDirty(true);
            }}
            onSaveTemplate={() => void markSchemaAsTemplate()}
            onClose={() => setSchemaLibraryOpen(false)}
          />
        )}
        </main>
      )}
      {archiveOpen && (
        <UtilityModal title="아카이브 검색" eyebrow="저장된 결과" onClose={() => setArchiveOpen(false)}>
          <ArchivePanel
            query={archiveQuery}
            status={archiveStatus}
            results={archiveResults}
            onQuery={(value) => {
              setArchiveQuery(value);
              void searchArchive(value, archiveStatus);
            }}
            onStatus={(value) => {
              setArchiveStatus(value);
              void searchArchive(archiveQuery, value);
            }}
            onOpen={(item) => {
              setArchiveOpen(false);
              void loadArchiveResult(item);
            }}
          />
        </UtilityModal>
      )}
      {historyOpen && (
        <UtilityModal title="최근 항목" eyebrow="기록" onClose={() => setHistoryOpen(false)}>
          <HistoryPanel
            activeTab={historyTab}
            documents={recentDocuments}
            schemas={recentSchemas}
            jobs={recentJobs}
            collapsed={false}
            onTab={setHistoryTab}
            onLoadDocument={(id) => {
              setHistoryOpen(false);
              void loadDocument(id);
            }}
            onLoadSchema={(id) => {
              setHistoryOpen(false);
              void loadSchema(id);
            }}
            onLoadJob={(id) => {
              setHistoryOpen(false);
              void loadJob(id);
            }}
            onToggle={() => setHistoryOpen(false)}
          />
        </UtilityModal>
      )}
      {batchOpen && (
        <UtilityModal title="배치 업로드 및 결과" eyebrow="여러 파일" onClose={() => setBatchOpen(false)}>
          <BatchPanel
            batches={batches}
            selectedFiles={batchFiles}
            message={batchMessage}
            activeSchemaName={activeSchemaSummary.name}
            activeSchemaFieldCount={activeSchemaSummary.fieldCount}
            activeSchemaRegionCount={activeSchemaSummary.regionCount}
            activeSchemaReady={activeSchemaSummary.ready}
            activeSchemaStatus={activeSchemaSummary.status}
            activeSchemaMessage={activeSchemaSummary.message}
            onSelectFiles={selectBatchFiles}
            onClearFiles={() => {
              setBatchFiles([]);
              setDraftBatchIndex(0);
              setBatchMessage(null);
            }}
            onRunBatch={() => void runBatchUpload()}
            onCancelBatch={(batchId) => void cancelBatch(batchId)}
            onRefresh={() => void refreshBatches()}
            onOpenItem={(batchId, itemId) => {
              setBatchOpen(false);
              void openBatchItem(batchId, itemId);
            }}
          />
        </UtilityModal>
      )}
      {pendingRecommendation && (
        <RecommendationDiffModal
          currentFields={fields}
          recommendation={pendingRecommendation}
          onApply={() => applyRecommendation(pendingRecommendation)}
          onCancel={() => setPendingRecommendation(null)}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          vlmSettings={vlmSettings}
          vlmApiKey={vlmApiKey}
          vlmModelName={vlmModelName}
          libreOfficePath={libreOfficePath}
          reasoningEffort={vlmReasoningEffort}
          verbosity={vlmVerbosity}
          maxCompletionTokens={vlmMaxCompletionTokens}
          topP={vlmTopP}
          serviceTier={vlmServiceTier}
          batchMaxWorkers={batchMaxWorkers}
          settingsMessage={settingsMessage}
          busy={busy}
          onVlmApiKey={setVlmApiKey}
          onVlmModelName={setVlmModelName}
          onLibreOfficePath={setLibreOfficePath}
          onReasoningEffort={setVlmReasoningEffort}
          onVerbosity={setVlmVerbosity}
          onMaxCompletionTokens={setVlmMaxCompletionTokens}
          onTopP={setVlmTopP}
          onServiceTier={setVlmServiceTier}
          onBatchMaxWorkers={setBatchMaxWorkers}
          onSave={() => void saveVlmSettings()}
          onClearParsingHistory={() => void clearParsingHistory()}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

function KieUtilityDock(props: { onArchive: () => void; onBatch: () => void }) {
  return (
    <section className="utility-dock" aria-label="핵심 정보 추출 보조 작업">
      <button type="button" className="secondary" onClick={props.onArchive}>
        <FileJson size={16} />
        아카이브 검색
      </button>
      <button type="button" className="secondary" onClick={props.onBatch}>
        <FileSpreadsheet size={16} />
        배치 결과
      </button>
    </section>
  );
}

function UtilityModal(props: { title: string; eyebrow: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-panel utility-modal" role="dialog" aria-modal="true" aria-label={props.title}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">{props.eyebrow}</p>
            <h2>{props.title}</h2>
          </div>
          <button type="button" className="icon-only secondary" aria-label="닫기" onClick={props.onClose}>
            <X size={16} />
          </button>
        </div>
        {props.children}
      </section>
    </div>
  );
}

function HomeScreen(props: {
  onRaw: () => void;
  onKie: () => void;
  onClassifier: () => void;
  onRequiredChecker: () => void;
  onWorkflow: () => void;
  systemStatus: SystemStatus | null;
  vlmSettings: VlmSettings | null;
  workflowRuns: HomeWorkflowRun[];
}) {
  return (
    <main className="home-screen">
      <section className="home-hero home-hero-workflow">
        <div>
          <p className="eyebrow">작업 공간</p>
          <h2>워크플로우로 문서 처리를 한 번에 연결하세요</h2>
          <p>분류, 핵심값 추출, 필수 항목 확인을 하나의 파이프라인으로 묶고 배치 실행 결과를 한 화면에서 검수합니다.</p>
          <button type="button" className="primary home-workflow-cta" onClick={props.onWorkflow}>
            <FileJson size={18} />
            워크플로우 빌더 열기
          </button>
        </div>
        <div className="home-workflow-panel">
          <div className="home-pipeline-preview" aria-hidden="true">
            {["Input", "Classify", "Branch", "KIE", "Required", "Export"].map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
          <div className="home-ops-grid">
            <span><strong>{props.systemStatus?.is_mock ? "Mock" : props.systemStatus?.has_vlm_credentials ? "Ready" : "Setup"}</strong> VLM</span>
            <span><strong>{props.vlmSettings?.batch_max_workers ?? "-"}</strong> Workers</span>
            <span><strong>{props.workflowRuns[0] ? `${Math.round(props.workflowRuns[0].progress * 100)}%` : "-"}</strong> Recent</span>
          </div>
          <div className="home-recent-runs">
            {props.workflowRuns.length ? props.workflowRuns.map((run) => (
              <button key={run.id} type="button" onClick={props.onWorkflow}>
                <span>{statusLabel(run.status)}</span>
                <strong>{run.completed_count + run.failed_count + run.needs_review_count}/{run.total_count}</strong>
              </button>
            )) : <span>최근 workflow run이 없습니다.</span>}
          </div>
        </div>
      </section>
      <div className="home-section-title">
        <p className="eyebrow">단일 모듈 도구</p>
        <h3>필요한 기능만 따로 실행할 수도 있습니다</h3>
      </div>
      <section className="feature-grid">
        <button className="feature-card active-feature" onClick={props.onRaw}>
          <FileUp size={24} />
          <strong>원문 데이터 추출</strong>
          <span>DOCX, XLSX, PPTX, PDF를 PDF 미리보기와 HTML로 변환합니다.</span>
        </button>
        <button className="feature-card active-feature" onClick={props.onKie}>
          <Sparkles size={24} />
          <strong>핵심 정보 추출</strong>
          <span>PDF, 이미지, DOCX, PPTX에서 schema에 맞는 값만 추출합니다.</span>
        </button>
        <button className="feature-card active-feature" onClick={props.onClassifier}>
          <ClipboardList size={24} />
          <strong>문서 분류</strong>
          <span>사용자가 정의한 후보 class와 미분류 허용 규칙으로 문서를 자동 분류합니다.</span>
        </button>
        <button className="feature-card active-feature" onClick={props.onRequiredChecker}>
          <CheckSquare size={24} />
          <strong>필수 항목 확인</strong>
          <span>값의 정확성보다 필수 항목이 존재하는지 여부를 빠르게 확인합니다.</span>
        </button>
      </section>
    </main>
  );
}

function RawWorkspace(props: {
  rawExtraction: RawExtraction | null;
  recentRawExtractions: RawExtraction[];
  rawOptions: RawExtractionOptions;
  historyCollapsed: boolean;
  pdfUrl: string | null;
  htmlUrl: string | null;
  leftPanePercent: number;
  onUpload: (file: File, options: RawExtractionOptions) => void;
  onLoad: (id: string) => void;
  onRawOptions: (options: RawExtractionOptions) => void;
  onToggleHistory: () => void;
  onResize: (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) props.onUpload(file, props.rawOptions);
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) props.onUpload(file, props.rawOptions);
  }

  return (
    <main
      className="workspace raw-workspace"
      style={{ gridTemplateColumns: `minmax(320px, ${props.leftPanePercent}%) 12px minmax(380px, 1fr)` }}
    >
      <section className="document-pane">
        <div className="pane-header">
          <div>
            <p className="eyebrow">PDF 미리보기</p>
            <h2>{props.rawExtraction?.filename || "원문 문서 업로드"}</h2>
          </div>
        </div>
        {props.pdfUrl ? (
          <iframe className="raw-frame" src={props.pdfUrl} title="PDF 미리보기" />
        ) : (
          <label className="upload-zone" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
            <UploadCloud size={32} />
            <strong>원문 문서 업로드</strong>
            <span>DOCX, XLSX, PPTX 또는 PDF</span>
            <input type="file" accept=".docx,.xlsx,.pptx,.pdf" onChange={onFileChange} />
          </label>
        )}
      </section>

      <button
        className="splitter"
        type="button"
        title="영역 너비 조절"
        aria-label="영역 너비 조절"
        onPointerDown={props.onResize}
      >
        <GripVertical size={18} />
      </button>

      <aside className="side-pane">
        <section className="service-panel raw-controls">
          <div className="history-header">
            <div className="preview-title inline-title">
              <FileJson size={16} />
              HTML 미리보기
            </div>
            {props.htmlUrl && (
              <a className="secondary compact link-button" href={props.htmlUrl} target="_blank">
                HTML 열기
              </a>
            )}
          </div>
          <label className="batch-upload">
            <UploadCloud size={16} />
            <span>원문 추출 파일 업로드</span>
            <input type="file" accept=".docx,.xlsx,.pptx,.pdf" onChange={onFileChange} />
          </label>
          <div className="option-list">
            <label>
              <input
                type="checkbox"
                checked={props.rawOptions.includeImages}
                onChange={(event) => props.onRawOptions({ ...props.rawOptions, includeImages: event.target.checked })}
              />
              이미지 추출
            </label>
            <label>
              <input
                type="checkbox"
                checked={props.rawOptions.includeFormulas}
                onChange={(event) => props.onRawOptions({ ...props.rawOptions, includeFormulas: event.target.checked })}
              />
              수식 추출
            </label>
          </div>
          {props.rawExtraction && (
            <div className={`raw-status ${props.rawExtraction.status}`}>
              <strong>{statusLabel(props.rawExtraction.status)}</strong>
              <span>{props.rawExtraction.source_format.toUpperCase()} · {formatDate(props.rawExtraction.created_at)}</span>
              {props.rawExtraction.error_message && <span>{props.rawExtraction.error_message}</span>}
              {props.rawExtraction.warnings.length > 0 && <span>{props.rawExtraction.warnings.join(", ")}</span>}
            </div>
          )}
          {props.htmlUrl ? (
            <iframe className="raw-frame html-frame" src={props.htmlUrl} title="HTML 추출 미리보기" />
          ) : (
            <div className="empty-state">업로드 후 추출 HTML이 여기에 표시됩니다.</div>
          )}
        </section>

        <section className="history-panel raw-history">
          <div className="history-header">
            <div className="preview-title inline-title">
              <History size={16} />
              원문 추출 기록
            </div>
            <button type="button" className="secondary compact" onClick={props.onToggleHistory}>
              {props.historyCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
              {props.historyCollapsed ? "열기" : "닫기"}
            </button>
          </div>
          {!props.historyCollapsed && (
            <div className="history-list">
              {props.recentRawExtractions.length ? (
                props.recentRawExtractions.map((item) => (
                  <button key={item.id} onClick={() => props.onLoad(item.id)}>
                    <strong>{item.filename}</strong>
                    <span>
                      {statusLabel(item.status)} · {item.source_format.toUpperCase()} · {formatDate(item.created_at)}
                    </span>
                  </button>
                ))
              ) : (
                <span className="muted">아직 원문 추출 기록이 없습니다.</span>
              )}
            </div>
          )}
        </section>
      </aside>
    </main>
  );
}

function KieUploadPanel(props: {
  selectedFiles: File[];
  selectedFileUrl: string | null;
  selectedFileIndex: number;
  regions: SchemaRegion[];
  showRegions: boolean;
  message: string | null;
  activeSchemaName: string;
  activeSchemaFieldCount: number;
  activeSchemaRegionCount: number;
  activeSchemaReady: boolean;
  activeSchemaStatus: string;
  activeSchemaMessage: string | null;
  onSelectFile: (index: number) => void;
  onSelectFiles: (files: FileList | File[] | null) => void;
  onShowRegions: (show: boolean) => void;
  onClearFiles: () => void;
  onRunBatch: () => void;
}) {
  const selectedFile = props.selectedFiles[props.selectedFileIndex] ?? props.selectedFiles[0] ?? null;
  const selectedUrl = props.selectedFileUrl;

  async function onUnifiedDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    props.onSelectFiles(await filesFromDataTransfer(event.dataTransfer));
  }

  function onUnifiedFileChange(event: ChangeEvent<HTMLInputElement>) {
    props.onSelectFiles(event.target.files);
    event.currentTarget.value = "";
  }

  function renderBatchControls() {
    return (
      <>
        <div className={props.activeSchemaReady ? "active-schema-card ready" : "active-schema-card warning"}>
          <div>
            <span>활성 schema</span>
            <strong>{props.activeSchemaName}</strong>
          </div>
          <p>
            {props.activeSchemaFieldCount}개 필드 · {props.activeSchemaRegionCount}개 영역 · {props.activeSchemaStatus}
          </p>
          {props.activeSchemaMessage && <small>{props.activeSchemaMessage}</small>}
        </div>

        <div className="file-picker-grid">
          <label className="batch-upload">
            <FileUp size={16} />
            <span>파일 선택</span>
            <input type="file" accept={KIE_FILE_ACCEPT} multiple onChange={onUnifiedFileChange} />
          </label>
          <label className="batch-upload">
            <UploadCloud size={16} />
            <span>폴더 선택</span>
            <input
              type="file"
              accept={KIE_FILE_ACCEPT}
              multiple
              onChange={onUnifiedFileChange}
              {...{ webkitdirectory: "", directory: "" }}
            />
          </label>
        </div>

        {props.message && <div className="success-card">{props.message}</div>}

        <button className="primary run-batch-button" disabled={!props.activeSchemaReady || !props.selectedFiles.length} onClick={props.onRunBatch}>
          <Play size={16} />
          배치 실행
        </button>
      </>
    );
  }

  if (props.selectedFiles.length > 0) {
    return (
      <div className="kie-upload-panel" onDragOver={(event) => event.preventDefault()} onDrop={onUnifiedDrop}>
        <div className="pane-header">
          <div>
            <p className="eyebrow">배치 초안</p>
            <h2>{props.selectedFiles.length}개 파일 선택됨</h2>
          </div>
          <button type="button" className="secondary compact" onClick={props.onClearFiles}>
            <X size={16} />
            비우기
          </button>
        </div>

        <section className="batch-main-upload draft-controls draft-controls-horizontal">
          <div className="batch-intro">
            <strong>배치 업로드</strong>
            <p>우측에서 활성화된 schema를 기준으로 선택한 파일을 한 번에 추출합니다.</p>
          </div>
          <div className="draft-region-actions">
            <button
              type="button"
              className={props.showRegions ? "secondary compact active-tool" : "secondary compact"}
              disabled={!props.regions.length}
              onClick={() => props.onShowRegions(!props.showRegions)}
              title={props.regions.length ? "선택한 이미지 위에 schema 영역을 표시합니다." : "저장된 영역이 없습니다."}
            >
              <PanelLeft size={14} />
              {props.showRegions ? "영역 숨기기" : "영역 보기"}
            </button>
          </div>
          {renderBatchControls()}
        </section>

        <div className="draft-batch-workbench">
          <aside className="draft-file-rail" aria-label="선택한 배치 파일">
            <div className="batch-rail-header">
              <div>
                <p className="eyebrow">선택됨</p>
                <strong>{props.selectedFileIndex + 1} / {props.selectedFiles.length}</strong>
              </div>
            </div>
            <VirtualDraftFileList
              files={props.selectedFiles}
              selectedIndex={props.selectedFileIndex}
              onSelectFile={props.onSelectFile}
            />
          </aside>

          <section className="draft-preview-pane">
            <div className="draft-preview-stage">
              {selectedFile && selectedUrl && isImageFile(selectedFile) ? (
                <div className="draft-preview-image-wrap">
                  <img src={selectedUrl} alt={fileDisplayName(selectedFile)} />
                  {props.showRegions && <RegionOverlay regions={props.regions} page={1} />}
                </div>
              ) : selectedFile ? (
                <div className="empty-state">
                  <FileUp size={24} />
                  <strong>{fileDisplayName(selectedFile)}</strong>
                  <span>이 파일은 실행 후 PDF/page preview로 확인됩니다.</span>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="kie-upload-panel">
      <div className="pane-header">
        <div>
          <p className="eyebrow">핵심 정보 업로드</p>
          <h2>파일 또는 폴더 업로드</h2>
        </div>
      </div>

      <div className="unified-upload-layout" onDragOver={(event) => event.preventDefault()} onDrop={onUnifiedDrop}>
        <section className="unified-upload-actions">
          <label className="batch-upload folder-upload-action">
            <UploadCloud size={18} />
            <span>폴더 선택</span>
            <input
              type="file"
              accept={KIE_FILE_ACCEPT}
              multiple
              onChange={onUnifiedFileChange}
              {...{ webkitdirectory: "", directory: "" }}
            />
          </label>
          <label className="batch-upload file-upload-action">
            <FileUp size={18} />
            <span>파일 선택</span>
            <input type="file" accept={KIE_FILE_ACCEPT} multiple onChange={onUnifiedFileChange} />
          </label>
          {props.message && <div className="success-card">{props.message}</div>}
        </section>

        <label className="upload-zone unified-upload-zone" onDragOver={(event) => event.preventDefault()} onDrop={onUnifiedDrop}>
          <UploadCloud size={32} />
          <strong>파일 또는 폴더를 끌어오세요</strong>
          <span>지원 파일 1개는 단일 실행, 2개 이상은 배치 실행으로 처리합니다.</span>
          <input type="file" accept={KIE_FILE_ACCEPT} multiple onChange={onUnifiedFileChange} />
        </label>
      </div>
    </div>
  );
}

function BatchFileRail(props: {
  batch: Batch;
  activeItemId: string | null;
  onOpenItem: (itemId: string) => void;
  onCancelBatch: (batchId: string) => void;
  onRefresh: () => void;
}) {
  return (
    <aside className="batch-file-rail" aria-label="배치 파일">
      <div className="batch-rail-header">
        <div>
          <p className="eyebrow">배치</p>
          <strong>{props.batch.completed_count + props.batch.failed_count + props.batch.canceled_count} / {props.batch.total_count}</strong>
        </div>
        <button type="button" className="icon-only secondary compact" title="배치 새로고침" onClick={props.onRefresh}>
          <RefreshCw size={14} />
        </button>
      </div>
      <progress max={1} value={props.batch.progress} />
      <div className="batch-rail-actions">
        <a className="secondary compact link-button" href={batchExportHref(props.batch.id, "csv")} target="_blank">
          CSV
        </a>
        <a className="secondary compact link-button" href={batchExportHref(props.batch.id, "json")} target="_blank">
          JSON
        </a>
        {batchCanCancel(props.batch) && (
          <button type="button" className="secondary compact danger-outline" onClick={() => props.onCancelBatch(props.batch.id)}>
            중단
          </button>
        )}
      </div>
      <VirtualBatchFileList items={props.batch.items} activeItemId={props.activeItemId} onOpenItem={props.onOpenItem} />
    </aside>
  );
}

function VirtualBatchFileList(props: {
  items: BatchItem[];
  activeItemId: string | null;
  onOpenItem: (itemId: string) => void;
}) {
  const activeIndex = props.items.findIndex((item) => item.id === props.activeItemId);
  const virtual = useVirtualFileList(props.items.length, activeIndex);
  const visibleItems = props.items.slice(virtual.start, virtual.end);

  return (
    <div className="batch-file-list virtual-file-list" ref={virtual.containerRef} onScroll={virtual.onScroll}>
      <div className="virtual-list-spacer" style={virtual.spacerStyle}>
        <div className="virtual-list-window" style={virtual.windowStyle}>
          {visibleItems.map((item, offset) => {
            const index = virtual.start + offset;
            return (
              <BatchFileButton
                key={item.id}
                item={item}
                index={index}
                active={item.id === props.activeItemId}
                onOpenItem={props.onOpenItem}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function VirtualDraftFileList(props: {
  files: File[];
  selectedIndex: number;
  onSelectFile: (index: number) => void;
}) {
  const virtual = useVirtualFileList(props.files.length, props.selectedIndex);
  const visibleFiles = props.files.slice(virtual.start, virtual.end);

  return (
    <div className="batch-file-list virtual-file-list" ref={virtual.containerRef} onScroll={virtual.onScroll}>
      <div className="virtual-list-spacer" style={virtual.spacerStyle}>
        <div className="virtual-list-window" style={virtual.windowStyle}>
          {visibleFiles.map((file, offset) => {
            const index = virtual.start + offset;
            return (
              <DraftBatchFileButton
                key={`${fileDisplayName(file)}_${file.size}_${index}`}
                file={file}
                index={index}
                active={index === props.selectedIndex}
                onSelectFile={props.onSelectFile}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

const DraftBatchFileButton = memo(
  function DraftBatchFileButton(props: {
    file: File;
    index: number;
    active: boolean;
    onSelectFile: (index: number) => void;
  }) {
    const thumbnailUrl = useObjectUrl(isImageFile(props.file) ? props.file : null);
    return (
      <button
        type="button"
        className={`batch-file-item ${props.active ? "active" : ""}`}
        onClick={() => props.onSelectFile(props.index)}
      >
        <span className="batch-file-thumb">
          {thumbnailUrl ? <img src={thumbnailUrl} alt="" loading="lazy" decoding="async" /> : <FileUp size={18} />}
          <em>{props.index + 1}</em>
        </span>
        <span className="batch-file-main">
          <strong>{fileDisplayName(props.file)}</strong>
          <em>{formatFileSize(props.file.size)}</em>
        </span>
      </button>
    );
  },
  (previous, next) =>
    previous.active === next.active &&
    previous.index === next.index &&
    previous.file === next.file
);

const BatchFileButton = memo(
  function BatchFileButton(props: {
    item: BatchItem;
    index: number;
    active: boolean;
    onOpenItem: (itemId: string) => void;
  }) {
    return (
      <button
        type="button"
        className={`batch-file-item ${props.active ? "active" : ""} ${props.item.status}`}
        onClick={() => props.onOpenItem(props.item.id)}
      >
        <span className="batch-file-thumb">
          <img
            src={documentPageThumbnailSrc(props.item.document_id, 1, 96)}
            alt=""
            loading="lazy"
            decoding="async"
          />
          <em>{props.index + 1}</em>
        </span>
        <span className="batch-file-main">
          <strong>{props.item.filename}</strong>
          <em>{statusLabel(props.item.status)}</em>
        </span>
      </button>
    );
  },
  (previous, next) =>
    previous.active === next.active &&
    previous.index === next.index &&
    previous.item.id === next.item.id &&
    previous.item.status === next.item.status &&
    previous.item.filename === next.item.filename &&
    previous.item.document_id === next.item.document_id
);

function BatchItemStatusPanel(props: {
  batch: Batch;
  item: BatchItem;
  onRefresh: () => void;
  onCancelBatch: (batchId: string) => void;
}) {
  const finishedCount = props.batch.completed_count + props.batch.failed_count + props.batch.canceled_count;
  return (
    <div className="review-panel batch-wait-panel">
      <div className="pane-header">
        <div>
          <p className="eyebrow">배치 검수</p>
          <h2>{props.item.filename}</h2>
        </div>
        <span className={`status-badge ${props.item.status}`}>{statusLabel(props.item.status)}</span>
      </div>

      <div className="progress-card">
        <strong>{finishedCount} / {props.batch.total_count}개 파일 처리됨</strong>
        <progress max={1} value={props.batch.progress} />
      </div>

      <div className={`raw-status ${props.item.status === "failed" ? "failed" : "completed"}`}>
        <strong>{statusLabel(props.item.status)}</strong>
        <span>배치 상태: {statusLabel(props.batch.status)}</span>
        {props.item.error_message && <span>{props.item.error_message}</span>}
      </div>

      <div className="action-row">
        <button type="button" className="secondary" onClick={props.onRefresh}>
          <RefreshCw size={16} />
          새로고침
        </button>
        <a className="secondary link-button" href={batchExportHref(props.batch.id, "csv")} target="_blank">
          <FileSpreadsheet size={16} />
          배치 CSV
        </a>
        <a className="secondary link-button" href={batchExportHref(props.batch.id, "json")} target="_blank">
          <FileJson size={16} />
          배치 JSON
        </a>
        {batchCanCancel(props.batch) && (
          <button type="button" className="secondary danger-outline" onClick={() => props.onCancelBatch(props.batch.id)}>
            <X size={16} />
            배치 중단
          </button>
        )}
      </div>
    </div>
  );
}

function RegionOverlay({ regions, page }: { regions: SchemaRegion[]; page: number }) {
  const visibleRegions = regions.filter((region) => region.page === page);
  if (!visibleRegions.length) return null;
  return (
    <div className="document-region-layer" aria-label="Schema 영역">
      {visibleRegions.map((region) => (
        <div
          className="document-region-box"
          key={region.id}
          style={{
            left: `${region.x * 100}%`,
            top: `${region.y * 100}%`,
            width: `${region.width * 100}%`,
            height: `${region.height * 100}%`
          }}
        >
          <span>{region.name}</span>
        </div>
      ))}
    </div>
  );
}

function SettingsDialog(props: {
  vlmSettings: VlmSettings | null;
  vlmApiKey: string;
  vlmModelName: string;
  libreOfficePath: string;
  reasoningEffort: string;
  verbosity: string;
  maxCompletionTokens: string;
  topP: string;
  serviceTier: string;
  batchMaxWorkers: string;
  settingsMessage: string | null;
  busy: string | null;
  onVlmApiKey: (value: string) => void;
  onVlmModelName: (value: string) => void;
  onLibreOfficePath: (value: string) => void;
  onReasoningEffort: (value: string) => void;
  onVerbosity: (value: string) => void;
  onMaxCompletionTokens: (value: string) => void;
  onTopP: (value: string) => void;
  onServiceTier: (value: string) => void;
  onBatchMaxWorkers: (value: string) => void;
  onSave: () => void;
  onClearParsingHistory: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="settings-panel modal-panel" role="dialog" aria-modal="true" aria-labelledby="vlm-settings-title">
        <div className="modal-header">
          <div>
            <p className="eyebrow">설정</p>
            <h2 id="vlm-settings-title">API, 모델, LibreOffice</h2>
          </div>
          <button type="button" className="icon-only secondary" aria-label="설정 닫기" onClick={props.onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="settings-grid">
          <label>
            <span>API key</span>
            <input
              type="password"
              value={props.vlmApiKey}
              placeholder={props.vlmSettings?.has_api_key ? "저장된 key 유지" : "VLM_API_KEY"}
              onChange={(event) => props.onVlmApiKey(event.target.value)}
            />
          </label>
          <label>
            <span>Model name</span>
            <input
              value={props.vlmModelName}
              placeholder="gpt-4.1-mini"
              onChange={(event) => props.onVlmModelName(event.target.value)}
            />
          </label>
          <label className="wide-field">
            <span>LibreOffice path</span>
            <input
              value={props.libreOfficePath}
              placeholder="/Applications/LibreOffice.app/Contents/MacOS/soffice"
              onChange={(event) => props.onLibreOfficePath(event.target.value)}
            />
          </label>
          <label>
            <span>Reasoning effort</span>
            <select value={props.reasoningEffort} onChange={(event) => props.onReasoningEffort(event.target.value)}>
              <option value="">기본값</option>
              <option value="minimal">minimal</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>
          <label>
            <span>Verbosity</span>
            <select value={props.verbosity} onChange={(event) => props.onVerbosity(event.target.value)}>
              <option value="">기본값</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>
          <label>
            <span>Max tokens</span>
            <input
              inputMode="numeric"
              value={props.maxCompletionTokens}
              placeholder="비워두기"
              onChange={(event) => props.onMaxCompletionTokens(event.target.value)}
            />
          </label>
          <label>
            <span>Top P</span>
            <input value={props.topP} placeholder="비워두기" onChange={(event) => props.onTopP(event.target.value)} />
          </label>
          <label>
            <span>Service tier</span>
            <input value={props.serviceTier} placeholder="비워두기" onChange={(event) => props.onServiceTier(event.target.value)} />
          </label>
          <label>
            <span>배치 worker 수</span>
            <input
              inputMode="numeric"
              value={props.batchMaxWorkers}
              placeholder="4"
              onChange={(event) => props.onBatchMaxWorkers(event.target.value)}
            />
          </label>
          <button type="button" className="primary compact" disabled={Boolean(props.busy)} onClick={props.onSave}>
            <Save size={16} />
            저장
          </button>
          <button type="button" className="secondary compact" disabled={Boolean(props.busy)} onClick={props.onClose}>
            닫기
          </button>
        </div>
        <div className="danger-zone">
          <div>
            <strong>파싱 기록 삭제</strong>
            <span>저장된 schema는 유지하고 문서, batch, 추출 결과, raw extraction 기록만 비웁니다.</span>
          </div>
          <button type="button" className="danger-outline compact" disabled={Boolean(props.busy)} onClick={props.onClearParsingHistory}>
            <Trash2 size={16} />
            기록 비우기
          </button>
        </div>
        <div className="settings-status">
          <span>{props.vlmSettings?.has_api_key ? "API key 저장됨" : "API key 미설정"}</span>
          <span>env: {props.vlmSettings?.env_path || ".env"}</span>
          {props.settingsMessage && <span className="success-text">{props.settingsMessage}</span>}
        </div>
      </section>
    </div>
  );
}

function DocumentViewer(props: {
  document: UploadedDocument;
  activePage: number;
  activeImageUrl: string | null;
  regions: SchemaRegion[];
  showRegions: boolean;
  zoom: number;
  zoomMode: ZoomMode;
  rotation: number;
  onPage: (page: number) => void;
  onShowRegions: (show: boolean) => void;
  onZoom: (zoom: number) => void;
  onZoomMode: (mode: ZoomMode) => void;
  onRotation: (rotation: number) => void;
  onReplaceFile: (file: File) => void;
  onClear: () => void;
}) {
  const imageClass = `document-image ${props.zoomMode}`;
  const activePageNumber = props.document.pages[props.activePage]?.page ?? props.activePage + 1;
  const visibleRegions = props.regions.filter((region) => region.page === activePageNumber);
  const transforms = [
    props.rotation ? `rotate(${props.rotation}deg)` : "",
    props.zoomMode === "manual" && props.zoom !== 1 ? `scale(${props.zoom})` : ""
  ].filter(Boolean);
  const imageStyle = transforms.length ? { transform: transforms.join(" ") } : undefined;

  return (
    <>
      <div className="pane-header">
        <div>
          <p className="eyebrow">문서</p>
          <h2>{props.document.filename}</h2>
        </div>
        <div className="toolbar">
          <button title="이전 페이지" onClick={() => props.onPage(Math.max(0, props.activePage - 1))}>
            <ChevronLeft size={18} />
          </button>
          <span className="page-count">
            {props.activePage + 1} / {props.document.page_count}
          </span>
          <button
            title="다음 페이지"
            onClick={() => props.onPage(Math.min(props.document.page_count - 1, props.activePage + 1))}
          >
            <ChevronRight size={18} />
          </button>
          <button
            title="폭 맞춤"
            className={props.zoomMode === "fitWidth" ? "active-tool" : ""}
            onClick={() => props.onZoomMode("fitWidth")}
          >
            <PanelLeft size={18} />
          </button>
          <button
            title="페이지 맞춤"
            className={props.zoomMode === "fitPage" ? "active-tool" : ""}
            onClick={() => props.onZoomMode("fitPage")}
          >
            <Maximize2 size={18} />
          </button>
          <button
            title="축소"
            onClick={() => {
              props.onZoomMode("manual");
              props.onZoom(Math.max(0.5, props.zoom - 0.1));
            }}
          >
            <ZoomOut size={18} />
          </button>
          <button
            title="확대"
            onClick={() => {
              props.onZoomMode("manual");
              props.onZoom(Math.min(2, props.zoom + 0.1));
            }}
          >
            <ZoomIn size={18} />
          </button>
          <button title="회전" onClick={() => props.onRotation((props.rotation + 90) % 360)}>
            <RotateCw size={18} />
          </button>
          <button
            title={props.regions.length ? "문서 위에 schema 영역을 표시합니다." : "저장된 schema 영역이 없습니다."}
            className={props.showRegions ? "active-tool" : ""}
            disabled={!props.regions.length}
            onClick={() => props.onShowRegions(!props.showRegions)}
          >
            <PanelLeft size={18} />
            영역
          </button>
          <label className="toolbar-upload" title="문서 교체">
            <FileUp size={18} />
            <span>교체</span>
            <input
              type="file"
              accept={KIE_FILE_ACCEPT}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) props.onReplaceFile(file);
                event.currentTarget.value = "";
              }}
            />
          </label>
          <button title="문서 비우기" onClick={props.onClear}>
            <X size={18} />
            비우기
          </button>
        </div>
      </div>
      <div className="viewer-body">
        <div className="thumbnail-rail" aria-label="페이지 썸네일">
          {props.document.pages.map((page, index) => (
            <button
              key={page.id}
              className={index === props.activePage ? "active-thumb" : ""}
              title={`${page.page}페이지`}
              onClick={() => props.onPage(index)}
            >
              <img
                src={documentPageThumbnailSrc(props.document.document_id, page.page, 96)}
                alt={`${page.page}페이지`}
                loading="lazy"
                decoding="async"
              />
              <span>{page.page}</span>
            </button>
          ))}
        </div>
        <div className="image-stage">
          {props.activeImageUrl && (
            <div className={`document-image-wrap ${props.zoomMode}`} style={imageStyle}>
              <img className={imageClass} src={props.activeImageUrl} alt={`${props.activePage + 1}페이지`} />
              {props.showRegions && visibleRegions.length > 0 && (
                <div className="document-region-layer" aria-label="Schema 영역">
                  {visibleRegions.map((region) => (
                    <div
                      className="document-region-box"
                      key={region.id}
                      style={{
                        left: `${region.x * 100}%`,
                        top: `${region.y * 100}%`,
                        width: `${region.width * 100}%`,
                        height: `${region.height * 100}%`
                      }}
                    >
                      <span>{region.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function HistoryPanel(props: {
  activeTab: HistoryTab;
  documents: UploadedDocument[];
  schemas: SavedSchema[];
  jobs: ExtractionJob[];
  collapsed: boolean;
  onTab: (tab: HistoryTab) => void;
  onLoadDocument: (id: string) => void;
  onLoadSchema: (id: string) => void;
  onLoadJob: (id: string) => void;
  onToggle: () => void;
}) {
  return (
    <section className="history-panel">
      <div className="history-header">
        <div className="preview-title inline-title">
          <History size={16} />
          최근 항목
        </div>
        <div className="history-controls">
          {!props.collapsed && (
            <div className="segmented">
              <button className={props.activeTab === "documents" ? "active" : ""} onClick={() => props.onTab("documents")}>
                문서
              </button>
              <button className={props.activeTab === "schemas" ? "active" : ""} onClick={() => props.onTab("schemas")}>
                Schema
              </button>
              <button className={props.activeTab === "jobs" ? "active" : ""} onClick={() => props.onTab("jobs")}>
                작업
              </button>
            </div>
          )}
          <button type="button" className="secondary compact" onClick={props.onToggle}>
            {props.collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            {props.collapsed ? "열기" : "닫기"}
          </button>
        </div>
      </div>
      {!props.collapsed && (
        <div className="history-list">
          {props.activeTab === "documents" &&
            (props.documents.length ? (
              props.documents.map((item) => (
                <button key={item.document_id} onClick={() => props.onLoadDocument(item.document_id)}>
                  <strong>{item.filename}</strong>
                  <span>{item.page_count}페이지 · {formatDate(item.created_at)}</span>
                </button>
              ))
            ) : (
              <span className="muted">아직 문서가 없습니다.</span>
            ))}
          {props.activeTab === "schemas" &&
            (props.schemas.length ? (
              props.schemas.map((item) => (
                <button key={item.id} onClick={() => props.onLoadSchema(item.id)}>
                  <strong>{item.display_name || item.name}</strong>
                  <span>{item.fields.length}개 필드</span>
                </button>
              ))
            ) : (
              <span className="muted">아직 schema가 없습니다.</span>
            ))}
          {props.activeTab === "jobs" &&
            (props.jobs.length ? (
              props.jobs.map((item) => (
                <button key={item.job_id} onClick={() => props.onLoadJob(item.job_id)}>
                  <strong>{statusLabel(item.status)}</strong>
                  <span>{item.result_id || "결과 없음"} · {formatDate(item.created_at)}</span>
                </button>
              ))
            ) : (
              <span className="muted">아직 작업이 없습니다.</span>
            ))}
        </div>
      )}
    </section>
  );
}

function ArchivePanel(props: {
  query: string;
  status: string;
  results: ArchiveSearchResult[];
  onQuery: (value: string) => void;
  onStatus: (value: string) => void;
  onOpen: (item: ArchiveSearchResult) => void;
}) {
  return (
    <section className="service-panel compact-panel">
      <div className="history-header">
        <div className="preview-title inline-title">
          <FileJson size={16} />
          아카이브
        </div>
        <select value={props.status} onChange={(event) => props.onStatus(event.target.value)}>
          <option value="">전체</option>
          <option value="completed">완료</option>
          <option value="needs_review">검토 필요</option>
          <option value="failed">실패</option>
        </select>
      </div>
      <input
        className="search-input"
        value={props.query}
        placeholder="문서, schema, 추출값 검색"
        onChange={(event) => props.onQuery(event.target.value)}
      />
      <div className="mini-list">
        {props.results.length ? (
          props.results.slice(0, 4).map((item) => (
            <button key={`${item.document_id}_${item.job_id ?? "doc"}`} onClick={() => props.onOpen(item)}>
              <strong>{item.filename}</strong>
              <span>{item.document_type || item.schema_name || statusLabel(item.status) || "문서"} · {formatDate(item.created_at)}</span>
            </button>
          ))
        ) : (
          <span className="muted">일치하는 아카이브가 없습니다.</span>
        )}
      </div>
    </section>
  );
}

function BatchPanel(props: {
  batches: Batch[];
  selectedFiles: File[];
  message: string | null;
  activeSchemaName: string;
  activeSchemaFieldCount: number;
  activeSchemaRegionCount: number;
  activeSchemaReady: boolean;
  activeSchemaStatus: string;
  activeSchemaMessage: string | null;
  onSelectFiles: (files: FileList | null) => void;
  onClearFiles: () => void;
  onRunBatch: () => void;
  onCancelBatch: (batchId: string) => void;
  onRefresh: () => void;
  onOpenItem: (batchId: string, itemId: string) => void;
}) {
  return (
    <section className="service-panel batch-panel">
      <div className="batch-create-panel">
        <div className="batch-intro">
          <strong>배치 업로드</strong>
          <p>현재 workspace에서 활성화된 schema를 그대로 사용해 여러 문서나 폴더를 같은 기준으로 추출합니다.</p>
        </div>

        <div className={props.activeSchemaReady ? "active-schema-card ready" : "active-schema-card warning"}>
          <div>
            <span>활성 schema</span>
            <strong>{props.activeSchemaName}</strong>
          </div>
          <p>
            {props.activeSchemaFieldCount}개 필드 · {props.activeSchemaRegionCount}개 영역 · {props.activeSchemaStatus}
          </p>
          {props.activeSchemaMessage && <small>{props.activeSchemaMessage}</small>}
        </div>

        <div className="file-picker-grid">
          <label className="batch-upload">
            <FileUp size={16} />
            <span>파일 선택</span>
            <input
              type="file"
              accept={KIE_FILE_ACCEPT}
              multiple
              onChange={(event) => props.onSelectFiles(event.target.files)}
            />
          </label>
          <label className="batch-upload">
            <UploadCloud size={16} />
            <span>폴더 선택</span>
            <input
              type="file"
              accept={KIE_FILE_ACCEPT}
              multiple
              onChange={(event) => props.onSelectFiles(event.target.files)}
              {...{ webkitdirectory: "", directory: "" }}
            />
          </label>
        </div>

        {props.selectedFiles.length > 0 && (
          <div className="selected-files">
            <div className="batch-top">
              <strong>{props.selectedFiles.length}개 선택됨</strong>
              <button type="button" className="ghost compact" onClick={props.onClearFiles}>
                비우기
              </button>
            </div>
            <div className="mini-list">
              {props.selectedFiles.slice(0, 8).map((file, index) => (
                <span key={`${fileDisplayName(file)}_${file.size}_${index}`}>{fileDisplayName(file)}</span>
              ))}
              {props.selectedFiles.length > 8 && <span className="muted">+ {props.selectedFiles.length - 8}개 더 있음</span>}
            </div>
          </div>
        )}

        {props.message && <div className="success-card">{props.message}</div>}

        <button className="primary run-batch-button" disabled={!props.activeSchemaReady || !props.selectedFiles.length} onClick={props.onRunBatch}>
          <Play size={16} />
          배치 실행
        </button>
      </div>

      <div className="batch-results-panel">
        <div className="history-header">
          <div className="preview-title inline-title">
            <FileSpreadsheet size={16} />
            최근 배치 결과
          </div>
          <button className="secondary compact" onClick={props.onRefresh}>
            <RefreshCw size={14} />
            새로고침
          </button>
        </div>
        <div className="mini-list">
          {props.batches.length ? (
            props.batches.map((batch) => (
              <div className="batch-card" key={batch.id}>
                <div className="batch-top">
                  <strong>{statusLabel(batch.status)}</strong>
                  <div className="batch-actions">
                    <span>{Math.round(batch.progress * 100)}%</span>
                    <a className="secondary compact link-button" href={batchExportHref(batch.id, "csv")} target="_blank">
                      CSV
                    </a>
                    <a className="secondary compact link-button" href={batchExportHref(batch.id, "json")} target="_blank">
                      JSON
                    </a>
                  </div>
                </div>
                <progress max={1} value={batch.progress} />
                <div className="batch-meta-row">
                  <span className="muted">
                    완료 {batch.completed_count} · 실패 {batch.failed_count} · 취소 {batch.canceled_count} · 전체 {batch.total_count}
                  </span>
                  {batchCanCancel(batch) && (
                    <button type="button" className="secondary compact danger-outline" onClick={() => props.onCancelBatch(batch.id)}>
                      <X size={14} />
                      중단
                    </button>
                  )}
                </div>
                {batch.items.map((item) => (
                  <button key={item.id} onClick={() => props.onOpenItem(batch.id, item.id)}>
                    <strong>{item.filename}</strong>
                    <span>{statusLabel(item.status)} · 검수 열기</span>
                  </button>
                ))}
              </div>
            ))
          ) : (
            <span className="muted">아직 배치 결과가 없습니다.</span>
          )}
        </div>
      </div>
    </section>
  );
}

function UploadNotes({ onSampleSchema }: { onSampleSchema: () => void }) {
  return (
    <div className="upload-notes">
      <div className="pane-header">
        <div>
          <p className="eyebrow">시작</p>
          <h2>먼저 업로드하세요</h2>
        </div>
      </div>
      <p>업로드 후 schema builder가 열립니다. 지금 샘플 schema를 먼저 준비할 수도 있습니다.</p>
      <button className="secondary" onClick={onSampleSchema}>
        <ClipboardList size={16} />
        샘플 schema 사용
      </button>
      <div className="note-list">
        <span>지원 형식: PDF, PNG, JPG, JPEG, DOCX, PPTX</span>
        <span>Schema 필드: 필드명, 설명, 출력 형식</span>
        <span>설정 버튼에서 API key와 model name을 저장하세요.</span>
      </div>
    </div>
  );
}

function SchemaBuilder(props: {
  schemaName: string;
  schemaDescription: string;
  fields: SchemaField[];
  regions: SchemaRegion[];
  schemaPreview: string;
  schemaDownloadUrl: string;
  schemaJsonInput: string;
  savedSchema: SavedSchema | null;
  schemaDirty: boolean;
  schemaSaveStatus: "idle" | "pending" | "saving" | "saved" | "error";
  schemaSaveMessage: string | null;
  document: UploadedDocument | null;
  regionTarget: RegionEditorTarget | null;
  activePage: number;
  systemStatus: SystemStatus | null;
  savedSchemas: SavedSchema[];
  schemaNameConflict: SavedSchema | null;
  templates: SavedSchema[];
  onSchemaName: (value: string) => void;
  onSchemaDescription: (value: string) => void;
  onLoadSavedSchema: (schemaId: string) => void;
  onNewSchema: () => void;
  onDeleteSchema: (schemaId: string) => void;
  onSchemaJsonInput: (value: string) => void;
  onImportSchemaJson: () => void;
  onUpdateField: (index: number, patch: Partial<FieldDefinition>) => void;
  onSaveRegion: (region: SchemaRegion) => void;
  onRemoveRegion: (regionId: string) => void;
  onAddField: () => void;
  onRemoveField: (index: number) => void;
  onRunExtraction: () => Promise<void>;
  onRecommendSchema: () => Promise<void>;
  onRecommendSchemaDescription: () => Promise<void>;
  onSampleSchema: () => void;
  onLoadTemplate: (schema: SavedSchema) => void;
  onSaveTemplate: () => void;
  onOpenLibrary: () => void;
  canExtract: boolean;
}) {
  const [regionsOpen, setRegionsOpen] = useState(false);

  return (
    <div className="schema-builder">
      <div className="pane-header schema-main-header">
        <div>
          <p className="eyebrow">Schema</p>
          <h2>필드</h2>
          <p className="schema-current-line">
            {props.savedSchema ? props.schemaName : "새 schema"} · {props.fields.length}개 필드
          </p>
        </div>
        <div className="schema-header-actions">
          <span className={`saved-badge ${props.schemaSaveStatus}`}>
            {schemaSaveStatusLabel(props.schemaSaveStatus, props.savedSchema)}
          </span>
          <button type="button" className="secondary compact" onClick={props.onOpenLibrary}>
            <ClipboardList size={14} />
            Schema 목록
          </button>
          <button
            type="button"
            className="primary compact"
            disabled={!props.document}
            title={props.document ? "AI가 현재 문서를 기준으로 schema를 추천합니다." : "서버에 업로드된 문서가 있어야 AI schema 추천을 사용할 수 있습니다."}
            onClick={() => void props.onRecommendSchema()}
          >
            <Sparkles size={14} />
            AI schema 추천
          </button>
        </div>
      </div>

      <div className="schema-core-panel">
        <div className="schema-name-banner">
          <div>
            <span>{props.savedSchema ? "활성 schema" : "초안 schema"}</span>
            <strong>{props.schemaName || "이름 없는 schema"}</strong>
          </div>
          <p>
            {props.fields.length}개 필드 · {props.regions.length}개 영역 · {schemaSaveStatusLabel(props.schemaSaveStatus, props.savedSchema)}
          </p>
        </div>
        <div className="schema-table-wrap">
          <div className="schema-field-table" role="table" aria-label="Schema 필드">
            <div className="schema-field-head" role="row">
              <span>필드명</span>
              <span>설명</span>
              <span>타입</span>
              <span>영역</span>
              <span />
            </div>
          {props.fields.map((field, index) => (
            <div className="schema-field-row" role="row" key={field.local_id}>
              <input
                aria-label="필드명"
                value={field.key_name}
                onChange={(event) => props.onUpdateField(index, { key_name: event.target.value })}
              />
              <textarea
                aria-label="설명"
                className="schema-description-input"
                value={field.description}
                placeholder="값을 어디서 어떻게 찾을지 입력하세요"
                onChange={(event) => props.onUpdateField(index, { description: event.target.value })}
              />
              <select
                aria-label="출력 형식"
                value={field.output_format}
                onChange={(event) => props.onUpdateField(index, { output_format: event.target.value as OutputFormat })}
              >
                {OUTPUT_FORMATS.map((format) => (
                  <option key={format} value={format}>
                    {format}
                  </option>
                ))}
              </select>
              <select
                aria-label="영역"
                value={field.region_id ?? ""}
                onChange={(event) => props.onUpdateField(index, { region_id: event.target.value || null, region: null })}
              >
                <option value="">—</option>
                {props.regions.map((region) => (
                  <option key={region.id} value={region.id}>
                    {region.name}
                  </option>
                ))}
              </select>
              <button className="ghost danger icon-only" title="필드 삭제" onClick={() => props.onRemoveField(index)}>
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          </div>
        </div>

        <div className="action-row">
          <button className="secondary" onClick={props.onAddField}>
            <Plus size={16} />
            필드 추가
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!props.regionTarget}
            title={props.regionTarget ? "현재 선택한 이미지 위에 extraction region을 지정합니다." : "문서 이미지가 있어야 region을 지정할 수 있습니다."}
            onClick={() => setRegionsOpen(true)}
          >
            <PanelLeft size={16} />
            영역
          </button>
          <button className="primary" disabled={!props.canExtract} onClick={() => void props.onRunExtraction()}>
            <Play size={16} />
            추출
          </button>
        </div>
      </div>

      {props.regionTarget && regionsOpen && (
        <RegionManagerModal
          target={props.regionTarget}
          regions={props.regions}
          activePage={props.activePage}
          onSaveRegion={props.onSaveRegion}
          onRemoveRegion={props.onRemoveRegion}
          onClose={() => setRegionsOpen(false)}
        />
      )}
    </div>
  );
}

function SchemaLibraryPanel(props: {
  schemaName: string;
  schemaDescription: string;
  fields: SchemaField[];
  regions: SchemaRegion[];
  schemaPreview: string;
  schemaDownloadUrl: string;
  schemaJsonInput: string;
  savedSchema: SavedSchema | null;
  schemaSaveStatus: "idle" | "pending" | "saving" | "saved" | "error";
  schemaSaveMessage: string | null;
  document: UploadedDocument | null;
  regionTarget: RegionEditorTarget | null;
  activePage: number;
  systemStatus: SystemStatus | null;
  savedSchemas: SavedSchema[];
  templates: SavedSchema[];
  onSchemaName: (value: string) => void;
  onSchemaDescription: (value: string) => void;
  onLoadSavedSchema: (schemaId: string) => void;
  onNewSchema: () => void;
  onDeleteSchema: (schemaId: string) => void;
  onSchemaJsonInput: (value: string) => void;
  onImportSchemaJson: () => void;
  onSaveRegion: (region: SchemaRegion) => void;
  onRemoveRegion: (regionId: string) => void;
  onRecommendSchemaDescription: () => Promise<void>;
  onSampleSchema: () => void;
  onLoadTemplate: (schema: SavedSchema) => void;
  onSaveTemplate: () => void;
  onClose: () => void;
}) {
  const [selectedSchemaIds, setSelectedSchemaIds] = useState<string[]>([]);
  const [regionsOpen, setRegionsOpen] = useState(false);
  const selectedSchemaIdSet = new Set(selectedSchemaIds);

  function toggleSchemaSelection(schemaId: string) {
    setSelectedSchemaIds((current) =>
      current.includes(schemaId) ? current.filter((id) => id !== schemaId) : [...current, schemaId]
    );
  }

  function deleteSelectedSchemas() {
    selectedSchemaIds.forEach((schemaId) => props.onDeleteSchema(schemaId));
    setSelectedSchemaIds([]);
  }

  return (
    <aside className="schema-library-sidebar" aria-label="Schema 목록">
      <div className="modal-header schema-library-header">
        <div>
          <p className="eyebrow">Schema 목록</p>
          <h2>Schema 관리</h2>
        </div>
        <button type="button" className="icon-only secondary" aria-label="Schema 목록 닫기" onClick={props.onClose}>
          <X size={16} />
        </button>
      </div>

      <section className="schema-library-section">
        <div className="schema-library-top">
          <div>
            <strong>저장된 schema</strong>
            <span>{selectedSchemaIds.length ? `${selectedSchemaIds.length}개 선택됨` : `${props.savedSchemas.length}개 저장됨`}</span>
          </div>
          <div className="schema-library-actions">
            {selectedSchemaIds.length > 0 && (
              <button type="button" className="secondary compact danger-outline" onClick={deleteSelectedSchemas}>
                <Trash2 size={14} />
                선택 삭제
              </button>
            )}
            <button type="button" className="primary compact" onClick={props.onNewSchema}>
              <Plus size={14} />
              새 schema
            </button>
          </div>
        </div>
        <div className="schema-card-list">
          {props.savedSchemas.length ? (
            props.savedSchemas.map((savedSchema) => (
              <div
                key={savedSchema.id}
                className={props.savedSchema?.id === savedSchema.id ? "schema-card active" : "schema-card"}
                onClick={() => props.onLoadSavedSchema(savedSchema.id)}
              >
                <input
                  aria-label={`${savedSchema.display_name || savedSchema.name} 선택`}
                  checked={selectedSchemaIdSet.has(savedSchema.id)}
                  onChange={() => toggleSchemaSelection(savedSchema.id)}
                  onClick={(event) => event.stopPropagation()}
                  type="checkbox"
                />
                <button
                  type="button"
                  className="schema-card-body"
                  onClick={() => props.onLoadSavedSchema(savedSchema.id)}
                >
                  <span className="schema-card-title" title={savedSchema.display_name || savedSchema.name}>
                    {savedSchema.display_name || savedSchema.name}
                  </span>
                  <span className="schema-card-meta">
                    {savedSchema.fields.length}개 필드 · {savedSchema.regions.length}개 영역 · {formatDate(savedSchema.updated_at)}
                  </span>
                </button>
              </div>
            ))
          ) : (
            <div className="empty-schema-library">
              <span>저장된 schema가 없습니다.</span>
              <button type="button" className="secondary compact" onClick={props.onNewSchema}>
                <Plus size={14} />
                첫 schema 만들기
              </button>
            </div>
          )}
        </div>
      </section>

      <div className="schema-identity-panel">
        <label className="field-stack schema-name-inline">
          <span>선택한 schema 이름</span>
          <input value={props.schemaName} onChange={(event) => props.onSchemaName(event.target.value)} />
        </label>
        <div className="schema-detail-actions">
          <span>{props.savedSchema ? `${props.fields.length}개 필드` : "저장 전 초안"}</span>
          <button
            type="button"
            className="secondary compact danger-outline"
            disabled={!props.savedSchema}
            onClick={() => props.savedSchema && props.onDeleteSchema(props.savedSchema.id)}
          >
            <Trash2 size={14} />
            삭제
          </button>
        </div>
        {props.schemaSaveMessage && (
          <div className={`schema-save-message ${props.schemaSaveStatus}`}>
            {props.schemaSaveMessage}
          </div>
        )}
      </div>

      <div className="field-stack drawer-section">
        <div className="field-label-row">
          <span>Schema 설명</span>
          <button
            type="button"
            className="secondary compact mini-action"
            disabled={!props.fields.length}
            title="현재 필드만 보고 schema description을 다시 작성합니다."
            onClick={() => void props.onRecommendSchemaDescription()}
          >
            <Sparkles size={13} />
            AI 수정
          </button>
        </div>
        <textarea value={props.schemaDescription} onChange={(event) => props.onSchemaDescription(event.target.value)} />
      </div>

      <div className="region-manager-bar">
        <div>
          <strong>추출 영역</strong>
          <span>{props.regions.length ? `${props.regions.length}개 저장됨` : "공유 영역 없음"}</span>
        </div>
        <button
          type="button"
          className="secondary compact"
          disabled={!props.regionTarget}
          title={props.regionTarget ? "현재 선택한 이미지 위에 extraction region을 지정합니다." : "문서 이미지가 있어야 region을 지정할 수 있습니다."}
          onClick={() => setRegionsOpen(true)}
        >
          영역 관리
        </button>
      </div>

      {props.document && (
        <div className="intel-card">
          <div>
            <span className="eyebrow">문서 인텔리전스</span>
            <strong>{props.document.document_type || "문서 유형 미확인"}</strong>
          </div>
          <span>{props.document.language || "언어 미확인"} · {props.document.page_count}페이지</span>
          {props.document.recommendation_reasoning && <p>{props.document.recommendation_reasoning}</p>}
        </div>
      )}

      {props.systemStatus?.is_mock && (
        <div className="notice-card">Mock 모드입니다. AI 추천과 추출은 고정된 데모 데이터를 사용합니다.</div>
      )}

      <div className="tool-section">
        <h3>Schema 가져오기/내보내기</h3>
        <div className="action-row">
          <button className="secondary" onClick={props.onSampleSchema}>
            <ClipboardList size={16} />
            샘플 schema 사용
          </button>
          <a className="secondary link-button" href={props.schemaDownloadUrl} download={`${props.schemaName || "schema"}.json`}>
            <FileDown size={16} />
            Schema JSON 다운로드
          </a>
        </div>
      </div>

      <div className="template-strip">
        <div className="template-header">
          <strong>템플릿 목록</strong>
          <button className="secondary compact" onClick={props.onSaveTemplate}>
            템플릿 저장
          </button>
        </div>
        <div className="template-list">
          {props.templates.length ? (
            props.templates.slice(0, 4).map((template) => (
              <button key={template.id} onClick={() => props.onLoadTemplate(template)}>
                <strong>{template.display_name || template.name}</strong>
                <span>{template.template_category || "일반"} · {template.fields.length}개 필드</span>
              </button>
            ))
          ) : (
            <span className="muted">Schema를 템플릿으로 저장하면 여기에서 재사용할 수 있습니다.</span>
          )}
        </div>
      </div>

      <details className="import-box">
        <summary>
          <FileUp size={16} />
          Schema JSON 가져오기
        </summary>
        <textarea
          value={props.schemaJsonInput}
          onChange={(event) => props.onSchemaJsonInput(event.target.value)}
          placeholder="Schema JSON을 붙여넣으세요"
        />
        <button className="secondary" onClick={props.onImportSchemaJson}>
          <FileUp size={16} />
          가져오기
        </button>
      </details>

      <div className="preview-block">
        <div className="preview-title">
          <FileJson size={16} />
          JSON 미리보기
        </div>
        <pre>{props.schemaPreview}</pre>
      </div>

      {props.regionTarget && regionsOpen && (
        <RegionManagerModal
          target={props.regionTarget}
          regions={props.regions}
          activePage={props.activePage}
          onSaveRegion={props.onSaveRegion}
          onRemoveRegion={props.onRemoveRegion}
          onClose={() => setRegionsOpen(false)}
        />
      )}
    </aside>
  );
}

function RegionManagerModal(props: {
  target: RegionEditorTarget;
  regions: SchemaRegion[];
  activePage: number;
  onSaveRegion: (region: SchemaRegion) => void;
  onRemoveRegion: (regionId: string) => void;
  onClose: () => void;
}) {
  const [editingRegion, setEditingRegion] = useState<SchemaRegion | null>(null);

  function createRegion() {
    const id = createRegionId(props.regions);
    const page = props.target.pages[Math.min(props.activePage, props.target.pages.length - 1)]?.page ?? 1;
    setEditingRegion({
      id,
      name: `영역 ${props.regions.length + 1}`,
      page,
      x: 0.1,
      y: 0.1,
      width: 0.25,
      height: 0.12
    });
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-panel region-manager-modal" role="dialog" aria-modal="true" aria-label="추출 영역">
        <div className="modal-header">
          <div>
            <p className="eyebrow">추출 영역</p>
            <h2>공유 영역 템플릿</h2>
          </div>
          <button type="button" className="icon-only secondary" aria-label="영역 닫기" onClick={props.onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="region-manager-actions">
          <p>하나의 region을 여러 field에 할당할 수 있습니다. field row의 region select에서 원하는 region을 선택하세요.</p>
          <button type="button" className="primary compact" onClick={createRegion}>
            <Plus size={16} />
            영역 추가
          </button>
        </div>

        <div className="region-list">
          {props.regions.length ? (
            props.regions.map((region) => (
              <div className="region-list-row" key={region.id}>
                <div>
                  <strong>{region.name}</strong>
                  <span>
                    P{region.page} · x {formatRegionNumber(region.x)} · y {formatRegionNumber(region.y)} · w{" "}
                    {formatRegionNumber(region.width)} · h {formatRegionNumber(region.height)}
                  </span>
                </div>
                <div className="region-row-actions">
                  <button type="button" className="secondary compact" onClick={() => setEditingRegion(region)}>
                    수정
                  </button>
                  <button type="button" className="ghost compact danger" onClick={() => props.onRemoveRegion(region.id)}>
                    삭제
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="empty-state">아직 저장된 region이 없습니다.</div>
          )}
        </div>

        {editingRegion && (
          <RegionPickerModal
            target={props.target}
            region={editingRegion}
            onSave={(region) => {
              props.onSaveRegion(region);
              setEditingRegion(null);
            }}
            onClose={() => setEditingRegion(null)}
          />
        )}
      </section>
    </div>
  );
}

function RegionPickerModal(props: {
  target: RegionEditorTarget;
  region: SchemaRegion;
  onSave: (region: SchemaRegion) => void;
  onClose: () => void;
}) {
  const initialPageIndex = Math.min(
    props.target.page_count - 1,
    Math.max(0, props.region.page - 1)
  );
  const [pageIndex, setPageIndex] = useState(initialPageIndex);
  const [regionName, setRegionName] = useState(props.region.name);
  const [draftRegion, setDraftRegion] = useState<FieldRegion | null>(props.region);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const page = props.target.pages[pageIndex];
  const imageUrl = resolveImageUrl(page.image_url);
  const normalizedRegion =
    draftRegion && draftRegion.page === page.page
      ? draftRegion
      : draftRegion
        ? { ...draftRegion, page: page.page }
        : null;

  function pointFromEvent(event: PointerEvent<HTMLElement>) {
    const rect = imageRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height)
    };
  }

  function updateDraft(start: { x: number; y: number }, current: { x: number; y: number }) {
    const x = Math.min(start.x, current.x);
    const y = Math.min(start.y, current.y);
    const width = Math.abs(current.x - start.x);
    const height = Math.abs(current.y - start.y);
    setDraftRegion({
      page: page.page,
      x,
      y,
      width: Math.max(0.01, width),
      height: Math.max(0.01, height)
    });
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    const point = pointFromEvent(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragStart(point);
    updateDraft(point, point);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!dragStart) return;
    const point = pointFromEvent(event);
    if (point) updateDraft(dragStart, point);
  }

  function onPointerUp() {
    setDragStart(null);
  }

  function saveRegion() {
    const region = normalizedRegion;
    if (!region) return;
    props.onSave({
      ...roundRegion(region),
      id: props.region.id,
      name: regionName.trim() || props.region.name
    });
  }

  return (
    <div className="nested-modal-backdrop" role="presentation">
      <section className="modal-panel region-picker-modal" role="dialog" aria-modal="true" aria-label="추출 영역">
        <div className="modal-header">
          <div>
            <p className="eyebrow">추출 영역</p>
            <h2>{regionName || props.region.name}</h2>
          </div>
          <button type="button" className="icon-only secondary" aria-label="영역 선택 닫기" onClick={props.onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="region-toolbar">
          <label>
            <span>이름</span>
            <input value={regionName} onChange={(event) => setRegionName(event.target.value)} />
          </label>
          <label>
            <span>페이지</span>
            <select
              value={pageIndex}
              onChange={(event) => {
                const nextIndex = Number(event.target.value);
                setPageIndex(nextIndex);
                setDraftRegion((current) => (current ? { ...current, page: props.target.pages[nextIndex].page } : current));
              }}
            >
              {props.target.pages.map((item, index) => (
                <option key={item.id} value={index}>
                  {item.page}페이지
                </option>
              ))}
            </select>
          </label>
          <div className="region-values">
            <span>x {formatRegionNumber(normalizedRegion?.x)}</span>
            <span>y {formatRegionNumber(normalizedRegion?.y)}</span>
            <span>w {formatRegionNumber(normalizedRegion?.width)}</span>
            <span>h {formatRegionNumber(normalizedRegion?.height)}</span>
          </div>
        </div>

        <div className="region-image-wrap">
          <div className="region-canvas" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
            <img ref={imageRef} className="region-target-image" src={imageUrl} alt={`${page.page}페이지`} draggable={false} />
            {normalizedRegion && (
              <div
                className="region-box"
                style={{
                  left: `${normalizedRegion.x * 100}%`,
                  top: `${normalizedRegion.y * 100}%`,
                  width: `${normalizedRegion.width * 100}%`,
                  height: `${normalizedRegion.height * 100}%`
                }}
              />
            )}
          </div>
        </div>

        <div className="action-row">
          <button className="secondary" onClick={props.onClose}>
            취소
          </button>
          <button className="primary" disabled={!normalizedRegion} onClick={saveRegion}>
            <Save size={16} />
            영역 저장
          </button>
        </div>
      </section>
    </div>
  );
}

function ReviewPanel(props: {
  fields: FieldDefinition[];
  result: ExtractionResult | null;
  values: Record<string, ExtractionValue>;
  editedKeys: string[];
  reviewedFields: string[];
  filter: ReviewFilter;
  exportPresets: ExportPreset[];
  selectedPresetId: string;
  auditEvents: AuditEvent[];
  onFilter: (filter: ReviewFilter) => void;
  onEdit: (key: string, value: string) => void;
  onToggleReviewed: (key: string) => void;
  onSaveCorrections: () => Promise<void>;
  onGoToPage: (page: number | null) => void;
  onPreset: (presetId: string) => void;
  onSavePreset: () => void;
}) {
  if (!props.result) {
    return <div className="empty-state">아직 추출 결과가 없습니다.</div>;
  }

  const visibleFields = props.fields.filter((field) => {
    const value = props.values[field.key_name];
    const needsReview = !props.reviewedFields.includes(field.key_name) && (Boolean(value?.warnings?.length) || value?.value === null || value?.value === undefined || value?.value === "" || (value?.confidence ?? 1) < 0.75);
    if (props.filter === "needs_review") return needsReview;
    if (props.filter === "warning") return Boolean(value?.warnings?.length);
    if (props.filter === "null") return value?.value === null || value?.value === undefined || value?.value === "";
    if (props.filter === "changed") return props.editedKeys.includes(field.key_name);
    if (props.filter === "low_confidence") return (value?.confidence ?? 1) < 0.75;
    if (props.filter === "unreviewed") return !props.reviewedFields.includes(field.key_name);
    return true;
  });
  const reviewedCount = props.fields.filter((field) => props.reviewedFields.includes(field.key_name)).length;

  return (
    <div className="review-panel">
      <div className="pane-header">
        <div>
          <p className="eyebrow">검수</p>
          <h2>추출 결과</h2>
        </div>
        <span className={`status-badge ${props.result.validated_output.status}`}>{statusLabel(props.result.validated_output.status)}</span>
      </div>

      <div className="progress-card">
        <strong>{reviewedCount} / {props.fields.length}개 검수됨</strong>
        <progress max={props.fields.length || 1} value={reviewedCount} />
      </div>

      <div className="filter-row">
        <Filter size={16} />
        {(["needs_review", "all", "warning", "null", "low_confidence", "unreviewed", "changed"] as ReviewFilter[]).map((filter) => (
          <button key={filter} className={props.filter === filter ? "active" : ""} onClick={() => props.onFilter(filter)}>
            {reviewFilterLabel(filter)}
          </button>
        ))}
      </div>

      <div className="result-table">
        <div className="result-head">
          <span>필드</span>
          <span>값</span>
          <span>페이지</span>
          <span>신뢰도</span>
          <span>경고</span>
          <span>검수</span>
        </div>
        {visibleFields.map((field) => {
          const value = props.values[field.key_name];
          const originalValue = props.result?.validated_output.values[field.key_name];
          const isEdited = props.editedKeys.includes(field.key_name);
          return (
            <div className="result-row" key={field.key_name}>
              <span className="mono">
                {field.key_name}
                {isEdited && <em>edited</em>}
              </span>
              <label>
                <input value={stringifyValue(value?.value)} onChange={(event) => props.onEdit(field.key_name, event.target.value)} />
                {value?.evidence && <small>{value.evidence}</small>}
                {isEdited && <small>원본: {stringifyValue(originalValue?.value)}</small>}
              </label>
              <button className="ghost page-link" onClick={() => props.onGoToPage(value?.page ?? null)}>
                {value?.page ?? "-"}
              </button>
              <span>{formatConfidence(value?.confidence)}</span>
              <span className={value?.warnings?.length ? "warn-text" : "muted"}>
                {value?.warnings?.length ? value.warnings.join(", ") : "정상"}
              </span>
              <label className="review-check">
                <input
                  type="checkbox"
                  checked={props.reviewedFields.includes(field.key_name)}
                  onChange={() => props.onToggleReviewed(field.key_name)}
                />
              </label>
            </div>
          );
        })}
      </div>

      <div className="action-row">
        <button className="secondary" onClick={() => void props.onSaveCorrections()}>
          <Save size={16} />
          수정 저장
        </button>
        <select value={props.selectedPresetId} onChange={(event) => props.onPreset(event.target.value)}>
          <option value="">기본 export</option>
          {props.exportPresets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </select>
        <button className="secondary" onClick={props.onSavePreset}>
          <Save size={16} />
          Preset 저장
        </button>
        <a className="secondary link-button" href={exportHref(props.result.id, "json", props.selectedPresetId)} target="_blank">
          <Download size={16} />
          JSON
        </a>
        <a className="secondary link-button" href={exportHref(props.result.id, "csv", props.selectedPresetId)} target="_blank">
          <FileSpreadsheet size={16} />
          CSV
        </a>
      </div>

      <AuditPanel events={props.auditEvents} />

      <div className="preview-block">
        <div className="preview-title">원본 모델 출력</div>
        <pre>{JSON.stringify(props.result.raw_model_output, null, 2)}</pre>
      </div>
    </div>
  );
}

function AuditPanel({ events }: { events: AuditEvent[] }) {
  return (
    <div className="audit-panel">
      <div className="preview-title">감사 로그</div>
      <div className="mini-list">
        {events.length ? (
          events.map((event) => (
            <div className="audit-row" key={event.id}>
              <strong>{event.action}</strong>
              <span>{event.message || event.entity_type} · {formatDate(event.created_at)}</span>
            </div>
          ))
        ) : (
          <span className="muted">로드된 감사 로그가 없습니다.</span>
        )}
      </div>
    </div>
  );
}

function RecommendationDiffModal(props: {
  currentFields: SchemaField[];
  recommendation: SchemaRecommendation;
  onApply: () => void;
  onCancel: () => void;
}) {
  const currentKeys = new Set(props.currentFields.map((field) => field.key_name).filter(Boolean));
  const nextKeys = new Set(props.recommendation.fields.map((field) => field.key_name));
  const added = props.recommendation.fields.filter((field) => !currentKeys.has(field.key_name));
  const removed = props.currentFields.filter((field) => field.key_name && !nextKeys.has(field.key_name));
  const changed = props.recommendation.fields.filter((field) => {
    const current = props.currentFields.find((item) => item.key_name === field.key_name);
    return current && (current.description !== field.description || current.output_format !== field.output_format);
  });

  return (
    <div className="modal-backdrop">
      <div className="diff-modal">
        <div className="pane-header">
          <div>
            <p className="eyebrow">AI 추천</p>
            <h2>추천 schema를 적용할까요?</h2>
          </div>
        </div>
        <p>{props.recommendation.reasoning || "AI가 현재 문서 기준의 schema 초안을 생성했습니다."}</p>
        <div className="diff-grid">
          <DiffList title="추가" items={added.map((field) => field.key_name)} />
          <DiffList title="변경" items={changed.map((field) => field.key_name)} />
          <DiffList title="제거" items={removed.map((field) => field.key_name)} />
        </div>
        <div className="action-row">
          <button className="secondary" onClick={props.onCancel}>취소</button>
          <button className="primary" onClick={props.onApply}>추천 적용</button>
        </div>
      </div>
    </div>
  );
}

function DiffList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="diff-list">
      <strong>{title}</strong>
      {items.length ? items.map((item) => <span key={item}>{item}</span>) : <span className="muted">없음</span>}
    </div>
  );
}

function StepPill({ label, active, done }: { label: string; active: boolean; done: boolean }) {
  return <span className={`step-pill ${active ? "active" : ""} ${done ? "done" : ""}`}>{label}</span>;
}

function ProviderPill({ status }: { status: SystemStatus | null }) {
  if (!status) return <span className="provider-pill warning">API 상태 알 수 없음</span>;
  const label = status.is_mock ? "Mock 모드" : status.vlm_provider === "google_genai" ? "Gemini 모드" : "OpenAI 호환 모드";
  const detail = status.vlm_model_name || (status.has_vlm_credentials ? "모델 준비됨" : "모델 미설정");
  return (
    <span className={`provider-pill ${status.is_mock ? "mock" : status.has_vlm_credentials ? "ready" : "warning"}`}>
      {label} · {detail}
    </span>
  );
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    ...options
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      message = formatApiDetail(body.detail) || message;
    } catch {
      // Keep HTTP status message.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

async function pollJob(jobId: string): Promise<ExtractionJob> {
  for (let attempt = 0; attempt < 75; attempt += 1) {
    const job = await api<ExtractionJob>(`/api/extraction-jobs/${jobId}`);
    if (["completed", "failed", "needs_review"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  throw new Error("제한 시간 안에 추출이 끝나지 않았습니다.");
}

function validateFields(fields: FieldDefinition[], regions: SchemaRegion[] = []) {
  if (!fields.length) return "Schema 필드를 최소 1개 이상 추가하세요.";
  const keys = fields.map((field) => field.key_name.trim());
  const regionIds = new Set(regions.map((region) => region.id));
  if (keys.some((key) => !key)) return "모든 필드에 필드명을 입력하세요.";
  if (fields.some((field) => !field.description.trim())) return "모든 필드에 설명을 입력하세요.";
  if (fields.some((field) => !OUTPUT_FORMATS.includes(field.output_format))) return "모든 필드의 출력 형식을 확인하세요.";
  if (fields.some((field) => field.region !== undefined && field.region !== null && !normalizeRegion(field.region))) {
    return "추출 영역은 page와 0~1 사이의 x, y, width, height 값을 사용해야 합니다.";
  }
  if (fields.some((field) => field.region_id && !regionIds.has(field.region_id))) return "필드에 연결된 영역은 저장된 추출 영역이어야 합니다.";
  if (new Set(keys).size !== keys.length) return "필드명은 중복될 수 없습니다.";
  if (new Set(regions.map((region) => region.id)).size !== regions.length) return "추출 영역 id는 중복될 수 없습니다.";
  return null;
}

function hasMeaningfulSchema(fields: SchemaField[]) {
  return fields.some((field) => field.key_name.trim() || field.description.trim());
}

function findSavedSchemaNameConflict(name: string, schemas: SavedSchema[], currentSchema: SavedSchema | null) {
  const normalized = name.trim();
  if (!normalized) return null;
  if (currentSchema && currentSchema.name.trim() === normalized) {
    return null;
  }
  return (
    schemas.find(
      (schema) =>
        !schema.ephemeral &&
        schema.id !== currentSchema?.id &&
        schema.name.trim() === normalized
    ) ?? null
  );
}

function schemaSaveStatusLabel(
  status: "idle" | "pending" | "saving" | "saved" | "error",
  savedSchema: SavedSchema | null
) {
  if (status === "saving") return "자동 저장 중";
  if (status === "pending") return "자동 저장 대기";
  if (status === "saved") return savedSchema ? "자동 저장됨" : "준비됨";
  if (status === "error") return "자동 저장 차단";
  return savedSchema ? "자동 저장됨" : "초안";
}

function reviewFilterLabel(filter: ReviewFilter) {
  const labels: Record<ReviewFilter, string> = {
    needs_review: "검토 필요",
    all: "전체",
    warning: "경고",
    null: "누락값",
    changed: "수정됨",
    low_confidence: "낮은 신뢰도",
    unreviewed: "미검수"
  };
  return labels[filter];
}

function statusLabel(status: string | null | undefined) {
  if (!status) return "상태 없음";
  const labels: Record<string, string> = {
    queued: "대기 중",
    running: "실행 중",
    completed: "완료",
    completed_with_errors: "일부 실패",
    failed: "실패",
    canceled: "취소됨",
    cancel_requested: "중단 요청됨",
    canceling: "중단 중",
    needs_review: "검토 필요",
    complete: "완료",
    incomplete: "누락 있음"
  };
  return labels[status] ?? status;
}

function schemaValidationHint(message: string | null) {
  if (!message) return null;
  const hints: Record<string, string> = {
    "Add at least one schema field.": "우측 schema에 최소 1개 이상의 필드를 추가하세요.",
    "Every field needs a key name.": "모든 필드에 필드명을 입력하세요.",
    "Every field needs a description.": "모든 필드에 설명을 입력하세요.",
    "Every field needs a supported output format.": "모든 필드의 출력 형식을 확인하세요.",
    "Extraction regions must use page plus x, y, width, height values between 0 and 1.": "Region 좌표는 0~1 사이 상대 좌표여야 합니다.",
    "Every field region must reference a saved extraction region.": "필드에 연결된 region이 저장된 region인지 확인하세요.",
    "Field key names must be unique.": "필드명은 중복될 수 없습니다.",
    "Extraction region ids must be unique.": "Region id는 중복될 수 없습니다."
  };
  return hints[message] ?? message;
}

function exportHref(resultId: string, format: "json" | "csv", presetId: string) {
  const params = new URLSearchParams({ format });
  if (presetId) params.set("preset_id", presetId);
  return `${API_BASE}/api/extraction-results/${resultId}/export?${params.toString()}`;
}

function documentPageImageSrc(page: DocumentPage) {
  return `${API_BASE}${page.image_url}?v=${page.width}x${page.height}`;
}

function documentPageThumbnailSrc(documentId: string, pageNumber = 1, width = 96) {
  return `${API_BASE}/api/documents/${documentId}/pages/${pageNumber}/thumbnail?width=${width}`;
}

function resolveImageUrl(url: string) {
  if (url.startsWith("blob:") || url.startsWith("data:") || url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  return `${API_BASE}${url}`;
}

function batchExportHref(batchId: string, format: "json" | "csv") {
  const params = new URLSearchParams({ format });
  return `${API_BASE}/api/batches/${batchId}/export?${params.toString()}`;
}

function parseEditedValue(value: string, format: OutputFormat): unknown {
  if (value === "") return null;
  if (format === "float") {
    const parsed = Number.parseFloat(value.replace(/[,$€£₩¥\s]/g, ""));
    return Number.isNaN(parsed) ? value : parsed;
  }
  if (format === "bool") {
    if (["true", "yes", "y", "1", "예", "네", "동의"].includes(value.toLowerCase())) return true;
    if (["false", "no", "n", "0", "아니오", "아니요", "미동의"].includes(value.toLowerCase())) return false;
  }
  return value;
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function stripLocalId(field: SchemaField): FieldDefinition {
  const payload: FieldDefinition = {
    key_name: field.key_name,
    description: field.description,
    output_format: field.output_format
  };
  if (field.region_id) payload.region_id = field.region_id;
  return payload;
}

function toSchemaFields(items: FieldDefinition[]): SchemaField[] {
  return items.map((field, index) => ({
    ...field,
    region_id: field.region_id ?? null,
    region: null,
    local_id: `${createLocalId()}_${index}`
  }));
}

function normalizeSchemaFieldsAndRegions(
  fields: FieldDefinition[],
  schemaRegions: SchemaRegion[]
): { fields: FieldDefinition[]; regions: SchemaRegion[] } {
  const regions = schemaRegions.map(normalizeSchemaRegion).filter(Boolean) as SchemaRegion[];
  const regionIds = new Set(regions.map((region) => region.id));
  const nextFields: FieldDefinition[] = [];

  fields.forEach((field) => {
    let regionId = field.region_id && regionIds.has(field.region_id) ? field.region_id : null;
    const legacyRegion = normalizeRegion(field.region);
    if (!regionId && legacyRegion) {
      const generatedId = createRegionId(regions);
      regions.push({
        ...legacyRegion,
        id: generatedId,
        name: `영역 ${regions.length + 1}`
      });
      regionIds.add(generatedId);
      regionId = generatedId;
    }
    nextFields.push({
      key_name: field.key_name,
      description: field.description,
      output_format: field.output_format,
      region_id: regionId
    });
  });

  return { fields: nextFields, regions };
}

function normalizeSchemaRegion(value: unknown): SchemaRegion | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<SchemaRegion>;
  const region = normalizeRegion(record);
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!region || !id || !name) return null;
  return { ...region, id, name };
}

function normalizeRegion(value: unknown): FieldRegion | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<FieldRegion>;
  const page = Number(record.page);
  const x = Number(record.x);
  const y = Number(record.y);
  const width = Number(record.width);
  const height = Number(record.height);
  if (![page, x, y, width, height].every(Number.isFinite)) return null;
  if (page < 1 || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) return null;
  return roundRegion({ page: Math.floor(page), x, y, width, height });
}

function roundRegion(region: FieldRegion): FieldRegion {
  const x = Math.min(0.99, clamp01(region.x));
  const y = Math.min(0.99, clamp01(region.y));
  return {
    page: Math.max(1, Math.floor(region.page)),
    x: roundCoordinate(x),
    y: roundCoordinate(y),
    width: roundCoordinate(Math.min(1 - x, Math.max(0.01, region.width))),
    height: roundCoordinate(Math.min(1 - y, Math.max(0.01, region.height)))
  };
}

function roundCoordinate(value: number): number {
  return Number(value.toFixed(4));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function formatRegionNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : value.toFixed(3);
}

function createLocalId(): string {
  if ("randomUUID" in crypto) return crypto.randomUUID();
  return `field_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function createRegionId(regions: SchemaRegion[]): string {
  const used = new Set(regions.map((region) => region.id));
  let index = regions.length + 1;
  while (used.has(`region_${index}`)) index += 1;
  return `region_${index}`;
}

function formatApiDetail(detail: unknown): string | null {
  if (!detail) return null;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const record = item as { loc?: unknown[]; msg?: unknown; type?: unknown };
          const location = Array.isArray(record.loc) ? record.loc.join(".") : "";
          const message = typeof record.msg === "string" ? record.msg : JSON.stringify(record);
          return location ? `${location}: ${message}` : message;
        }
        return String(item);
      })
      .join("; ");
  }
  if (typeof detail === "object") {
    const record = detail as Record<string, unknown>;
    if (typeof record.code === "string" && typeof record.message === "string") {
      const hint = typeof record.hint === "string" ? ` ${record.hint}` : "";
      return `${record.code}: ${record.message}${hint}`;
    }
    if (typeof record.message === "string") return record.message;
    return JSON.stringify(detail);
  }
  return String(detail);
}

function toFriendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (message.includes("VLM_CREDENTIALS_MISSING") || message.includes("VLM API key and model name are required")) {
    return "VLM 인증 정보가 없습니다. 홈의 설정에서 API key와 model name을 저장하거나 로컬 데모에서는 VLM_PROVIDER=mock을 사용하세요.";
  }
  if (message.includes("VLM_PROVIDER_UNSUPPORTED") || message.includes("Unsupported VLM_PROVIDER")) {
    return "지원하지 않는 VLM_PROVIDER입니다. auto, mock, openai_compatible, google_genai 중 하나를 사용하세요.";
  }
  if (message.includes("VLM_PROVIDER_REQUEST_FAILED")) {
    return message.replace("VLM_PROVIDER_REQUEST_FAILED: ", "");
  }
  if (message.includes("Schema name already exists")) {
    return "이미 저장된 schema 이름입니다. 드롭다운에서 기존 schema를 불러오거나 다른 이름으로 저장하세요.";
  }
  return message;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

function fileDisplayName(file: File) {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

function sortFilesByDisplayName(files: File[]) {
  return [...files].sort((left, right) =>
    fileDisplayName(left).localeCompare(fileDisplayName(right), undefined, {
      numeric: true,
      sensitivity: "base"
    })
  );
}

function isImageFile(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ["png", "jpg", "jpeg"].includes(extension) || file.type.startsWith("image/");
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function batchCanCancel(batch: Batch) {
  return batch.items.some((item) => item.status === "queued" || item.status === "running");
}

function formatConfidence(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return `${Math.round(value * 100)}%`;
}
