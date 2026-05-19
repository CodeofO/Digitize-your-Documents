import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
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
import Sparkles from "lucide-react/dist/esm/icons/sparkles.js";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.js";
import UploadCloud from "lucide-react/dist/esm/icons/upload-cloud.js";
import ZoomIn from "lucide-react/dist/esm/icons/zoom-in.js";
import ZoomOut from "lucide-react/dist/esm/icons/zoom-out.js";
import { ChangeEvent, DragEvent, PointerEvent, useEffect, useMemo, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";
const OUTPUT_FORMATS = ["string", "float", "date", "bool"] as const;
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
type Step = "upload" | "schema" | "review";
type ReviewFilter = "all" | "warning" | "null" | "changed";
type HistoryTab = "documents" | "schemas" | "jobs";
type ZoomMode = "manual" | "fitWidth" | "fitPage";

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
  fields: FieldDefinition[];
  created_at: string;
  updated_at: string;
};

type SchemaRecommendation = {
  name: string;
  display_name: string | null;
  description: string | null;
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

const initialFields: SchemaField[] = [
  {
    local_id: "field_1",
    key_name: "",
    description: "",
    output_format: "string"
  }
];

export default function App() {
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
  const [leftPanePercent, setLeftPanePercent] = useState(62);
  const [recentDocuments, setRecentDocuments] = useState<UploadedDocument[]>([]);
  const [recentSchemas, setRecentSchemas] = useState<SavedSchema[]>([]);
  const [recentJobs, setRecentJobs] = useState<ExtractionJob[]>([]);
  const [historyTab, setHistoryTab] = useState<HistoryTab>("documents");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshHistory();
  }, []);

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

  const result = job?.result ?? null;
  const currentValues = Object.keys(edits).length ? edits : result?.corrected_output?.values ?? result?.validated_output.values ?? {};

  async function loadHistory() {
    const [documents, schemas, jobs] = await Promise.all([
      api<UploadedDocument[]>("/api/documents?limit=12"),
      api<SavedSchema[]>("/api/schemas"),
      api<ExtractionJob[]>("/api/extraction-jobs?limit=12")
    ]);
    setRecentDocuments(documents);
    setRecentSchemas(schemas.slice(0, 12));
    setRecentJobs(jobs);
    return { documents, schemas, jobs };
  }

  async function refreshHistory() {
    try {
      await loadHistory();
    } catch {
      // History should not block the primary workflow.
    }
  }

  async function refreshWorkspace() {
    setBusy("Refreshing workspace");
    setError(null);
    try {
      await loadHistory();

      if (document) {
        const refreshedDocument = await api<UploadedDocument>(`/api/documents/${document.document_id}`);
        setDocument(refreshedDocument);
        setActivePage((current) => Math.min(Math.max(0, current), Math.max(0, refreshedDocument.page_count - 1)));
      }

      if (schema && !schemaDirty) {
        const refreshedSchema = await api<SavedSchema>(`/api/schemas/${schema.id}`);
        applySchema(refreshedSchema);
      }

      if (job) {
        const refreshedJob = await api<ExtractionJob>(`/api/extraction-jobs/${job.job_id}`);
        setJob(refreshedJob);
        if (refreshedJob.result && editedKeys.length === 0) {
          setEdits(refreshedJob.result.corrected_output?.values ?? refreshedJob.result.validated_output.values);
        }
        if (refreshedJob.result && step !== "review") {
          setStep("review");
        }
        if (refreshedJob.status === "failed") {
          setError(refreshedJob.error_message || "Extraction failed.");
        }
      }
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setBusy(null);
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
      setSchema(null);
      setSchemaName(recommendation.name || "ai_recommended_schema");
      setSchemaDescription(recommendation.description ?? "");
      setFields(toSchemaFields(recommendation.fields));
      setSchemaDirty(true);
      setStep("schema");
    } catch (err) {
      setError(toFriendlyError(err));
    } finally {
      setBusy(null);
    }
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
        setReviewFilter("all");
        setStep("review");
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
        body: JSON.stringify({ corrected_output: correctedOutput })
      });
      setJob((current) => (current ? { ...current, result: updated } : current));
      setEdits(updated.corrected_output?.values ?? updated.validated_output.values);
      setEditedKeys([]);
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
      setStep("schema");
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
        setEditedKeys([]);
        setStep("review");
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
          <p className="eyebrow">Key Information Extractor</p>
          <h1>KIE MVP Workspace</h1>
        </div>
        <div className="status-strip">
          <StepPill label="Upload" active={step === "upload"} done={Boolean(document)} />
          <StepPill label="Schema" active={step === "schema"} done={Boolean(schema) && !schemaDirty} />
          <StepPill label="Review" active={step === "review"} done={Boolean(result)} />
          <button
            type="button"
            className="secondary compact"
            disabled={Boolean(busy)}
            onClick={() => void refreshWorkspace()}
            title="Refresh workspace and recent history"
          >
            <RefreshCw size={16} className={busy === "Refreshing workspace" ? "spin" : ""} />
            Refresh
          </button>
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

      <main
        className="workspace"
        style={{ gridTemplateColumns: `minmax(320px, ${leftPanePercent}%) 12px minmax(380px, 1fr)` }}
      >
        <section className="document-pane">
          {!document ? (
            <label className="upload-zone" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
              <UploadCloud size={32} />
              <strong>Upload a document</strong>
              <span>PDF, PNG, JPG, or JPEG</span>
              <input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={onFileChange} />
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
          <HistoryPanel
            activeTab={historyTab}
            documents={recentDocuments}
            schemas={recentSchemas}
            jobs={recentJobs}
            onTab={setHistoryTab}
            onLoadDocument={(id) => void loadDocument(id)}
            onLoadSchema={(id) => void loadSchema(id)}
            onLoadJob={(id) => void loadJob(id)}
          />

          {!document ? (
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
              canExtract={Boolean(document)}
            />
          ) : (
            <ReviewPanel
              fields={fields}
              result={result}
              values={currentValues}
              editedKeys={editedKeys}
              filter={reviewFilter}
              onFilter={setReviewFilter}
              onEdit={updateEdit}
              onSaveCorrections={saveCorrections}
              onGoToPage={goToPage}
            />
          )}
        </aside>
      </main>
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
  onTab: (tab: HistoryTab) => void;
  onLoadDocument: (id: string) => void;
  onLoadSchema: (id: string) => void;
  onLoadJob: (id: string) => void;
}) {
  return (
    <section className="history-panel">
      <div className="history-header">
        <div className="preview-title inline-title">
          <History size={16} />
          Recent
        </div>
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
      </div>
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
        <span>Supported: PDF, PNG, JPG, JPEG</span>
        <span>Schema fields: key name, description, output format</span>
        <span>Use VLM_PROVIDER=mock for demos without an API key</span>
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
  canExtract: boolean;
}) {
  return (
    <div className="schema-builder">
      <div className="pane-header">
        <div>
          <p className="eyebrow">Schema</p>
          <h2>Define extraction fields</h2>
        </div>
        {props.savedSchema && (
          <span className={`saved-badge ${props.schemaDirty ? "dirty" : ""}`}>
            {props.schemaDirty ? "Draft changes" : `Saved v${props.savedSchema.current_version}`}
          </span>
        )}
      </div>

      <div className="action-row">
        <button className="primary" onClick={() => void props.onRecommendSchema()}>
          <Sparkles size={16} />
          AI recommend schema
        </button>
        <button className="secondary" onClick={props.onSampleSchema}>
          <ClipboardList size={16} />
          Sample
        </button>
        <a className="secondary link-button" href={props.schemaDownloadUrl} download={`${props.schemaName || "schema"}.json`}>
          <FileDown size={16} />
          Export JSON
        </a>
      </div>

      <label className="field-stack">
        <span>Schema name</span>
        <input value={props.schemaName} onChange={(event) => props.onSchemaName(event.target.value)} />
      </label>
      <label className="field-stack">
        <span>Schema description</span>
        <textarea value={props.schemaDescription} onChange={(event) => props.onSchemaDescription(event.target.value)} />
      </label>

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

      <div className="preview-block">
        <div className="preview-title">
          <FileJson size={16} />
          JSON preview
        </div>
        <pre>{props.schemaPreview}</pre>
      </div>
    </div>
  );
}

