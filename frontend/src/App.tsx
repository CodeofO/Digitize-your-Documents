import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up.js";
import CircleHelp from "lucide-react/dist/esm/icons/circle-help.js";
import ClipboardList from "lucide-react/dist/esm/icons/clipboard-list.js";
import Download from "lucide-react/dist/esm/icons/download.js";
import FileDown from "lucide-react/dist/esm/icons/file-down.js";
import FileJson from "lucide-react/dist/esm/icons/file-json.js";
import FileSpreadsheet from "lucide-react/dist/esm/icons/file-spreadsheet.js";
import FileUp from "lucide-react/dist/esm/icons/file-up.js";
import Filter from "lucide-react/dist/esm/icons/filter.js";
import GripVertical from "lucide-react/dist/esm/icons/grip-vertical.js";
import History from "lucide-react/dist/esm/icons/history.js";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.js";
import Maximize2 from "lucide-react/dist/esm/icons/maximize-2.js";
import PanelLeft from "lucide-react/dist/esm/icons/panel-left.js";
import Play from "lucide-react/dist/esm/icons/play.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import RotateCw from "lucide-react/dist/esm/icons/rotate-cw.js";
import Save from "lucide-react/dist/esm/icons/save.js";
import Settings from "lucide-react/dist/esm/icons/settings.js";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.js";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.js";
import UploadCloud from "lucide-react/dist/esm/icons/upload-cloud.js";
import X from "lucide-react/dist/esm/icons/x.js";
import ZoomIn from "lucide-react/dist/esm/icons/zoom-in.js";
import ZoomOut from "lucide-react/dist/esm/icons/zoom-out.js";
import { ChangeEvent, DragEvent, PointerEvent, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";
const OUTPUT_FORMATS = ["string", "float", "date", "bool"] as const;
const KIE_FILE_ACCEPT = ".pdf,.png,.jpg,.jpeg,.docx,.pptx";
const KIE_FILE_EXTENSIONS = new Set(["pdf", "png", "jpg", "jpeg", "docx", "pptx"]);
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

type DocumentPage = {
  id: string;
  page: number;
  image_url: string;
  width: number;
  height: number;
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
  has_api_key: boolean;
  env_path: string;
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

type AuditEvent = {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
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

export default function App() {
  const [mode, setMode] = useState<AppMode>(() => modeFromLocation());
  const [step, setStep] = useState<Step>("upload");
  const [document, setDocument] = useState<UploadedDocument | null>(null);
  const [schemaName, setSchemaName] = useState("document_schema");
  const [schemaDescription, setSchemaDescription] = useState("");
  const [fields, setFields] = useState<SchemaField[]>(initialFields);
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
  const [leftPanePercent, setLeftPanePercent] = useState(50);
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
  const [batchMessage, setBatchMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    const onPopState = () => setMode(modeFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (mode !== "home") {
      setLeftPanePercent(50);
    }
  }, [mode]);

  useEffect(() => {
    if (schema?.id) {
      void loadExportPresets(schema.id);
    }
  }, [schema?.id]);

  const schemaPayloadFields = useMemo(() => fields.map(stripLocalId), [fields]);
  const schemaPreview = useMemo(
    () =>
      JSON.stringify(
        {
          name: schemaName,
          display_name: schemaName,
          description: schemaDescription || null,
          fields: schemaPayloadFields
        },
        null,
        2
      ),
    [schemaName, schemaDescription, schemaPayloadFields]
  );

  const schemaDownloadUrl = useMemo(
    () => `data:application/json;charset=utf-8,${encodeURIComponent(schemaPreview)}`,
    [schemaPreview]
  );

  const activeImageUrl = useMemo(() => {
    if (!document?.pages.length) return null;
    return `${API_BASE}${document.pages[activePage].image_url}`;
  }, [document, activePage]);

  const rawPdfUrl = useMemo(() => (rawExtraction?.pdf_url ? `${API_BASE}${rawExtraction.pdf_url}` : null), [rawExtraction]);
  const rawHtmlUrl = useMemo(() => (rawExtraction?.html_url ? `${API_BASE}${rawExtraction.html_url}` : null), [rawExtraction]);

  const result = job?.result ?? null;
  const currentValues = Object.keys(edits).length ? edits : result?.corrected_output?.values ?? result?.validated_output.values ?? {};
  const templates = recentSchemas.filter((item) => item.is_template || item.pinned);
  const batchSchemaOptions = useMemo(() => {
    const options = new Map<string, SavedSchema>();
    if (schema) options.set(schema.id, schema);
    recentSchemas.forEach((item) => options.set(item.id, item));
    return Array.from(options.values());
  }, [schema, recentSchemas]);
  const hasPreparedSchema = Boolean(document) || Boolean(schema) || schemaDirty || hasMeaningfulSchema(fields);

  async function refreshAll() {
    await Promise.all([refreshHistory(), refreshRawHistory(), refreshSystemStatus(), loadVlmSettings(), refreshBatches(), searchArchive()]);
    if (rawExtraction) {
      void loadRawExtraction(rawExtraction.id);
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
      setRecentSchemas(schemas.slice(0, 12));
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
          provider: "openai"
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

  async function refreshBatches() {
    try {
      setBatches(await api<Batch[]>("/api/batches?limit=8"));
    } catch {
      setBatches([]);
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

  function applyRecommendation(recommendation: SchemaRecommendation) {
    setSchema(null);
    setSchemaName(recommendation.name || "ai_recommended_schema");
    setSchemaDescription(recommendation.description ?? "");
    setFields(toSchemaFields(recommendation.fields));
    setSchemaDirty(true);
    setPendingRecommendation(null);
    setStep("schema");
  }

  async function saveSchema() {
    const validationError = validateFields(schemaPayloadFields);
    if (validationError) {
      setError(validationError);
      return null;
    }
    setBusy(schema ? "Saving schema version" : "Saving schema");
    setError(null);
    try {
      const body = JSON.stringify({
        name: schemaName,
        display_name: schemaName,
        description: schemaDescription || null,
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
    const activeSchema = !schema || schemaDirty ? await saveSchema() : schema;
    if (!activeSchema) return;

    setBusy("Running extraction");
    setError(null);
    try {
      const created = await api<ExtractionJob>("/api/extraction-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document_id: document.document_id,
          schema_id: activeSchema.id,
          schema_version: activeSchema.current_version
        })
      });
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
      const loaded = await api<SavedSchema>(`/api/schemas/${schemaId}`);
      applySchema(loaded);
      setStep("schema");
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  async function loadJob(jobId: string) {
    setBusy("Loading extraction job");
    setError(null);
    try {
      const loadedJob = await api<ExtractionJob>(`/api/extraction-jobs/${jobId}`);
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
        setStep("review");
        void loadAuditEvents("extraction_result", loadedJob.result.id);
      } else {
        setStep("schema");
      }
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  function applyDocument(nextDocument: UploadedDocument) {
    setDocument(nextDocument);
    setActivePage(0);
    setRotation(0);
    setJob(null);
    setEdits({});
    setEditedKeys([]);
    setReviewedFields([]);
    setAuditEvents([]);
  }

  function applySchema(nextSchema: SavedSchema) {
    setSchema(nextSchema);
    setSchemaName(nextSchema.name);
    setSchemaDescription(nextSchema.description ?? "");
    setFields(toSchemaFields(nextSchema.fields));
    setSchemaDirty(false);
  }

  function applySampleSchema() {
    setSchema(null);
    setSchemaName("sample_document_schema");
    setSchemaDescription("Starter schema for common business documents.");
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
        output_format: field.output_format as OutputFormat
      }));
      const validationError = validateFields(fieldsFromJson);
      if (validationError) {
        setError(validationError);
        return;
      }
      setSchema(null);
      setSchemaName(parsed.name);
      setSchemaDescription(parsed.description ?? "");
      setFields(toSchemaFields(fieldsFromJson));
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
  }

  function selectBatchFiles(files: FileList | null) {
    const selected = files ? Array.from(files) : [];
    const supported = selected.filter((file) => KIE_FILE_EXTENSIONS.has(file.name.split(".").pop()?.toLowerCase() ?? ""));
    const ignoredCount = selected.length - supported.length;
    setBatchMessage(ignoredCount ? `지원하지 않는 파일 ${ignoredCount}개는 제외했습니다.` : null);
    setBatchFiles(supported);
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
    setBusy("Creating batch extraction");
    setError(null);
    setBatchMessage(null);
    try {
      const form = new FormData();
      form.append("schema_id", selectedSchema.id);
      form.append("schema_version", String(selectedSchema.current_version));
      batchFiles.forEach((file) => form.append("files", file));
      const batch = await api<Batch>("/api/batches", { method: "POST", body: form });
      setBatches((current) => [batch, ...current.filter((item) => item.id !== batch.id)].slice(0, 8));
      setBatchFiles([]);
      setBatchMessage(`${batch.total_count}개 파일의 배치 추출을 시작했습니다. 아래 결과 목록에서 진행 상태를 확인하세요.`);
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

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) void uploadFile(file);
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void uploadFile(file);
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
      setLeftPanePercent(Math.min(78, Math.max(35, percent)));
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
            <label className="upload-zone" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
                <UploadCloud size={32} />
                <strong>Upload a document</strong>
                <span>PDF, PNG, JPG, JPEG, DOCX, or PPTX</span>
                <input type="file" accept={KIE_FILE_ACCEPT} onChange={onFileChange} />
              </label>
          ) : (
            <DocumentViewer
              document={document}
              activePage={activePage}
              activeImageUrl={activeImageUrl}
              zoom={zoom}
              zoomMode={zoomMode}
              rotation={rotation}
              onPage={setActivePage}
              onZoom={setZoom}
              onZoomMode={setZoomMode}
              onRotation={setRotation}
            />
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
              schemaPreview={schemaPreview}
              schemaDownloadUrl={schemaDownloadUrl}
              schemaJsonInput={schemaJsonInput}
              savedSchema={schema}
              schemaDirty={schemaDirty}
              document={document}
              systemStatus={systemStatus}
              templates={templates}
              onSchemaName={(value) => {
                setSchemaName(value);
                setSchemaDirty(true);
              }}
              onSchemaDescription={(value) => {
                setSchemaDescription(value);
                setSchemaDirty(true);
              }}
              onSchemaJsonInput={setSchemaJsonInput}
              onImportSchemaJson={importSchemaJson}
              onUpdateField={updateField}
              onAddField={addField}
              onRemoveField={removeField}
              onSaveSchema={saveSchema}
              onRunExtraction={runExtraction}
              onRecommendSchema={recommendSchema}
              onSampleSchema={applySampleSchema}
              onLoadTemplate={(template) => {
                applySchema(template);
                setSchema(null);
                setSchemaDirty(true);
              }}
              onSaveTemplate={() => void markSchemaAsTemplate()}
              canExtract={Boolean(document)}
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
            onHistory={() => setHistoryOpen(true)}
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
        <UtilityModal title="Batch extraction" eyebrow="Run multiple files" onClose={() => setBatchOpen(false)}>
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
              setBatchMessage(null);
            }}
            onRunBatch={() => void runBatchUpload()}
            onSaveCurrentSchema={() => void saveCurrentSchemaForBatch()}
            onRefresh={() => void refreshBatches()}
            onOpenJob={(jobId) => {
              setBatchOpen(false);
              void loadJob(jobId);
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
          settingsMessage={settingsMessage}
          busy={busy}
          onVlmApiKey={setVlmApiKey}
          onVlmModelName={setVlmModelName}
          onLibreOfficePath={setLibreOfficePath}
          onSave={() => void saveVlmSettings()}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

function KieUtilityDock(props: { onArchive: () => void; onHistory: () => void; onBatch: () => void }) {
  return (
    <section className="utility-dock" aria-label="KIE utility actions">
      <button type="button" className="secondary" onClick={props.onHistory}>
        <History size={16} />
        Recent items
      </button>
      <button type="button" className="secondary" onClick={props.onArchive}>
        <FileJson size={16} />
        Search archive
      </button>
      <button type="button" className="secondary" onClick={props.onBatch}>
        <FileSpreadsheet size={16} />
        Batch extract
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

function SettingsDialog(props: {
  vlmSettings: VlmSettings | null;
  vlmApiKey: string;
  vlmModelName: string;
  libreOfficePath: string;
  settingsMessage: string | null;
  busy: string | null;
  onVlmApiKey: (value: string) => void;
  onVlmModelName: (value: string) => void;
  onLibreOfficePath: (value: string) => void;
  onSave: () => void;
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
          <button type="button" className="primary compact" disabled={Boolean(props.busy)} onClick={props.onSave}>
            <Save size={16} />
            Save
          </button>
          <button type="button" className="secondary compact" disabled={Boolean(props.busy)} onClick={props.onClose}>
            Close
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
  zoom: number;
  zoomMode: ZoomMode;
  rotation: number;
  onPage: (page: number) => void;
  onZoom: (zoom: number) => void;
  onZoomMode: (mode: ZoomMode) => void;
  onRotation: (rotation: number) => void;
}) {
  const imageClass = `document-image ${props.zoomMode}`;
  const imageStyle = {
    transform: `rotate(${props.rotation}deg) scale(${props.zoomMode === "manual" ? props.zoom : 1})`
  };

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
              <img src={`${API_BASE}${page.image_url}`} alt={`Page ${page.page}`} />
              <span>{page.page}</span>
            </button>
          ))}
        </div>
        <div className="image-stage">
          {props.activeImageUrl && (
            <img className={imageClass} src={props.activeImageUrl} alt={`Page ${props.activePage + 1}`} style={imageStyle} />
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
  onRefresh: () => void;
  onOpenJob: (jobId: string) => void;
}) {
  return (
    <section className="service-panel batch-panel">
      <div className="batch-create-panel">
        <div className="batch-intro">
          <strong>Create batch extraction</strong>
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
          Run batch extraction
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
                  <span>{Math.round(batch.progress * 100)}%</span>
                </div>
                <progress max={1} value={batch.progress} />
                <span className="muted">
                  {batch.completed_count} done · {batch.failed_count} failed · {batch.total_count} total
                </span>
                {batch.items.map((item) => (
                  <button key={item.id} onClick={() => props.onOpenJob(item.job_id)}>
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
  schemaPreview: string;
  schemaDownloadUrl: string;
  schemaJsonInput: string;
  savedSchema: SavedSchema | null;
  schemaDirty: boolean;
  document: UploadedDocument | null;
  systemStatus: SystemStatus | null;
  templates: SavedSchema[];
  onSchemaName: (value: string) => void;
  onSchemaDescription: (value: string) => void;
  onSchemaJsonInput: (value: string) => void;
  onImportSchemaJson: () => void;
  onUpdateField: (index: number, patch: Partial<FieldDefinition>) => void;
  onAddField: () => void;
  onRemoveField: (index: number) => void;
  onSaveSchema: () => Promise<SavedSchema | null>;
  onRunExtraction: () => Promise<void>;
  onRecommendSchema: () => Promise<void>;
  onSampleSchema: () => void;
  onLoadTemplate: (schema: SavedSchema) => void;
  onSaveTemplate: () => void;
  canExtract: boolean;
}) {
  const [toolsOpen, setToolsOpen] = useState(false);

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
        <label className="field-stack">
          <span>Schema name</span>
          <input value={props.schemaName} onChange={(event) => props.onSchemaName(event.target.value)} />
        </label>
        <label className="field-stack">
          <span>Schema description</span>
          <textarea value={props.schemaDescription} onChange={(event) => props.onSchemaDescription(event.target.value)} />
        </label>

        <div className="field-list">
          {props.fields.map((field, index) => (
            <div className="field-row" key={field.local_id}>
              <div className="field-grid">
                <label>
                  <span>key name</span>
                  <input value={field.key_name} onChange={(event) => props.onUpdateField(index, { key_name: event.target.value })} />
                </label>
                <label>
                  <span>description</span>
                  <input
                    value={field.description}
                    placeholder="Where and how the value should be found"
                    onChange={(event) => props.onUpdateField(index, { description: event.target.value })}
                  />
                </label>
                <label>
                  <span>output format</span>
                  <select
                    value={field.output_format}
                    onChange={(event) => props.onUpdateField(index, { output_format: event.target.value as OutputFormat })}
                  >
                    {OUTPUT_FORMATS.map((format) => (
                      <option key={format} value={format}>
                        {format}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="ghost danger icon-only" title="Remove field" onClick={() => props.onRemoveField(index)}>
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
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
  const label = status.is_mock ? "Mock mode" : "OpenAI mode";
  const detail = status.vlm_model_name || (status.has_vlm_credentials ? "model ready" : "missing model");
  return (
    <span className={`provider-pill ${status.is_mock ? "mock" : status.has_vlm_credentials ? "ready" : "warning"}`}>
      {label} · {detail}
    </span>
  );
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, options);
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

function validateFields(fields: FieldDefinition[]) {
  if (!fields.length) return "Add at least one schema field.";
  const keys = fields.map((field) => field.key_name.trim());
  if (keys.some((key) => !key)) return "Every field needs a key name.";
  if (fields.some((field) => !field.description.trim())) return "Every field needs a description.";
  if (fields.some((field) => !OUTPUT_FORMATS.includes(field.output_format))) return "Every field needs a supported output format.";
  if (new Set(keys).size !== keys.length) return "Field key names must be unique.";
  return null;
}

function hasMeaningfulSchema(fields: SchemaField[]) {
  return fields.some((field) => field.key_name.trim() || field.description.trim());
}

function exportHref(resultId: string, format: "json" | "csv", presetId: string) {
  const params = new URLSearchParams({ format });
  if (presetId) params.set("preset_id", presetId);
  return `${API_BASE}/api/extraction-results/${resultId}/export?${params.toString()}`;
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
  return {
    key_name: field.key_name,
    description: field.description,
    output_format: field.output_format
  };
}

function toSchemaFields(items: FieldDefinition[]): SchemaField[] {
  return items.map((field, index) => ({
    ...field,
    local_id: `${createLocalId()}_${index}`
  }));
}

function createLocalId(): string {
  if ("randomUUID" in crypto) return crypto.randomUUID();
  return `field_${Date.now()}_${Math.random().toString(16).slice(2)}`;
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
  if (message.includes("Only openai or mock")) {
    return "Unsupported VLM_PROVIDER. Use openai for real extraction or mock for local demo mode.";
  }
  return message;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

function fileDisplayName(file: File) {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

function formatConfidence(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return `${Math.round(value * 100)}%`;
}
