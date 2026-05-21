import {
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
    key_name: "document_number",
    description: "Primary document, invoice, receipt, application, or transaction number near the top.",
    output_format: "string"
  },
  {
    key_name: "document_date",
    description: "Main issued, submitted, or effective date printed on the document.",
    output_format: "date"
  },
  {
    key_name: "issuer_name",
    description: "Organization, bank, vendor, or authority that issued the document.",
    output_format: "string"
  },
  {
    key_name: "recipient_name",
    description: "Person or organization the document is addressed to or belongs to.",
    output_format: "string"
  },
  {
    key_name: "total_amount",
    description: "Final total, balance, transaction amount, or payment amount if visible.",
    output_format: "float"
  }
];

type OutputFormat = (typeof OUTPUT_FORMATS)[number];
type AppMode = "home" | "raw" | "key-info";
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
  current_version: number;
  is_template: boolean;
  template_category: string | null;
  pinned: boolean;
  ephemeral: boolean;
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
  schema_version: number;
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
  schema_version: number;
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
  schema_version: number;
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
  if (hash === "raw" || hash === "key-info") return hash;
  return "home";
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
    const mode = parsed.mode === "raw" || parsed.mode === "key-info" || parsed.mode === "home" ? parsed.mode : "home";
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
  const [batchSchemaId, setBatchSchemaId] = useState("");
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
  const batchSchemaOptions = useMemo(() => {
    const options = new Map<string, SavedSchema>();
    if (schema && !schema.ephemeral) options.set(schema.id, schema);
    recentSchemas.forEach((item) => options.set(item.id, item));
    return Array.from(options.values());
  }, [schema, recentSchemas]);
  const schemaNameConflict = useMemo(
    () => findSavedSchemaNameConflict(schemaName, recentSchemas, schema?.ephemeral ? null : schema?.id ?? null),
    [schemaName, recentSchemas, schema?.id, schema?.ephemeral]
  );
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
    await Promise.all([refreshHistory(), refreshRawHistory(), refreshSystemStatus(), loadVlmSettings(), refreshBatches(), searchArchive()]);
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
    const savedMode = saved.mode === "raw" || saved.mode === "key-info" || saved.mode === "home" ? saved.mode : modeFromLocation();
    replaceModeHash(savedMode);
    setMode(savedMode);
    try {
      if (savedMode === "raw" && saved.raw_id) {
        const loadedRaw = await api<RawExtraction>(`/api/raw-extractions/${saved.raw_id}`);
        setRawExtraction(loadedRaw);
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
    setBusy("Raw extraction processing");
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
        setError(extracted.error_message || "Raw extraction failed.");
      }
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  async function loadRawExtraction(rawId: string) {
    setBusy("Loading raw extraction");
    setError(null);
    try {
      const loaded = await api<RawExtraction>(`/api/raw-extractions/${rawId}`);
      setRawExtraction(loaded);
      if (loaded.status === "failed") {
        setError(loaded.error_message || "Raw extraction failed.");
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
    setBusy("Uploading document");
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
      setError("Upload a document before asking AI to recommend a schema.");
      return;
    }
    setBusy("Recommending schema");
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
    if (!document) {
      setError("Upload a document before asking AI to revise the schema description.");
      return;
    }
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
          document_id: document.document_id,
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

  async function saveSchema() {
    const validationError = validateFields(schemaPayloadFields, schemaPayloadRegions);
    if (validationError) {
      setError(validationError);
      return null;
    }
    const conflict = findSavedSchemaNameConflict(schemaName, recentSchemas, schema?.ephemeral ? null : schema?.id ?? null);
    if (conflict) {
      setError(`이미 저장된 schema 이름입니다: ${conflict.display_name || conflict.name}. 드롭다운에서 불러오거나 다른 이름으로 저장하세요.`);
      return null;
    }
    setBusy(schema ? "Saving schema version" : "Saving schema");
    setError(null);
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
      setSchemaDirty(false);
      await refreshHistory();
      return saved;
    } catch (err) {
      setError(toFriendlyError(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function runExtraction() {
    if (!document) {
      setError("Upload a document first.");
      return;
    }
    const validationError = validateFields(schemaPayloadFields, schemaPayloadRegions);
    if (validationError) {
      setError(validationError);
      return;
    }
    const useSavedSchema = Boolean(schema && !schemaDirty && !schema.ephemeral);

    setBusy("Running extraction");
    setError(null);
    try {
      const created = useSavedSchema
        ? await api<ExtractionJob>("/api/extraction-jobs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              document_id: document.document_id,
              schema_id: schema!.id,
              schema_version: schema!.current_version
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
        setError(completed.error_message || "Extraction failed.");
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
    setBusy("Saving corrections");
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
    setBusy("Loading document");
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
    setBusy("Loading schema");
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
    if (!schema || schema.id !== loadedSchema.id || schema.current_version !== loadedSchema.current_version) {
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

  function applySampleSchema() {
    setSchema(null);
    setSchemaName("sample_document_schema");
    setSchemaDescription("Starter schema for common business documents.");
    setRegions([]);
    setFields(toSchemaFields(SAMPLE_SCHEMA_FIELDS));
    setSchemaDirty(true);
    setStep("schema");
  }

  function importSchemaJson() {
    try {
      const parsed = JSON.parse(schemaJsonInput) as Partial<SchemaRecommendation>;
      if (!parsed.name || !Array.isArray(parsed.fields)) {
        setError("Schema JSON must include name and fields.");
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
      setError("Schema JSON could not be parsed.");
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

  async function markSchemaAsTemplate(category = "General") {
    if (!schema) {
      setError("Save the schema before adding it to templates.");
      return;
    }
    setBusy("Saving template");
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
    setBatchSchemaId(schema?.id ?? recentSchemas[0]?.id ?? "");
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

  async function selectBatchSchema(schemaId: string) {
    setBatchSchemaId(schemaId);
    if (!schemaId) return;
    const localSchema = batchSchemaOptions.find((item) => item.id === schemaId);
    if (localSchema) {
      applySchema(localSchema);
      setStep("schema");
    }
    try {
      const loaded = await api<SavedSchema>(`/api/schemas/${schemaId}`);
      applySchema(loaded);
      setStep("schema");
    } catch (err) {
      setError(toFriendlyError(err));
    }
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

  async function saveCurrentSchemaForBatch() {
    const saved = await saveSchema();
    if (!saved) return;
    setBatchSchemaId(saved.id);
    setBatchMessage("현재 schema를 저장하고 배치 처리 schema로 선택했습니다.");
  }

  async function runBatchUpload() {
    const selectedSchema = batchSchemaOptions.find((item) => item.id === batchSchemaId);
    if (!selectedSchema) {
      setBatchMessage("배치 처리에 사용할 저장된 schema를 선택하세요.");
      return;
    }
    if (!batchFiles.length) {
      setBatchMessage("배치 처리할 파일이나 폴더를 선택하세요.");
      return;
    }
    setBusy("배치 추출 준비 중");
    setError(null);
    setBatchMessage(null);
    try {
      const form = new FormData();
      form.append("schema_id", selectedSchema.id);
      form.append("schema_version", String(selectedSchema.current_version));
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
    setBusy("Canceling batch extraction");
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
      setError("Save the schema before creating an export preset.");
      return;
    }
    const name = `${schemaName || "schema"} export`;
    setBusy("Saving export preset");
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
    setMode(nextMode);
  }

  function goToPage(page: number | null) {
    if (!document || !page) return;
    setActivePage(Math.min(document.page_count - 1, Math.max(0, page - 1)));
  }

  function startResize(event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const workspace = event.currentTarget.closest<HTMLElement>(".workspace");
    if (!workspace) return;
    const rect = workspace.getBoundingClientRect();
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);

    const update = (clientX: number) => {
      const percent = ((clientX - rect.left) / rect.width) * 100;
      const nextPercent = Math.min(78, Math.max(35, percent));
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
          <h1>{mode === "home" ? "Digitize Your Document" : mode === "raw" ? "Raw Data Extractor" : "Key Information Workspace"}</h1>
        </div>
        <div className="status-strip">
          <ProviderPill status={systemStatus} />
          {mode !== "home" && (
            <button type="button" className="secondary compact" onClick={() => navigateMode("home")}>
              Home
            </button>
          )}
          {mode === "key-info" && (
            <>
              <StepPill label="Upload" active={step === "upload"} done={Boolean(document)} />
              <StepPill label="Schema" active={step === "schema"} done={Boolean(schema) && !schemaDirty} />
              <StepPill label="Review" active={step === "review"} done={Boolean(result)} />
            </>
          )}
          <button type="button" className="secondary compact" onClick={() => void refreshAll()} title="Refresh workspace">
            <RefreshCw size={16} />
            Refresh
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
              title="VLM and LibreOffice setting"
            >
              <Settings size={16} />
              Setting
            </button>
          )}
          <div className="help-trigger">
            <button type="button" className="help-button" aria-label="Usage guide">
              <CircleHelp size={18} />
            </button>
            <div className="help-panel" role="tooltip">
              <strong>Usage</strong>
              <span>Upload a document, then define or ask AI to recommend a schema.</span>
              <span>Save schema drafts before extraction. Existing schemas save as new versions.</span>
              <span>Review warnings, nulls, edits, evidence, and page references before export.</span>
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
        <HomeScreen onRaw={() => navigateMode("raw")} onKie={() => navigateMode("key-info")} />
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
      ) : (
        <main
          className="workspace"
          style={{ gridTemplateColumns: `minmax(320px, ${leftPanePercent}%) 12px minmax(380px, 1fr)` }}
        >
        <section className="document-pane">
          {!document ? (
            <KieUploadPanel
              schemas={batchSchemaOptions}
              selectedSchemaId={batchSchemaId}
              selectedFiles={batchFiles}
              selectedFileUrl={selectedDraftUrl}
              selectedFileIndex={draftBatchIndex}
              regions={regions}
              showRegions={regionsVisible}
              regionTarget={draftRegionTarget}
              message={batchMessage}
              currentSchemaDirty={schemaDirty}
              canSaveCurrentSchema={hasMeaningfulSchema(fields)}
              onSchema={(schemaId) => void selectBatchSchema(schemaId)}
              onSelectFile={setDraftBatchIndex}
              onSelectFiles={selectKieUploadFiles}
              onShowRegions={setRegionsVisible}
              onSaveRegion={saveRegion}
              onRemoveRegion={removeRegion}
              onClearFiles={() => {
                setBatchFiles([]);
                setDraftBatchIndex(0);
                setBatchMessage(null);
              }}
              onRunBatch={() => void runBatchUpload()}
              onSaveCurrentSchema={() => void saveCurrentSchemaForBatch()}
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
          title="Resize panes"
          aria-label="Resize panes"
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
              onSchemaJsonInput={setSchemaJsonInput}
              onImportSchemaJson={importSchemaJson}
              onUpdateField={updateField}
              onSaveRegion={saveRegion}
              onRemoveRegion={removeRegion}
              onAddField={addField}
              onRemoveField={removeField}
              onSaveSchema={saveSchema}
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
        </main>
      )}
      {archiveOpen && (
        <UtilityModal title="Search archive" eyebrow="Saved results" onClose={() => setArchiveOpen(false)}>
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
        <UtilityModal title="Recent items" eyebrow="History" onClose={() => setHistoryOpen(false)}>
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
        <UtilityModal title="Batch upload & results" eyebrow="Multiple files" onClose={() => setBatchOpen(false)}>
          <BatchPanel
            batches={batches}
            schemas={batchSchemaOptions}
            selectedSchemaId={batchSchemaId}
            selectedFiles={batchFiles}
            message={batchMessage}
            currentSchemaDirty={schemaDirty}
            canSaveCurrentSchema={hasMeaningfulSchema(fields)}
            onSchema={setBatchSchemaId}
            onSelectFiles={selectBatchFiles}
            onClearFiles={() => {
              setBatchFiles([]);
              setDraftBatchIndex(0);
              setBatchMessage(null);
            }}
            onRunBatch={() => void runBatchUpload()}
            onSaveCurrentSchema={() => void saveCurrentSchemaForBatch()}
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
    <section className="utility-dock" aria-label="KIE utility actions">
      <button type="button" className="secondary" onClick={props.onArchive}>
        <FileJson size={16} />
        Search archive
      </button>
      <button type="button" className="secondary" onClick={props.onBatch}>
        <FileSpreadsheet size={16} />
        Batch results
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
          <button type="button" className="icon-only secondary" aria-label="Close" onClick={props.onClose}>
            <X size={16} />
          </button>
        </div>
        {props.children}
      </section>
    </div>
  );
}

function HomeScreen(props: { onRaw: () => void; onKie: () => void }) {
  return (
    <main className="home-screen">
      <section className="home-hero">
        <p className="eyebrow">Workspace</p>
        <h2>문서 처리 방식을 선택하세요</h2>
        <p>원본 정보 추출, key information extraction, OCR, intelligence parsing을 하나의 workspace에서 확장합니다.</p>
      </section>
      <section className="feature-grid">
        <button className="feature-card active-feature" onClick={props.onRaw}>
          <FileUp size={24} />
          <strong>Raw Data Extractor</strong>
          <span>DOCX, XLSX, PPTX, PDF를 PDF preview와 HTML로 변환합니다.</span>
        </button>
        <button className="feature-card active-feature" onClick={props.onKie}>
          <Sparkles size={24} />
          <strong>Key Information Extractor</strong>
          <span>PDF, 이미지, DOCX, PPTX에서 schema에 맞는 값만 추출합니다.</span>
        </button>
        <button className="feature-card" disabled>
          <FileJson size={24} />
          <strong>OCR</strong>
          <span>Coming soon</span>
        </button>
        <button className="feature-card" disabled>
          <ClipboardList size={24} />
          <strong>Intelligence Parse</strong>
          <span>Coming soon</span>
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
            <p className="eyebrow">PDF Preview</p>
            <h2>{props.rawExtraction?.filename || "Upload raw document"}</h2>
          </div>
        </div>
        {props.pdfUrl ? (
          <iframe className="raw-frame" src={props.pdfUrl} title="PDF preview" />
        ) : (
          <label className="upload-zone" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
            <UploadCloud size={32} />
            <strong>Upload a raw document</strong>
            <span>DOCX, XLSX, PPTX, or PDF</span>
            <input type="file" accept=".docx,.xlsx,.pptx,.pdf" onChange={onFileChange} />
          </label>
        )}
      </section>

      <button
        className="splitter"
        type="button"
        title="Resize panes"
        aria-label="Resize panes"
        onPointerDown={props.onResize}
      >
        <GripVertical size={18} />
      </button>

      <aside className="side-pane">
        <section className="service-panel raw-controls">
          <div className="history-header">
            <div className="preview-title inline-title">
              <FileJson size={16} />
              HTML Preview
            </div>
            {props.htmlUrl && (
              <a className="secondary compact link-button" href={props.htmlUrl} target="_blank">
                Open HTML
              </a>
            )}
          </div>
          <label className="batch-upload">
            <UploadCloud size={16} />
            <span>Upload Raw Data Extractor file</span>
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
              <strong>{props.rawExtraction.status}</strong>
              <span>{props.rawExtraction.source_format.toUpperCase()} · {formatDate(props.rawExtraction.created_at)}</span>
              {props.rawExtraction.error_message && <span>{props.rawExtraction.error_message}</span>}
              {props.rawExtraction.warnings.length > 0 && <span>{props.rawExtraction.warnings.join(", ")}</span>}
            </div>
          )}
          {props.htmlUrl ? (
            <iframe className="raw-frame html-frame" src={props.htmlUrl} title="HTML extraction preview" />
          ) : (
            <div className="empty-state">업로드 후 추출 HTML이 여기에 표시됩니다.</div>
          )}
        </section>

        <section className="history-panel raw-history">
          <div className="history-header">
            <div className="preview-title inline-title">
              <History size={16} />
              Raw History
            </div>
            <button type="button" className="secondary compact" onClick={props.onToggleHistory}>
              {props.historyCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
              {props.historyCollapsed ? "Open" : "Close"}
            </button>
          </div>
          {!props.historyCollapsed && (
            <div className="history-list">
              {props.recentRawExtractions.length ? (
                props.recentRawExtractions.map((item) => (
                  <button key={item.id} onClick={() => props.onLoad(item.id)}>
                    <strong>{item.filename}</strong>
                    <span>
                      {item.status} · {item.source_format.toUpperCase()} · {formatDate(item.created_at)}
                    </span>
                  </button>
                ))
              ) : (
                <span className="muted">No raw extractions yet.</span>
              )}
            </div>
          )}
        </section>
      </aside>
    </main>
  );
}

function KieUploadPanel(props: {
  schemas: SavedSchema[];
  selectedSchemaId: string;
  selectedFiles: File[];
  selectedFileUrl: string | null;
  selectedFileIndex: number;
  regions: SchemaRegion[];
  showRegions: boolean;
  regionTarget: RegionEditorTarget | null;
  message: string | null;
  currentSchemaDirty: boolean;
  canSaveCurrentSchema: boolean;
  onSchema: (schemaId: string) => void;
  onSelectFile: (index: number) => void;
  onSelectFiles: (files: FileList | File[] | null) => void;
  onShowRegions: (show: boolean) => void;
  onSaveRegion: (region: SchemaRegion) => void;
  onRemoveRegion: (regionId: string) => void;
  onClearFiles: () => void;
  onRunBatch: () => void;
  onSaveCurrentSchema: () => void;
}) {
  const selectedFile = props.selectedFiles[props.selectedFileIndex] ?? props.selectedFiles[0] ?? null;
  const selectedUrl = props.selectedFileUrl;
  const [regionsOpen, setRegionsOpen] = useState(false);

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
        <label className="field-stack">
          <span>Schema</span>
          <select value={props.selectedSchemaId} onChange={(event) => props.onSchema(event.target.value)}>
            <option value="">Select saved schema</option>
            {props.schemas.map((schema) => (
              <option key={schema.id} value={schema.id}>
                {schema.display_name || schema.name} · v{schema.current_version} · {schema.fields.length} fields
              </option>
            ))}
          </select>
        </label>

        {props.currentSchemaDirty && (
          <div className="notice-card">
            현재 schema 변경사항이 저장되지 않았습니다. 최신 schema로 배치 처리하려면 먼저 저장하세요.
          </div>
        )}

        <div className="action-row">
          <button className="secondary" disabled={!props.canSaveCurrentSchema} onClick={props.onSaveCurrentSchema}>
            <Save size={16} />
            Save current schema
          </button>
        </div>

        <div className="file-picker-grid">
          <label className="batch-upload">
            <FileUp size={16} />
            <span>Select files</span>
            <input type="file" accept={KIE_FILE_ACCEPT} multiple onChange={onUnifiedFileChange} />
          </label>
          <label className="batch-upload">
            <UploadCloud size={16} />
            <span>Select folder</span>
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

        <button className="primary run-batch-button" disabled={!props.selectedSchemaId || !props.selectedFiles.length} onClick={props.onRunBatch}>
          <Play size={16} />
          Run batch
        </button>
      </>
    );
  }

  if (props.selectedFiles.length > 0) {
    return (
      <div className="kie-upload-panel" onDragOver={(event) => event.preventDefault()} onDrop={onUnifiedDrop}>
        <div className="pane-header">
          <div>
            <p className="eyebrow">Batch draft</p>
            <h2>{props.selectedFiles.length}개 파일 선택됨</h2>
          </div>
          <button type="button" className="secondary compact" onClick={props.onClearFiles}>
            <X size={16} />
            Clear
          </button>
        </div>

        <section className="batch-main-upload draft-controls draft-controls-horizontal">
          <div className="batch-intro">
            <strong>Batch upload</strong>
            <p>선택한 파일과 schema region을 확인한 뒤 같은 schema로 추출을 실행합니다.</p>
          </div>
          <div className="draft-region-actions">
            <button
              type="button"
              className={props.showRegions ? "secondary compact active-tool" : "secondary compact"}
              disabled={!props.regions.length}
              onClick={() => props.onShowRegions(!props.showRegions)}
              title={props.regions.length ? "선택한 이미지 위에 schema region을 표시합니다." : "저장된 region이 없습니다."}
            >
              <PanelLeft size={14} />
              Regions
            </button>
            <button
              type="button"
              className="secondary compact"
              disabled={!props.regionTarget}
              onClick={() => setRegionsOpen(true)}
              title={props.regionTarget ? "현재 선택한 batch 이미지 기준으로 region을 편집합니다." : "이미지 파일을 선택해야 region을 편집할 수 있습니다."}
            >
              Manage regions
            </button>
          </div>
          {renderBatchControls()}
        </section>

        <div className="draft-batch-workbench">
          <aside className="draft-file-rail" aria-label="Selected batch files">
            <div className="batch-rail-header">
              <div>
                <p className="eyebrow">Selected</p>
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
        {props.regionTarget && regionsOpen && (
          <RegionManagerModal
            target={props.regionTarget}
            regions={props.regions}
            activePage={0}
            onSaveRegion={props.onSaveRegion}
            onRemoveRegion={props.onRemoveRegion}
            onClose={() => setRegionsOpen(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="kie-upload-panel">
      <div className="pane-header">
        <div>
          <p className="eyebrow">KIE Upload</p>
          <h2>파일 또는 폴더 업로드</h2>
        </div>
      </div>

      <div className="unified-upload-layout" onDragOver={(event) => event.preventDefault()} onDrop={onUnifiedDrop}>
        <section className="unified-upload-actions">
          <label className="batch-upload folder-upload-action">
            <UploadCloud size={18} />
            <span>Select folder</span>
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
            <span>Select file(s)</span>
            <input type="file" accept={KIE_FILE_ACCEPT} multiple onChange={onUnifiedFileChange} />
          </label>
          {props.message && <div className="success-card">{props.message}</div>}
        </section>

        <label className="upload-zone unified-upload-zone" onDragOver={(event) => event.preventDefault()} onDrop={onUnifiedDrop}>
          <UploadCloud size={32} />
          <strong>Drop file(s) or folder</strong>
          <span>1 supported file opens single mode. 2+ supported files open batch mode.</span>
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
    <aside className="batch-file-rail" aria-label="Batch files">
      <div className="batch-rail-header">
        <div>
          <p className="eyebrow">Batch</p>
          <strong>{props.batch.completed_count + props.batch.failed_count + props.batch.canceled_count} / {props.batch.total_count}</strong>
        </div>
        <button type="button" className="icon-only secondary compact" title="Refresh batch" onClick={props.onRefresh}>
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
            Stop
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
          <em>{props.item.status}</em>
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
          <p className="eyebrow">Batch Review</p>
          <h2>{props.item.filename}</h2>
        </div>
        <span className={`status-badge ${props.item.status}`}>{props.item.status}</span>
      </div>

      <div className="progress-card">
        <strong>{finishedCount} / {props.batch.total_count} files processed</strong>
        <progress max={1} value={props.batch.progress} />
      </div>

      <div className={`raw-status ${props.item.status === "failed" ? "failed" : "completed"}`}>
        <strong>{props.item.status}</strong>
        <span>Batch status: {props.batch.status}</span>
        {props.item.error_message && <span>{props.item.error_message}</span>}
      </div>

      <div className="action-row">
        <button type="button" className="secondary" onClick={props.onRefresh}>
          <RefreshCw size={16} />
          Refresh
        </button>
        <a className="secondary link-button" href={batchExportHref(props.batch.id, "csv")} target="_blank">
          <FileSpreadsheet size={16} />
          Batch CSV
        </a>
        <a className="secondary link-button" href={batchExportHref(props.batch.id, "json")} target="_blank">
          <FileJson size={16} />
          Batch JSON
        </a>
        {batchCanCancel(props.batch) && (
          <button type="button" className="secondary danger-outline" onClick={() => props.onCancelBatch(props.batch.id)}>
            <X size={16} />
            Stop batch
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
    <div className="document-region-layer" aria-label="Schema regions">
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
            <p className="eyebrow">Setting</p>
            <h2 id="vlm-settings-title">API, model, LibreOffice</h2>
          </div>
          <button type="button" className="icon-only secondary" aria-label="Close settings" onClick={props.onClose}>
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
              <option value="">default</option>
              <option value="minimal">minimal</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>
          <label>
            <span>Verbosity</span>
            <select value={props.verbosity} onChange={(event) => props.onVerbosity(event.target.value)}>
              <option value="">default</option>
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
              placeholder="blank"
              onChange={(event) => props.onMaxCompletionTokens(event.target.value)}
            />
          </label>
          <label>
            <span>Top P</span>
            <input value={props.topP} placeholder="blank" onChange={(event) => props.onTopP(event.target.value)} />
          </label>
          <label>
            <span>Service tier</span>
            <input value={props.serviceTier} placeholder="blank" onChange={(event) => props.onServiceTier(event.target.value)} />
          </label>
          <label>
            <span>Batch workers</span>
            <input
              inputMode="numeric"
              value={props.batchMaxWorkers}
              placeholder="4"
              onChange={(event) => props.onBatchMaxWorkers(event.target.value)}
            />
          </label>
          <button type="button" className="primary compact" disabled={Boolean(props.busy)} onClick={props.onSave}>
            <Save size={16} />
            Save
          </button>
          <button type="button" className="secondary compact" disabled={Boolean(props.busy)} onClick={props.onClose}>
            Close
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
          <p className="eyebrow">Document</p>
          <h2>{props.document.filename}</h2>
        </div>
        <div className="toolbar">
          <button title="Previous page" onClick={() => props.onPage(Math.max(0, props.activePage - 1))}>
            <ChevronLeft size={18} />
          </button>
          <span className="page-count">
            {props.activePage + 1} / {props.document.page_count}
          </span>
          <button
            title="Next page"
            onClick={() => props.onPage(Math.min(props.document.page_count - 1, props.activePage + 1))}
          >
            <ChevronRight size={18} />
          </button>
          <button
            title="Fit width"
            className={props.zoomMode === "fitWidth" ? "active-tool" : ""}
            onClick={() => props.onZoomMode("fitWidth")}
          >
            <PanelLeft size={18} />
          </button>
          <button
            title="Fit page"
            className={props.zoomMode === "fitPage" ? "active-tool" : ""}
            onClick={() => props.onZoomMode("fitPage")}
          >
            <Maximize2 size={18} />
          </button>
          <button
            title="Zoom out"
            onClick={() => {
              props.onZoomMode("manual");
              props.onZoom(Math.max(0.5, props.zoom - 0.1));
            }}
          >
            <ZoomOut size={18} />
          </button>
          <button
            title="Zoom in"
            onClick={() => {
              props.onZoomMode("manual");
              props.onZoom(Math.min(2, props.zoom + 0.1));
            }}
          >
            <ZoomIn size={18} />
          </button>
          <button title="Rotate" onClick={() => props.onRotation((props.rotation + 90) % 360)}>
            <RotateCw size={18} />
          </button>
          <button
            title={props.regions.length ? "Show schema regions on the document" : "No schema regions saved"}
            className={props.showRegions ? "active-tool" : ""}
            disabled={!props.regions.length}
            onClick={() => props.onShowRegions(!props.showRegions)}
          >
            <PanelLeft size={18} />
            Regions
          </button>
          <label className="toolbar-upload" title="Replace document">
            <FileUp size={18} />
            <span>Replace</span>
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
          <button title="Clear document" onClick={props.onClear}>
            <X size={18} />
            Clear
          </button>
        </div>
      </div>
      <div className="viewer-body">
        <div className="thumbnail-rail" aria-label="Page thumbnails">
          {props.document.pages.map((page, index) => (
            <button
              key={page.id}
              className={index === props.activePage ? "active-thumb" : ""}
              title={`Page ${page.page}`}
              onClick={() => props.onPage(index)}
            >
              <img
                src={documentPageThumbnailSrc(props.document.document_id, page.page, 96)}
                alt={`Page ${page.page}`}
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
              <img className={imageClass} src={props.activeImageUrl} alt={`Page ${props.activePage + 1}`} />
              {props.showRegions && visibleRegions.length > 0 && (
                <div className="document-region-layer" aria-label="Schema regions">
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
          Recent
        </div>
        <div className="history-controls">
          {!props.collapsed && (
            <div className="segmented">
              <button className={props.activeTab === "documents" ? "active" : ""} onClick={() => props.onTab("documents")}>
                Docs
              </button>
              <button className={props.activeTab === "schemas" ? "active" : ""} onClick={() => props.onTab("schemas")}>
                Schemas
              </button>
              <button className={props.activeTab === "jobs" ? "active" : ""} onClick={() => props.onTab("jobs")}>
                Jobs
              </button>
            </div>
          )}
          <button type="button" className="secondary compact" onClick={props.onToggle}>
            {props.collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            {props.collapsed ? "Open" : "Close"}
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
                  <span>{item.page_count} page(s) · {formatDate(item.created_at)}</span>
                </button>
              ))
            ) : (
              <span className="muted">No documents yet.</span>
            ))}
          {props.activeTab === "schemas" &&
            (props.schemas.length ? (
              props.schemas.map((item) => (
                <button key={item.id} onClick={() => props.onLoadSchema(item.id)}>
                  <strong>{item.display_name || item.name}</strong>
                  <span>v{item.current_version} · {item.fields.length} field(s)</span>
                </button>
              ))
            ) : (
              <span className="muted">No schemas yet.</span>
            ))}
          {props.activeTab === "jobs" &&
            (props.jobs.length ? (
              props.jobs.map((item) => (
                <button key={item.job_id} onClick={() => props.onLoadJob(item.job_id)}>
                  <strong>{item.status}</strong>
                  <span>{item.result_id || "no result"} · {formatDate(item.created_at)}</span>
                </button>
              ))
            ) : (
              <span className="muted">No jobs yet.</span>
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
          Archive
        </div>
        <select value={props.status} onChange={(event) => props.onStatus(event.target.value)}>
          <option value="">All</option>
          <option value="completed">Completed</option>
          <option value="needs_review">Needs review</option>
          <option value="failed">Failed</option>
        </select>
      </div>
      <input
        className="search-input"
        value={props.query}
        placeholder="Search documents, schemas, extracted values"
        onChange={(event) => props.onQuery(event.target.value)}
      />
      <div className="mini-list">
        {props.results.length ? (
          props.results.slice(0, 4).map((item) => (
            <button key={`${item.document_id}_${item.job_id ?? "doc"}`} onClick={() => props.onOpen(item)}>
              <strong>{item.filename}</strong>
              <span>{item.document_type || item.schema_name || item.status || "document"} · {formatDate(item.created_at)}</span>
            </button>
          ))
        ) : (
          <span className="muted">No archive matches.</span>
        )}
      </div>
    </section>
  );
}

function BatchPanel(props: {
  batches: Batch[];
  schemas: SavedSchema[];
  selectedSchemaId: string;
  selectedFiles: File[];
  message: string | null;
  currentSchemaDirty: boolean;
  canSaveCurrentSchema: boolean;
  onSchema: (schemaId: string) => void;
  onSelectFiles: (files: FileList | null) => void;
  onClearFiles: () => void;
  onRunBatch: () => void;
  onSaveCurrentSchema: () => void;
  onCancelBatch: (batchId: string) => void;
  onRefresh: () => void;
  onOpenItem: (batchId: string, itemId: string) => void;
}) {
  return (
    <section className="service-panel batch-panel">
      <div className="batch-create-panel">
        <div className="batch-intro">
          <strong>Batch upload</strong>
          <p>저장된 schema 하나를 선택한 뒤 여러 문서나 폴더를 업로드해 같은 기준으로 KIE 추출을 실행합니다.</p>
        </div>

        <label className="field-stack">
          <span>Schema</span>
          <select value={props.selectedSchemaId} onChange={(event) => props.onSchema(event.target.value)}>
            <option value="">Select saved schema</option>
            {props.schemas.map((schema) => (
              <option key={schema.id} value={schema.id}>
                {schema.display_name || schema.name} · v{schema.current_version} · {schema.fields.length} fields
              </option>
            ))}
          </select>
        </label>

        {props.currentSchemaDirty && (
          <div className="notice-card">
            현재 화면의 schema에 저장되지 않은 변경사항이 있습니다. 배치 처리에 최신 schema를 쓰려면 먼저 저장하세요.
          </div>
        )}

        <div className="action-row">
          <button className="secondary" disabled={!props.canSaveCurrentSchema} onClick={props.onSaveCurrentSchema}>
            <Save size={16} />
            Save current schema
          </button>
        </div>

        <div className="file-picker-grid">
          <label className="batch-upload">
            <FileUp size={16} />
            <span>Select files</span>
            <input
              type="file"
              accept={KIE_FILE_ACCEPT}
              multiple
              onChange={(event) => props.onSelectFiles(event.target.files)}
            />
          </label>
          <label className="batch-upload">
            <UploadCloud size={16} />
            <span>Select folder</span>
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
              <strong>{props.selectedFiles.length} selected</strong>
              <button type="button" className="ghost compact" onClick={props.onClearFiles}>
                Clear
              </button>
            </div>
            <div className="mini-list">
              {props.selectedFiles.slice(0, 8).map((file, index) => (
                <span key={`${fileDisplayName(file)}_${file.size}_${index}`}>{fileDisplayName(file)}</span>
              ))}
              {props.selectedFiles.length > 8 && <span className="muted">+ {props.selectedFiles.length - 8} more</span>}
            </div>
          </div>
        )}

        {props.message && <div className="success-card">{props.message}</div>}

        <button className="primary run-batch-button" disabled={!props.selectedSchemaId || !props.selectedFiles.length} onClick={props.onRunBatch}>
          <Play size={16} />
          Run batch
        </button>
      </div>

      <div className="batch-results-panel">
        <div className="history-header">
          <div className="preview-title inline-title">
            <FileSpreadsheet size={16} />
            Recent batch results
          </div>
          <button className="secondary compact" onClick={props.onRefresh}>
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
        <div className="mini-list">
          {props.batches.length ? (
            props.batches.map((batch) => (
              <div className="batch-card" key={batch.id}>
                <div className="batch-top">
                  <strong>{batch.status}</strong>
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
                    {batch.completed_count} done · {batch.failed_count} failed · {batch.canceled_count} canceled · {batch.total_count} total
                  </span>
                  {batchCanCancel(batch) && (
                    <button type="button" className="secondary compact danger-outline" onClick={() => props.onCancelBatch(batch.id)}>
                      <X size={14} />
                      Stop
                    </button>
                  )}
                </div>
                {batch.items.map((item) => (
                  <button key={item.id} onClick={() => props.onOpenItem(batch.id, item.id)}>
                    <strong>{item.filename}</strong>
                    <span>{item.status} · Open review</span>
                  </button>
                ))}
              </div>
            ))
          ) : (
            <span className="muted">No batch results yet.</span>
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
          <p className="eyebrow">Start</p>
          <h2>Upload first</h2>
        </div>
      </div>
      <p>Schema builder opens after upload. You can also prepare a sample schema now.</p>
      <button className="secondary" onClick={onSampleSchema}>
        <ClipboardList size={16} />
        Use sample schema
      </button>
      <div className="note-list">
        <span>Supported: PDF, PNG, JPG, JPEG, DOCX, PPTX</span>
        <span>Schema fields: key name, description, output format</span>
        <span>Use the Setting button to save API key and model name.</span>
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
  onSchemaJsonInput: (value: string) => void;
  onImportSchemaJson: () => void;
  onUpdateField: (index: number, patch: Partial<FieldDefinition>) => void;
  onSaveRegion: (region: SchemaRegion) => void;
  onRemoveRegion: (regionId: string) => void;
  onAddField: () => void;
  onRemoveField: (index: number) => void;
  onSaveSchema: () => Promise<SavedSchema | null>;
  onRunExtraction: () => Promise<void>;
  onRecommendSchema: () => Promise<void>;
  onRecommendSchemaDescription: () => Promise<void>;
  onSampleSchema: () => void;
  onLoadTemplate: (schema: SavedSchema) => void;
  onSaveTemplate: () => void;
  canExtract: boolean;
}) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [regionsOpen, setRegionsOpen] = useState(false);

  return (
    <div className="schema-builder">
      <div className="pane-header schema-main-header">
        <div>
          <p className="eyebrow">Schema</p>
          <h2>Define extraction fields</h2>
        </div>
        <div className="schema-header-actions">
          {props.savedSchema && (
            <span className={`saved-badge ${props.schemaDirty ? "dirty" : ""}`}>
              {props.schemaDirty ? "Draft changes" : `Saved v${props.savedSchema.current_version}`}
            </span>
          )}
          <button
            type="button"
            className="primary compact"
            disabled={!props.document}
            title={props.document ? "AI가 현재 문서를 기준으로 schema를 추천합니다." : "서버에 업로드된 문서가 있어야 AI schema 추천을 사용할 수 있습니다."}
            onClick={() => void props.onRecommendSchema()}
          >
            <Sparkles size={14} />
            AI recommend schema
          </button>
          <button type="button" className="secondary compact" onClick={() => setToolsOpen(true)}>
            <Settings size={14} />
            More options
          </button>
        </div>
      </div>

      <div className="schema-core-panel">
        <div className="schema-name-grid">
          <label className="field-stack">
            <span>Schema name</span>
            <input value={props.schemaName} onChange={(event) => props.onSchemaName(event.target.value)} />
          </label>
          <label className="field-stack">
            <span>Load saved schema</span>
            <select
              value={props.savedSchema?.id ?? ""}
              onChange={(event) => {
                if (event.target.value) props.onLoadSavedSchema(event.target.value);
              }}
            >
              <option value="">저장된 schema 선택</option>
              {props.savedSchemas.map((savedSchema) => (
                <option key={savedSchema.id} value={savedSchema.id}>
                  {savedSchema.display_name || savedSchema.name} · v{savedSchema.current_version} · {savedSchema.fields.length} fields
                </option>
              ))}
            </select>
          </label>
        </div>
        {props.schemaNameConflict && (
          <div className="notice-card compact-notice">
            이미 저장된 schema 이름입니다. 기존 schema를 수정하려면 드롭다운에서{" "}
            <strong>{props.schemaNameConflict.display_name || props.schemaNameConflict.name}</strong>을 불러오세요.
          </div>
        )}
        <div className="field-stack">
          <div className="field-label-row">
            <span>Schema description</span>
            <button
              type="button"
              className="secondary compact mini-action"
              disabled={!props.document || !props.fields.length}
              title={props.document ? "현재 필드와 문서 이미지를 보고 schema description만 다시 작성합니다." : "문서 이미지가 있어야 사용할 수 있습니다."}
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
            <strong>Extraction regions</strong>
            <span>{props.regions.length ? `${props.regions.length} saved` : "No shared regions"}</span>
          </div>
          <button
            type="button"
            className="secondary compact"
            disabled={!props.regionTarget}
            title={props.regionTarget ? "현재 선택한 이미지 위에 extraction region을 지정합니다." : "문서 이미지가 있어야 region을 지정할 수 있습니다."}
            onClick={() => setRegionsOpen(true)}
          >
            Manage regions
          </button>
        </div>

        <div className="schema-table-wrap">
          <div className="schema-field-table" role="table" aria-label="Schema fields">
            <div className="schema-field-head" role="row">
              <span>Key name</span>
              <span>Description</span>
              <span>Type</span>
              <span>Region</span>
              <span />
            </div>
          {props.fields.map((field, index) => (
            <div className="schema-field-row" role="row" key={field.local_id}>
              <input
                aria-label="Key name"
                value={field.key_name}
                onChange={(event) => props.onUpdateField(index, { key_name: event.target.value })}
              />
              <textarea
                aria-label="Description"
                className="schema-description-input"
                value={field.description}
                placeholder="Where and how the value should be found"
                onChange={(event) => props.onUpdateField(index, { description: event.target.value })}
              />
              <select
                aria-label="Output format"
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
                aria-label="Region"
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
              <button className="ghost danger icon-only" title="Remove field" onClick={() => props.onRemoveField(index)}>
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          </div>
        </div>

        <div className="action-row">
          <button className="secondary" onClick={props.onAddField}>
            <Plus size={16} />
            Add field
          </button>
          <button className="secondary" onClick={() => void props.onSaveSchema()}>
            <Save size={16} />
            Save schema
          </button>
          <button className="primary" disabled={!props.canExtract} onClick={() => void props.onRunExtraction()}>
            <Play size={16} />
            Extract
          </button>
        </div>
      </div>

      {toolsOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal-panel schema-tools-modal" role="dialog" aria-modal="true" aria-label="Schema tools">
            <div className="modal-header">
              <div>
                <p className="eyebrow">Schema options</p>
                <h2>Template and JSON</h2>
              </div>
              <button type="button" className="icon-only secondary" aria-label="Close schema tools" onClick={() => setToolsOpen(false)}>
                <X size={16} />
              </button>
            </div>

            {props.document && (
              <div className="intel-card">
                <div>
                  <span className="eyebrow">Document intelligence</span>
                  <strong>{props.document.document_type || "Unknown document type"}</strong>
                </div>
                <span>{props.document.language || "language unknown"} · {props.document.page_count} page(s)</span>
                {props.document.recommendation_reasoning && <p>{props.document.recommendation_reasoning}</p>}
              </div>
            )}

            {props.systemStatus?.is_mock && (
              <div className="notice-card">Mock mode is active. AI recommendation and extraction use deterministic demo data.</div>
            )}

            <div className="tool-section">
              <h3>Schema import/export</h3>
              <div className="action-row">
                <button
                  className="secondary"
                  onClick={() => {
                    props.onSampleSchema();
                    setToolsOpen(false);
                  }}
                >
                  <ClipboardList size={16} />
                  Use sample schema
                </button>
                <a className="secondary link-button" href={props.schemaDownloadUrl} download={`${props.schemaName || "schema"}.json`}>
                  <FileDown size={16} />
                  Download schema JSON
                </a>
              </div>
            </div>

            <div className="template-strip">
              <div className="template-header">
                <strong>Template library</strong>
                <button className="secondary compact" onClick={props.onSaveTemplate}>
                  Save as template
                </button>
              </div>
              <div className="template-list">
                {props.templates.length ? (
                  props.templates.slice(0, 4).map((template) => (
                    <button key={template.id} onClick={() => props.onLoadTemplate(template)}>
                      <strong>{template.display_name || template.name}</strong>
                      <span>{template.template_category || "General"} · {template.fields.length} fields</span>
                    </button>
                  ))
                ) : (
                  <span className="muted">Save a schema as a template to reuse it here.</span>
                )}
              </div>
            </div>

            <details className="import-box">
              <summary>
                <FileUp size={16} />
                Import schema JSON
              </summary>
              <textarea
                value={props.schemaJsonInput}
                onChange={(event) => props.onSchemaJsonInput(event.target.value)}
                placeholder="Paste schema JSON here"
              />
              <button className="secondary" onClick={props.onImportSchemaJson}>
                <FileUp size={16} />
                Import
              </button>
            </details>

            <div className="preview-block">
              <div className="preview-title">
                <FileJson size={16} />
                JSON preview
              </div>
              <pre>{props.schemaPreview}</pre>
            </div>
          </section>
        </div>
      )}
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
      name: `Region ${props.regions.length + 1}`,
      page,
      x: 0.1,
      y: 0.1,
      width: 0.25,
      height: 0.12
    });
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-panel region-manager-modal" role="dialog" aria-modal="true" aria-label="Extraction regions">
        <div className="modal-header">
          <div>
            <p className="eyebrow">Extraction regions</p>
            <h2>Shared region templates</h2>
          </div>
          <button type="button" className="icon-only secondary" aria-label="Close regions" onClick={props.onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="region-manager-actions">
          <p>하나의 region을 여러 field에 할당할 수 있습니다. field row의 region select에서 원하는 region을 선택하세요.</p>
          <button type="button" className="primary compact" onClick={createRegion}>
            <Plus size={16} />
            Add region
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
                    Edit
                  </button>
                  <button type="button" className="ghost compact danger" onClick={() => props.onRemoveRegion(region.id)}>
                    Delete
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
      <section className="modal-panel region-picker-modal" role="dialog" aria-modal="true" aria-label="Extraction region">
        <div className="modal-header">
          <div>
            <p className="eyebrow">Extraction region</p>
            <h2>{regionName || props.region.name}</h2>
          </div>
          <button type="button" className="icon-only secondary" aria-label="Close region picker" onClick={props.onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="region-toolbar">
          <label>
            <span>Name</span>
            <input value={regionName} onChange={(event) => setRegionName(event.target.value)} />
          </label>
          <label>
            <span>Page</span>
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
                  Page {item.page}
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
            <img ref={imageRef} className="region-target-image" src={imageUrl} alt={`Page ${page.page}`} draggable={false} />
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
            Cancel
          </button>
          <button className="primary" disabled={!normalizedRegion} onClick={saveRegion}>
            <Save size={16} />
            Save region
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
    return <div className="empty-state">No extraction result yet.</div>;
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
          <p className="eyebrow">Review</p>
          <h2>Extraction result</h2>
        </div>
        <span className={`status-badge ${props.result.validated_output.status}`}>{props.result.validated_output.status}</span>
      </div>

      <div className="progress-card">
        <strong>{reviewedCount} / {props.fields.length} reviewed</strong>
        <progress max={props.fields.length || 1} value={reviewedCount} />
      </div>

      <div className="filter-row">
        <Filter size={16} />
        {(["needs_review", "all", "warning", "null", "low_confidence", "unreviewed", "changed"] as ReviewFilter[]).map((filter) => (
          <button key={filter} className={props.filter === filter ? "active" : ""} onClick={() => props.onFilter(filter)}>
            {filter}
          </button>
        ))}
      </div>

      <div className="result-table">
        <div className="result-head">
          <span>field</span>
          <span>value</span>
          <span>page</span>
          <span>confidence</span>
          <span>warnings</span>
          <span>reviewed</span>
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
                {isEdited && <small>Original: {stringifyValue(originalValue?.value)}</small>}
              </label>
              <button className="ghost page-link" onClick={() => props.onGoToPage(value?.page ?? null)}>
                {value?.page ?? "-"}
              </button>
              <span>{formatConfidence(value?.confidence)}</span>
              <span className={value?.warnings?.length ? "warn-text" : "muted"}>
                {value?.warnings?.length ? value.warnings.join(", ") : "valid"}
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
          Save corrections
        </button>
        <select value={props.selectedPresetId} onChange={(event) => props.onPreset(event.target.value)}>
          <option value="">Default export</option>
          {props.exportPresets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </select>
        <button className="secondary" onClick={props.onSavePreset}>
          <Save size={16} />
          Save preset
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
        <div className="preview-title">Raw model output</div>
        <pre>{JSON.stringify(props.result.raw_model_output, null, 2)}</pre>
      </div>
    </div>
  );
}

function AuditPanel({ events }: { events: AuditEvent[] }) {
  return (
    <div className="audit-panel">
      <div className="preview-title">Audit log</div>
      <div className="mini-list">
        {events.length ? (
          events.map((event) => (
            <div className="audit-row" key={event.id}>
              <strong>{event.action}</strong>
              <span>{event.message || event.entity_type} · {formatDate(event.created_at)}</span>
            </div>
          ))
        ) : (
          <span className="muted">No audit events loaded.</span>
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
            <p className="eyebrow">AI recommendation</p>
            <h2>Apply recommended schema?</h2>
          </div>
        </div>
        <p>{props.recommendation.reasoning || "AI generated a new schema draft for this document."}</p>
        <div className="diff-grid">
          <DiffList title="Added" items={added.map((field) => field.key_name)} />
          <DiffList title="Changed" items={changed.map((field) => field.key_name)} />
          <DiffList title="Removed" items={removed.map((field) => field.key_name)} />
        </div>
        <div className="action-row">
          <button className="secondary" onClick={props.onCancel}>Cancel</button>
          <button className="primary" onClick={props.onApply}>Apply recommendation</button>
        </div>
      </div>
    </div>
  );
}

function DiffList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="diff-list">
      <strong>{title}</strong>
      {items.length ? items.map((item) => <span key={item}>{item}</span>) : <span className="muted">None</span>}
    </div>
  );
}

function StepPill({ label, active, done }: { label: string; active: boolean; done: boolean }) {
  return <span className={`step-pill ${active ? "active" : ""} ${done ? "done" : ""}`}>{label}</span>;
}

function ProviderPill({ status }: { status: SystemStatus | null }) {
  if (!status) return <span className="provider-pill warning">API unknown</span>;
  const label = status.is_mock ? "Mock mode" : status.vlm_provider === "google_genai" ? "Gemini mode" : "OpenAI-compatible mode";
  const detail = status.vlm_model_name || (status.has_vlm_credentials ? "model ready" : "missing model");
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
  throw new Error("Extraction did not finish in time.");
}

function validateFields(fields: FieldDefinition[], regions: SchemaRegion[] = []) {
  if (!fields.length) return "Add at least one schema field.";
  const keys = fields.map((field) => field.key_name.trim());
  const regionIds = new Set(regions.map((region) => region.id));
  if (keys.some((key) => !key)) return "Every field needs a key name.";
  if (fields.some((field) => !field.description.trim())) return "Every field needs a description.";
  if (fields.some((field) => !OUTPUT_FORMATS.includes(field.output_format))) return "Every field needs a supported output format.";
  if (fields.some((field) => field.region !== undefined && field.region !== null && !normalizeRegion(field.region))) {
    return "Extraction regions must use page plus x, y, width, height values between 0 and 1.";
  }
  if (fields.some((field) => field.region_id && !regionIds.has(field.region_id))) return "Every field region must reference a saved extraction region.";
  if (new Set(keys).size !== keys.length) return "Field key names must be unique.";
  if (new Set(regions.map((region) => region.id)).size !== regions.length) return "Extraction region ids must be unique.";
  return null;
}

function hasMeaningfulSchema(fields: SchemaField[]) {
  return fields.some((field) => field.key_name.trim() || field.description.trim());
}

function findSavedSchemaNameConflict(name: string, schemas: SavedSchema[], currentSchemaId: string | null) {
  const normalized = name.trim();
  if (!normalized) return null;
  return (
    schemas.find(
      (schema) =>
        !schema.ephemeral &&
        schema.id !== currentSchemaId &&
        (schema.name.trim() === normalized || (schema.display_name ?? "").trim() === normalized)
    ) ?? null
  );
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
        name: `Region ${regions.length + 1}`
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
  if (typeof detail === "object") return JSON.stringify(detail);
  return String(detail);
}

function toFriendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (message.includes("VLM API key and model name are required")) {
    return "VLM credentials are missing. Go Home and use Setting to save API key and model name, or use VLM_PROVIDER=mock for a local demo.";
  }
  if (message.includes("Unsupported VLM_PROVIDER")) {
    return "Unsupported VLM_PROVIDER. Use auto, mock, openai_compatible, or google_genai.";
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