function ReviewPanel(props: {
  fields: FieldDefinition[];
  result: ExtractionResult | null;
  values: Record<string, ExtractionValue>;
  editedKeys: string[];
  filter: ReviewFilter;
  onFilter: (filter: ReviewFilter) => void;
  onEdit: (key: string, value: string) => void;
  onSaveCorrections: () => Promise<void>;
  onGoToPage: (page: number | null) => void;
}) {
  if (!props.result) {
    return <div className="empty-state">No extraction result yet.</div>;
  }

  const visibleFields = props.fields.filter((field) => {
    const value = props.values[field.key_name];
    if (props.filter === "warning") return Boolean(value?.warnings?.length);
    if (props.filter === "null") return value?.value === null || value?.value === undefined || value?.value === "";
    if (props.filter === "changed") return props.editedKeys.includes(field.key_name);
    return true;
  });

  return (
    <div className="review-panel">
      <div className="pane-header">
        <div>
          <p className="eyebrow">Review</p>
          <h2>Extraction result</h2>
        </div>
        <span className={`status-badge ${props.result.validated_output.status}`}>{props.result.validated_output.status}</span>
      </div>

      <div className="filter-row">
        <Filter size={16} />
        {(["all", "warning", "null", "changed"] as ReviewFilter[]).map((filter) => (
          <button key={filter} className={props.filter === filter ? "active" : ""} onClick={() => props.onFilter(filter)}>
            {filter}
          </button>
        ))}
      </div>

      <div className="result-table">
        <div className="result-head">
          <span>key name</span>
          <span>value</span>
          <span>page</span>
          <span>confidence</span>
          <span>warnings</span>
        </div>
        {visibleFields.map((field) => {
          const value = props.values[field.key_name];
          return (
            <div className="result-row" key={field.key_name}>
              <span className="mono">
                {field.key_name}
                {props.editedKeys.includes(field.key_name) && <em>edited</em>}
              </span>
              <label>
                <input value={stringifyValue(value?.value)} onChange={(event) => props.onEdit(field.key_name, event.target.value)} />
                {value?.evidence && <small>{value.evidence}</small>}
              </label>
              <button className="ghost page-link" onClick={() => props.onGoToPage(value?.page ?? null)}>
                {value?.page ?? "-"}
              </button>
              <span>{formatConfidence(value?.confidence)}</span>
              <span className={value?.warnings?.length ? "warn-text" : "muted"}>
                {value?.warnings?.length ? value.warnings.join(", ") : "valid"}
              </span>
            </div>
          );
        })}
      </div>

      <div className="action-row">
        <button className="secondary" onClick={() => void props.onSaveCorrections()}>
          <Save size={16} />
          Save corrections
        </button>
        <a className="secondary link-button" href={`${API_BASE}/api/extraction-results/${props.result.id}/export?format=json`} target="_blank">
          <Download size={16} />
          JSON
        </a>
        <a className="secondary link-button" href={`${API_BASE}/api/extraction-results/${props.result.id}/export?format=csv`} target="_blank">
          <FileSpreadsheet size={16} />
          CSV
        </a>
      </div>

      <div className="preview-block">
        <div className="preview-title">Raw model output</div>
        <pre>{JSON.stringify(props.result.raw_model_output, null, 2)}</pre>
      </div>
    </div>
  );
}

function StepPill({ label, active, done }: { label: string; active: boolean; done: boolean }) {
  return <span className={`step-pill ${active ? "active" : ""} ${done ? "done" : ""}`}>{label}</span>;
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
    return "VLM credentials are missing. Set VLM_API_KEY and VLM_MODEL_NAME in the backend .env, or use VLM_PROVIDER=mock for a local demo.";
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

function formatConfidence(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return `${Math.round(value * 100)}%`;
}
