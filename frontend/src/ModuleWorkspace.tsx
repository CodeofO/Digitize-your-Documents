import {
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  FileJson,
  FileSpreadsheet,
  FileUp,
  GripVertical,
  Library,
  Loader2,
  PanelRight,
  Play,
  Plus,
  Sparkles,
  Trash2,
  UploadCloud,
  X
} from "lucide-react";
import { ChangeEvent, DragEvent, PointerEvent, useEffect, useState } from "react";
import { apiFetch } from "./apiClient";
import { API_BASE } from "./apiConfig";

const MODULE_FILE_ACCEPT = ".pdf,.png,.jpg,.jpeg,.docx,.pptx";
const MODULE_FILE_EXTENSIONS = new Set(["pdf", "png", "jpg", "jpeg", "docx", "pptx"]);

type ModuleKind = "classifier" | "required-checker";
type EvidenceType = "text_or_handwriting" | "checkbox" | "signature_or_stamp" | "visual_mark" | "other";

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
  page_count: number;
  pages: DocumentPage[];
};

type SchemaRegion = {
  id: string;
  name: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type ClassCandidate = {
  class_name: string;
  description: string;
  signals: string[];
};

type DocumentClassifier = {
  id: string;
  name: string;
  description: string | null;
  allow_unknown: boolean;
  archived: boolean;
  classes: ClassCandidate[];
  created_at: string;
  updated_at: string;
};

type RequiredFieldItem = {
  item_name: string;
  description: string;
  evidence_type: EvidenceType;
  required: boolean;
  region_id?: string | null;
};

type RequiredFieldChecklist = {
  id: string;
  name: string;
  description: string | null;
  archived: boolean;
  regions: SchemaRegion[];
  items: RequiredFieldItem[];
  created_at: string;
  updated_at: string;
};

type RequiredFieldChecklistRecommendation = {
  name: string;
  description: string | null;
  reasoning: string | null;
  regions: SchemaRegion[];
  items: RequiredFieldItem[];
};

type ModuleJob<T> = {
  job_id: string;
  document_id: string;
  status: string;
  error_message: string | null;
  result_id: string | null;
  result: T | null;
};

type ClassificationOutput = {
  document_id: string;
  classifier_id: string;
  status: "classified" | "unknown";
  class_name: string | null;
  confidence: number | null;
  reason: string;
  evidence: string[];
};

type ClassificationResult = {
  id: string;
  job_id: string;
  validated_output: ClassificationOutput;
  corrected_output: ClassificationOutput | null;
  reviewed: boolean;
};

type RequiredFieldOutputItem = {
  item_name: string;
  status: "present" | "missing" | "uncertain" | "not_applicable";
  required: boolean;
  evidence_type: EvidenceType;
  confidence: number | null;
  evidence: string | null;
  page: number | null;
};

type RequiredFieldOutput = {
  document_id: string;
  checklist_id: string;
  overall_status: "complete" | "incomplete" | "needs_review";
  items: RequiredFieldOutputItem[];
};

type RequiredFieldResult = {
  id: string;
  job_id: string;
  validated_output: RequiredFieldOutput;
  corrected_output: RequiredFieldOutput | null;
  reviewed: boolean;
};

type ModuleBatchItem = {
  id: string;
  document_id: string;
  job_id: string;
  filename: string;
  status: string;
  result_id: string | null;
  error_message: string | null;
  created_at: string;
};

type ModuleBatch = {
  id: string;
  classifier_id?: string;
  checklist_id?: string;
  status: string;
  total_count: number;
  completed_count: number;
  failed_count: number;
  canceled_count: number;
  progress: number;
  items: ModuleBatchItem[];
  created_at: string;
  completed_at: string | null;
};

type ModuleWorkspaceProps = {
  kind: ModuleKind;
  leftPanePercent: number;
  onResize: (event: PointerEvent<HTMLButtonElement>) => void;
};

const evidenceTypes: EvidenceType[] = ["text_or_handwriting", "checkbox", "signature_or_stamp", "visual_mark", "other"];
const evidenceTypeLabels: Record<EvidenceType, string> = {
  text_or_handwriting: "문자/손글씨",
  checkbox: "체크박스",
  signature_or_stamp: "서명/도장",
  visual_mark: "시각 표시",
  other: "기타"
};

export function ModuleWorkspace({ kind, leftPanePercent, onResize }: ModuleWorkspaceProps) {
  const isClassifier = kind === "classifier";
  const title = isClassifier ? "문서 분류" : "필수 항목 확인";
  const configLabel = isClassifier ? "분류 설정" : "체크리스트";
  const [classifiers, setClassifiers] = useState<DocumentClassifier[]>([]);
  const [checklists, setChecklists] = useState<RequiredFieldChecklist[]>([]);
  const [activeConfigId, setActiveConfigId] = useState<string | null>(null);
  const [classifierDraft, setClassifierDraft] = useState<DocumentClassifier>(() => defaultClassifier());
  const [checklistDraft, setChecklistDraft] = useState<RequiredFieldChecklist>(() => defaultChecklist());
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [document, setDocument] = useState<UploadedDocument | null>(null);
  const [activePage, setActivePage] = useState(0);
  const [showRegions, setShowRegions] = useState(true);
  const [classificationJob, setClassificationJob] = useState<ModuleJob<ClassificationResult> | null>(null);
  const [requiredJob, setRequiredJob] = useState<ModuleJob<RequiredFieldResult> | null>(null);
  const [batches, setBatches] = useState<ModuleBatch[]>([]);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [activeBatchItemId, setActiveBatchItemId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const activeBatch = activeBatchId ? batches.find((batch) => batch.id === activeBatchId) ?? null : null;
  const activeBatchItem = activeBatch?.items.find((item) => item.id === activeBatchItemId) ?? activeBatch?.items[0] ?? null;
  const activeImageUrl = document?.pages[activePage]?.image_url ? `${API_BASE}${document.pages[activePage].image_url}` : null;
  const selectedFile = selectedFiles[selectedFileIndex] ?? selectedFiles[0] ?? null;
  const regions = isClassifier ? [] : checklistDraft.regions;
  const currentJob = isClassifier ? classificationJob : requiredJob;
  const terminalBatch = activeBatch ? ["completed", "completed_with_errors", "failed", "canceled"].includes(activeBatch.status) : true;
  const selectedSummary = selectedFiles.length === 1 ? "단일 실행" : selectedFiles.length > 1 ? "배치 실행" : "파일 없음";
  const [selectedPreviewUrl, setSelectedPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    void refreshModule();
  }, [kind]);

  useEffect(() => {
    if (!activeBatchId || terminalBatch) return;
    const timer = window.setInterval(() => void refreshBatch(activeBatchId), 1200);
    return () => window.clearInterval(timer);
  }, [activeBatchId, terminalBatch, kind]);

  useEffect(() => {
    if (!activeBatchItem) return;
    void openBatchItem(activeBatchItem);
  }, [activeBatchItem?.id]);

  useEffect(() => {
    if (!selectedFile) {
      setSelectedPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(selectedFile);
    setSelectedPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedFile]);

  async function refreshModule() {
    setError(null);
    try {
      if (isClassifier) {
        const [configs, recentBatches] = await Promise.all([
          api<DocumentClassifier[]>("/api/document-classifiers"),
          api<ModuleBatch[]>("/api/classification-batches?limit=12")
        ]);
        setClassifiers(configs);
        setBatches(recentBatches);
        if (!activeConfigId && configs[0]) {
          loadClassifier(configs[0]);
        }
      } else {
        const [configs, recentBatches] = await Promise.all([
          api<RequiredFieldChecklist[]>("/api/required-field-checklists"),
          api<ModuleBatch[]>("/api/required-field-check-batches?limit=12")
        ]);
        setChecklists(configs);
        setBatches(recentBatches);
        if (!activeConfigId && configs[0]) {
          loadChecklist(configs[0]);
        }
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function loadClassifier(config: DocumentClassifier) {
    setActiveConfigId(config.id);
    setClassifierDraft(normalizeClassifier(config));
    setLibraryOpen(false);
  }

  function loadChecklist(config: RequiredFieldChecklist) {
    setActiveConfigId(config.id);
    setChecklistDraft(normalizeChecklist(config));
    setLibraryOpen(false);
  }

  function startNewConfig() {
    setError(null);
    setActiveConfigId(null);
    if (isClassifier) {
      setClassifierDraft(defaultClassifier());
    } else {
      setChecklistDraft(defaultChecklist());
    }
    setMessage(`새 ${configLabel} 초안을 만들었습니다.`);
  }

  async function saveActiveConfig() {
    if (isClassifier) {
      const payload = toClassifierPayload(classifierDraft);
      const path = activeConfigId ? `/api/document-classifiers/${activeConfigId}` : "/api/document-classifiers";
      const saved = await api<DocumentClassifier>(path, {
        method: activeConfigId ? "PATCH" : "POST",
        body: JSON.stringify(payload)
      });
      setClassifiers((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      setActiveConfigId(saved.id);
      setClassifierDraft(normalizeClassifier(saved));
      return saved.id;
    }
    const payload = toChecklistPayload(checklistDraft);
    const path = activeConfigId ? `/api/required-field-checklists/${activeConfigId}` : "/api/required-field-checklists";
    const saved = await api<RequiredFieldChecklist>(path, {
      method: activeConfigId ? "PATCH" : "POST",
      body: JSON.stringify(payload)
    });
    setChecklists((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
    setActiveConfigId(saved.id);
    setChecklistDraft(normalizeChecklist(saved));
    return saved.id;
  }

  async function deleteConfig(id: string) {
    try {
      if (isClassifier) {
        await api<DocumentClassifier>(`/api/document-classifiers/${id}`, { method: "DELETE" });
        setClassifiers((items) => items.filter((item) => item.id !== id));
        if (activeConfigId === id) startNewConfig();
      } else {
        await api<RequiredFieldChecklist>(`/api/required-field-checklists/${id}`, { method: "DELETE" });
        setChecklists((items) => items.filter((item) => item.id !== id));
        if (activeConfigId === id) startNewConfig();
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function run() {
    if (!selectedFiles.length && !document) {
      setError("실행할 파일을 업로드하세요.");
      return;
    }
    setBusy(selectedFiles.length > 1 ? "배치 작업을 생성하는 중" : "문서를 처리하는 중");
    setError(null);
    setMessage(null);
    try {
      const configId = await saveActiveConfig();
      if (selectedFiles.length > 1) {
        await runBatch(configId);
      } else {
        const sourceDocument = selectedFiles[0] ? await uploadDocument(selectedFiles[0]) : document;
        if (!sourceDocument) throw new Error("실행할 문서가 없습니다.");
        setDocument(sourceDocument);
        setActivePage(0);
        await runSingle(configId, sourceDocument.document_id);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function runSingle(configId: string, documentId: string) {
    if (isClassifier) {
      const created = await api<ModuleJob<ClassificationResult>>("/api/classification-jobs", {
        method: "POST",
        body: JSON.stringify({ document_id: documentId, classifier_id: configId })
      });
      setClassificationJob(created);
      const done = await pollJob<ClassificationResult>(`/api/classification-jobs/${created.job_id}`);
      setClassificationJob(done);
      setMessage("분류 결과가 생성되었습니다.");
    } else {
      const created = await api<ModuleJob<RequiredFieldResult>>("/api/required-field-check-jobs", {
        method: "POST",
        body: JSON.stringify({ document_id: documentId, checklist_id: configId })
      });
      setRequiredJob(created);
      const done = await pollJob<RequiredFieldResult>(`/api/required-field-check-jobs/${created.job_id}`);
      setRequiredJob(done);
      setMessage("필수 항목 확인 결과가 생성되었습니다.");
    }
  }

  async function runBatch(configId: string) {
    const form = new FormData();
    form.append(isClassifier ? "classifier_id" : "checklist_id", configId);
    selectedFiles.forEach((file) => form.append("files", file));
    const path = isClassifier ? "/api/classification-batches" : "/api/required-field-check-batches";
    const batch = await api<ModuleBatch>(path, { method: "POST", body: form });
    setBatches((items) => [batch, ...items.filter((item) => item.id !== batch.id)].slice(0, 12));
    setActiveBatchId(batch.id);
    setActiveBatchItemId(batch.items[0]?.id ?? null);
    setSelectedFiles([]);
    setSelectedFileIndex(0);
    setMessage(`${batch.total_count}개 파일의 배치 작업을 시작했습니다.`);
    if (batch.items[0]) await openBatchItem(batch.items[0]);
  }

  async function refreshBatch(batchId: string) {
    try {
      const path = isClassifier ? `/api/classification-batches/${batchId}` : `/api/required-field-check-batches/${batchId}`;
      const batch = await api<ModuleBatch>(path);
      setBatches((items) => [batch, ...items.filter((item) => item.id !== batch.id)].slice(0, 12));
    } catch {
      // Keep the current batch visible; the next polling tick will retry.
    }
  }

  async function cancelBatch(batchId: string) {
    try {
      const path = isClassifier ? `/api/classification-batches/${batchId}/cancel` : `/api/required-field-check-batches/${batchId}/cancel`;
      const batch = await api<ModuleBatch>(path, { method: "POST" });
      setBatches((items) => items.map((item) => (item.id === batch.id ? batch : item)));
      setMessage("배치 중단을 요청했습니다.");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function recommendChecklist() {
    if (!document) {
      setError("AI 추천을 사용하려면 먼저 문서를 업로드하세요.");
      return;
    }
    setBusy("AI 체크리스트 추천 중");
    setError(null);
    setMessage(null);
    try {
      const recommendation = await api<RequiredFieldChecklistRecommendation>("/api/required-field-checklists/recommendations", {
        method: "POST",
        body: JSON.stringify({ document_id: document.document_id })
      });
      setActiveConfigId(null);
      setChecklistDraft(
        normalizeChecklist({
          id: "",
          name: recommendation.name || "ai_recommended_checklist",
          description: recommendation.description,
          archived: false,
          regions: recommendation.regions,
          items: recommendation.items,
          created_at: "",
          updated_at: ""
        })
      );
      setShowRegions(Boolean(recommendation.regions.length));
      setMessage(recommendation.reasoning || "AI 추천 체크리스트를 적용했습니다. 검토 후 저장하세요.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function openBatchItem(item: ModuleBatchItem) {
    try {
      const [doc, loadedJob] = await Promise.all([
        api<UploadedDocument>(`/api/documents/${item.document_id}`),
        isClassifier
          ? api<ModuleJob<ClassificationResult>>(`/api/classification-jobs/${item.job_id}`)
          : api<ModuleJob<RequiredFieldResult>>(`/api/required-field-check-jobs/${item.job_id}`)
      ]);
      setDocument(doc);
      setActivePage(0);
      setActiveBatchItemId(item.id);
      if (isClassifier) {
        setClassificationJob(loadedJob as ModuleJob<ClassificationResult>);
      } else {
        setRequiredJob(loadedJob as ModuleJob<RequiredFieldResult>);
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function selectFiles(files: FileList | File[] | null) {
    const incoming = Array.from(files ?? []);
    const supported = incoming
      .filter((file) => MODULE_FILE_EXTENSIONS.has(file.name.split(".").pop()?.toLowerCase() ?? ""))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    setSelectedFiles(supported);
    setSelectedFileIndex(0);
    setMessage(supported.length ? `${supported.length}개 파일 선택됨 · ${supported.length === 1 ? "단일 실행" : "배치 실행"}` : null);
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    selectFiles(event.dataTransfer.files);
  }

  async function saveClassificationCorrection(nextOutput: ClassificationOutput) {
    if (!classificationJob?.result_id) return;
    const result = await api<ClassificationResult>(`/api/classification-results/${classificationJob.result_id}`, {
      method: "PATCH",
      body: JSON.stringify({ corrected_output: nextOutput, reviewed: true })
    });
    setClassificationJob({ ...classificationJob, result });
  }

  async function saveRequiredCorrection(nextOutput: RequiredFieldOutput) {
    if (!requiredJob?.result_id) return;
    const result = await api<RequiredFieldResult>(`/api/required-field-check-results/${requiredJob.result_id}`, {
      method: "PATCH",
      body: JSON.stringify({ corrected_output: nextOutput, reviewed: true })
    });
    setRequiredJob({ ...requiredJob, result });
  }

  return (
    <main className={libraryOpen ? "module-shell library-open" : "module-shell"}>
      <div
        className="module-main-grid resize-scope"
        style={{ "--left-pane-percent": `${leftPanePercent}%` } as React.CSSProperties}
      >
        <section className="document-pane module-document-pane">
          <ModuleUploadHeader
            title={document?.filename ?? selectedFile?.name ?? title}
            selectedSummary={selectedSummary}
            selectedCount={selectedFiles.length}
            onRun={() => void run()}
            runDisabled={Boolean(busy) || (!selectedFiles.length && !document)}
            onClear={() => {
              setSelectedFiles([]);
              setDocument(null);
              setClassificationJob(null);
              setRequiredJob(null);
              setActiveBatchId(null);
              setActiveBatchItemId(null);
            }}
          />
          {activeBatch ? (
            <div className="module-document-with-rail">
              <ModuleBatchRail
                batch={activeBatch}
                activeItemId={activeBatchItemId}
                onOpen={(item) => void openBatchItem(item)}
                onCancel={() => void cancelBatch(activeBatch.id)}
                onExport={(format) => openModuleBatchExport(kind, activeBatch.id, format)}
              />
              <ModuleDocumentPreview document={document} activePage={activePage} activeImageUrl={activeImageUrl} regions={regions} showRegions={showRegions} onPage={setActivePage} />
            </div>
          ) : document ? (
            <ModuleDocumentPreview document={document} activePage={activePage} activeImageUrl={activeImageUrl} regions={regions} showRegions={showRegions} onPage={setActivePage} />
          ) : (
            <ModuleUploadDropzone
              selectedFiles={selectedFiles}
              selectedFile={selectedFile}
              selectedFileIndex={selectedFileIndex}
              selectedPreviewUrl={selectedPreviewUrl}
              selectedSummary={selectedSummary}
              onSelectFiles={selectFiles}
              onSelectIndex={setSelectedFileIndex}
              onDrop={onDrop}
            />
          )}
        </section>
        <button className="splitter" type="button" title="영역 너비 조절" aria-label="영역 너비 조절" onPointerDown={onResize}>
          <GripVertical size={18} />
        </button>
        <aside className="side-pane module-side-pane">
          <section className="module-card module-config-card">
            <div className="module-card-header">
              <div>
                <p className="eyebrow">{configLabel}</p>
                <h2>{isClassifier ? classifierDraft.name : checklistDraft.name}</h2>
              </div>
              <div className="module-card-actions">
                <button type="button" className="secondary compact" onClick={() => setLibraryOpen((open) => !open)}>
                  <Library size={16} />
                  설정 목록
                </button>
                {!isClassifier && (
                  <button
                    type="button"
                    className="primary compact"
                    disabled={Boolean(busy) || !document}
                    title={document ? "현재 문서 이미지로 필수 항목 체크리스트를 추천합니다." : "문서를 먼저 업로드해야 AI 추천을 사용할 수 있습니다."}
                    onClick={() => void recommendChecklist()}
                  >
                    <Sparkles size={15} />
                    AI 추천
                  </button>
                )}
              </div>
            </div>
            {isClassifier ? (
              <ClassifierConfigEditor draft={classifierDraft} onDraft={setClassifierDraft} />
            ) : (
              <RequiredChecklistEditor draft={checklistDraft} onDraft={setChecklistDraft} showRegions={showRegions} onShowRegions={setShowRegions} />
            )}
            <div className="action-row module-config-actions">
              <button type="button" className="secondary" onClick={() => void saveActiveConfig()}>
                저장
              </button>
              <button type="button" className="primary" disabled={Boolean(busy) || (!selectedFiles.length && !document)} onClick={() => void run()}>
                <Play size={16} />
                {selectedFiles.length > 1 ? "배치 실행" : "실행"}
              </button>
            </div>
          </section>

          {(busy || message || error) && (
            <section className="module-status-card">
              {busy && (
                <span>
                  <Loader2 size={15} className="spin" />
                  {busy}
                </span>
              )}
              {message && <span className="module-success">{message}</span>}
              {error && <span className="module-error">{error}</span>}
            </section>
          )}

          <section className="module-card">
            <div className="module-card-header">
              <div>
                <p className="eyebrow">결과</p>
                <h2>{moduleStatusLabel(currentJob?.status)}</h2>
              </div>
              {activeBatch && <span className="module-progress">{Math.round(activeBatch.progress * 100)}%</span>}
            </div>
            {isClassifier ? (
              <ClassificationResultPanel
                job={classificationJob}
                classes={classifierDraft.classes}
                onSave={(output) => void saveClassificationCorrection(output)}
              />
            ) : (
              <RequiredFieldResultPanel job={requiredJob} onSave={(output) => void saveRequiredCorrection(output)} />
            )}
          </section>
        </aside>
      </div>
      {libraryOpen && (
        <ModuleLibraryPanel
          kind={kind}
          configs={isClassifier ? classifiers : checklists}
          activeId={activeConfigId}
          draftName={isClassifier ? classifierDraft.name : checklistDraft.name}
          isDraftActive={!activeConfigId}
          onNew={startNewConfig}
          onLoad={(config) => {
            if (isClassifier) loadClassifier(config as DocumentClassifier);
            else loadChecklist(config as RequiredFieldChecklist);
          }}
          onDelete={(id) => void deleteConfig(id)}
          onClose={() => setLibraryOpen(false)}
        />
      )}
    </main>
  );
}

function ModuleUploadHeader(props: {
  title: string;
  selectedSummary: string;
  selectedCount: number;
  runDisabled: boolean;
  onRun: () => void;
  onClear: () => void;
}) {
  return (
    <div className="pane-header">
      <div>
        <p className="eyebrow">문서</p>
        <h2>{props.title}</h2>
        <small>{props.selectedCount ? `${props.selectedCount}개 선택됨 · ${props.selectedSummary}` : "파일 1개는 단일 실행, 2개 이상은 배치 실행"}</small>
      </div>
      <div className="toolbar">
        <button type="button" className="primary" disabled={props.runDisabled} onClick={props.onRun}>
          <Play size={16} />
          실행
        </button>
        <button type="button" onClick={props.onClear}>
          <X size={16} />
          비우기
        </button>
      </div>
    </div>
  );
}

function ModuleUploadDropzone(props: {
  selectedFiles: File[];
  selectedFile: File | null;
  selectedFileIndex: number;
  selectedPreviewUrl: string | null;
  selectedSummary: string;
  onSelectFiles: (files: FileList | File[] | null) => void;
  onSelectIndex: (index: number) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}) {
  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    props.onSelectFiles(event.target.files);
    event.currentTarget.value = "";
  }
  return (
    <div className="module-upload-zone" onDragOver={(event) => event.preventDefault()} onDrop={props.onDrop}>
      {props.selectedFiles.length ? (
        <div className="module-draft-layout">
          <aside className="module-selected-list">
            <div className="module-selected-summary">
              <strong>{props.selectedFiles.length}개 파일</strong>
              <span>{props.selectedSummary}</span>
            </div>
            {props.selectedFiles.map((file, index) => (
              <button key={`${file.name}_${index}`} className={index === props.selectedFileIndex ? "active" : ""} onClick={() => props.onSelectIndex(index)}>
                <span>{file.name}</span>
                <small>{formatBytes(file.size)}</small>
              </button>
            ))}
          </aside>
          <ModuleDraftPreview file={props.selectedFile} previewUrl={props.selectedPreviewUrl} />
        </div>
      ) : (
        <>
          <SampleUploadPreview />
          <div className="sample-upload-cta">
            <UploadCloud size={34} />
            <strong>파일 또는 폴더를 업로드하세요</strong>
            <span>PDF, 이미지, DOCX, PPTX · 자동으로 단일/배치를 판단합니다.</span>
          </div>
          <div className="module-upload-actions">
            <label className="batch-upload">
              <FileUp size={16} />
              <span>파일 선택</span>
              <input type="file" accept={MODULE_FILE_ACCEPT} multiple onChange={onFileChange} />
            </label>
            <label className="batch-upload">
              <UploadCloud size={16} />
              <span>폴더 선택</span>
              <input type="file" accept={MODULE_FILE_ACCEPT} multiple onChange={onFileChange} {...{ webkitdirectory: "", directory: "" }} />
            </label>
          </div>
        </>
      )}
    </div>
  );
}

function SampleUploadPreview() {
  return (
    <div className="sample-upload-preview" aria-label="샘플 문서 미리보기">
      <img src="/sample/bank_00070.jpg" alt="샘플 신청서 문서" />
      <div>
        <span>샘플 문서</span>
        <strong>bank_00070.jpg</strong>
      </div>
    </div>
  );
}

function ModuleDraftPreview(props: { file: File | null; previewUrl: string | null }) {
  if (!props.file || !props.previewUrl) {
    return <div className="module-draft-preview empty">선택한 파일의 preview가 여기에 표시됩니다.</div>;
  }
  const extension = props.file.name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg"].includes(extension)) {
    return (
      <div className="module-draft-preview">
        <img src={props.previewUrl} alt={props.file.name} />
      </div>
    );
  }
  if (extension === "pdf") {
    return (
      <div className="module-draft-preview">
        <iframe src={props.previewUrl} title={props.file.name} />
      </div>
    );
  }
  return (
    <div className="module-draft-preview office-file">
      <FileUp size={34} />
      <strong>{props.file.name}</strong>
      <span>{extension.toUpperCase()} 파일은 실행 시 backend에서 PDF preview로 변환됩니다.</span>
    </div>
  );
}

function ModuleDocumentPreview(props: {
  document: UploadedDocument | null;
  activePage: number;
  activeImageUrl: string | null;
  regions: SchemaRegion[];
  showRegions: boolean;
  onPage: (page: number) => void;
}) {
  if (!props.document) {
    return <div className="module-empty-preview">문서를 업로드하면 preview가 표시됩니다.</div>;
  }
  const document = props.document;
  const activePageNumber = document.pages[props.activePage]?.page ?? props.activePage + 1;
  const visibleRegions = props.regions.filter((region) => region.page === activePageNumber);
  return (
    <div className="module-preview">
      <div className="module-preview-toolbar">
        <button type="button" onClick={() => props.onPage(Math.max(0, props.activePage - 1))}>
          <ChevronLeft size={16} />
        </button>
        <span>{props.activePage + 1} / {document.page_count}</span>
        <button type="button" onClick={() => props.onPage(Math.min(document.page_count - 1, props.activePage + 1))}>
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="module-preview-stage">
        <div className="module-preview-image-wrap">
          {props.activeImageUrl && <img src={props.activeImageUrl} alt={`${props.activePage + 1}페이지`} />}
          {props.showRegions && visibleRegions.length > 0 && (
            <div className="document-region-layer">
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
      </div>
    </div>
  );
}

function ModuleBatchRail(props: {
  batch: ModuleBatch;
  activeItemId: string | null;
  onOpen: (item: ModuleBatchItem) => void;
  onCancel: () => void;
  onExport: (format: "csv" | "json") => void;
}) {
  return (
    <aside className="module-batch-rail">
      <div className="module-batch-head">
        <div>
          <p className="eyebrow">배치</p>
          <strong>{props.batch.completed_count + props.batch.failed_count + props.batch.canceled_count} / {props.batch.total_count}</strong>
        </div>
        <button type="button" className="secondary compact danger-outline" disabled={!batchCanCancel(props.batch)} onClick={props.onCancel}>
          중단
        </button>
      </div>
      <progress value={props.batch.progress} max={1} />
      <div className="module-batch-actions">
        <button type="button" className="secondary compact" onClick={() => props.onExport("csv")}>
          <FileSpreadsheet size={14} />
          CSV
        </button>
        <button type="button" className="secondary compact" onClick={() => props.onExport("json")}>
          <FileJson size={14} />
          JSON
        </button>
      </div>
      <div className="module-batch-list">
        {props.batch.items.map((item) => (
          <button key={item.id} className={item.id === props.activeItemId ? "active" : ""} onClick={() => props.onOpen(item)}>
            <span>{item.filename}</span>
            <small>{moduleStatusLabel(item.status)}</small>
          </button>
        ))}
      </div>
    </aside>
  );
}

function ClassifierConfigEditor(props: { draft: DocumentClassifier; onDraft: (draft: DocumentClassifier) => void }) {
  const draft = props.draft;
  function updateClass(index: number, patch: Partial<ClassCandidate>) {
    const classes = draft.classes.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item));
    props.onDraft({ ...draft, classes });
  }
  return (
    <div className="module-config-editor">
      <div className="module-form-grid">
        <label>
          <span>설정 이름</span>
          <input value={draft.name} onChange={(event) => props.onDraft({ ...draft, name: event.target.value })} />
        </label>
        <div className="module-toggle-row classifier-outcome-note">
          <span>결과 범위</span>
          <strong>사용자 정의 class 또는 unknown</strong>
        </div>
      </div>
      <label>
        <span>설명</span>
        <textarea value={draft.description ?? ""} onChange={(event) => props.onDraft({ ...draft, description: event.target.value })} />
      </label>
      <div className="module-section-title">
        <CheckSquare size={16} />
        <strong>문서 클래스</strong>
      </div>
      <div className="module-table-wrap">
        <table className="module-config-table classifier-table">
          <thead>
            <tr>
              <th>문서 클래스</th>
              <th>설명</th>
              <th>판단 신호</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {draft.classes.map((item, index) => (
              <tr key={index}>
                <td><input value={item.class_name} onChange={(event) => updateClass(index, { class_name: event.target.value })} /></td>
                <td><textarea value={item.description} onChange={(event) => updateClass(index, { description: event.target.value })} /></td>
                <td><textarea value={item.signals.join(", ")} onChange={(event) => updateClass(index, { signals: splitSignals(event.target.value) })} /></td>
                <td>
                  <button type="button" className="icon-only danger-plain" onClick={() => props.onDraft({ ...draft, classes: draft.classes.filter((_, itemIndex) => itemIndex !== index) })}>
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className="secondary" onClick={() => props.onDraft({ ...draft, classes: [...draft.classes, { class_name: "", description: "", signals: [] }] })}>
        <Plus size={16} />
        문서 클래스 추가
      </button>
    </div>
  );
}

function RequiredChecklistEditor(props: {
  draft: RequiredFieldChecklist;
  onDraft: (draft: RequiredFieldChecklist) => void;
  showRegions: boolean;
  onShowRegions: (show: boolean) => void;
}) {
  const draft = props.draft;
  function updateItem(index: number, patch: Partial<RequiredFieldItem>) {
    const items = draft.items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item));
    props.onDraft({ ...draft, items });
  }
  function updateRegion(index: number, patch: Partial<SchemaRegion>) {
    const regions = draft.regions.map((region, regionIndex) => (regionIndex === index ? { ...region, ...patch } : region));
    props.onDraft({ ...draft, regions });
  }
  return (
    <div className="module-config-editor">
      <div className="module-form-grid">
        <label>
          <span>설정 이름</span>
          <input value={draft.name} onChange={(event) => props.onDraft({ ...draft, name: event.target.value })} />
        </label>
        <label className="module-toggle-row">
          <span>영역 표시</span>
          <input type="checkbox" checked={props.showRegions} onChange={(event) => props.onShowRegions(event.target.checked)} />
        </label>
      </div>
      <label>
        <span>설명</span>
        <textarea value={draft.description ?? ""} onChange={(event) => props.onDraft({ ...draft, description: event.target.value })} />
      </label>
      <div className="module-section-title">
        <CheckSquare size={16} />
        <strong>필요 부분 체크</strong>
      </div>
      <div className="module-table-wrap">
        <table className="module-config-table checklist-table">
          <thead>
            <tr>
              <th>체크 항목</th>
              <th>설명</th>
              <th>증거 유형</th>
              <th>필수</th>
              <th>영역</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {draft.items.map((item, index) => (
              <tr key={index}>
                <td><input value={item.item_name} onChange={(event) => updateItem(index, { item_name: event.target.value })} /></td>
                <td><textarea value={item.description} onChange={(event) => updateItem(index, { description: event.target.value })} /></td>
                <td>
                  <select value={item.evidence_type} onChange={(event) => updateItem(index, { evidence_type: event.target.value as EvidenceType })}>
                    {evidenceTypes.map((type) => <option key={type} value={type}>{evidenceTypeLabels[type]}</option>)}
                  </select>
                </td>
                <td><input type="checkbox" checked={item.required} onChange={(event) => updateItem(index, { required: event.target.checked })} /></td>
                <td>
                  <select value={item.region_id ?? ""} onChange={(event) => updateItem(index, { region_id: event.target.value || null })}>
                    <option value="">-</option>
                    {draft.regions.map((region) => <option key={region.id} value={region.id}>{region.name}</option>)}
                  </select>
                </td>
                <td>
                  <button type="button" className="icon-only danger-plain" onClick={() => props.onDraft({ ...draft, items: draft.items.filter((_, itemIndex) => itemIndex !== index) })}>
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="action-row">
        <button type="button" className="secondary" onClick={() => props.onDraft({ ...draft, items: [...draft.items, { item_name: "", description: "", evidence_type: "text_or_handwriting", required: true, region_id: null }] })}>
          <Plus size={16} />
          체크 항목 추가
        </button>
        <button type="button" className="secondary" onClick={() => props.onDraft({ ...draft, regions: [...draft.regions, defaultRegion(draft.regions.length + 1)] })}>
          <PanelRight size={16} />
          영역 추가
        </button>
      </div>
      {draft.regions.length > 0 && (
        <div className="module-region-grid">
          {draft.regions.map((region, index) => (
            <div className="module-region-row" key={region.id}>
              <input value={region.name} onChange={(event) => updateRegion(index, { name: event.target.value })} />
              <input type="number" min={1} value={region.page} onChange={(event) => updateRegion(index, { page: Number(event.target.value) || 1 })} />
              {(["x", "y", "width", "height"] as const).map((key) => (
                <input key={key} type="number" min={0} max={1} step={0.01} value={region[key]} onChange={(event) => updateRegion(index, { [key]: Number(event.target.value) } as Partial<SchemaRegion>)} />
              ))}
              <button type="button" className="icon-only danger-plain" onClick={() => props.onDraft({ ...draft, regions: draft.regions.filter((_, regionIndex) => regionIndex !== index) })}>
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ClassificationResultPanel(props: {
  job: ModuleJob<ClassificationResult> | null;
  classes: ClassCandidate[];
  onSave: (output: ClassificationOutput) => void;
}) {
  const output = props.job?.result?.corrected_output ?? props.job?.result?.validated_output ?? null;
  if (!props.job) return <div className="module-empty-result">실행 후 결과가 표시됩니다.</div>;
  if (props.job.error_message) return <div className="module-error">{props.job.error_message}</div>;
  if (!output) return <div className="module-empty-result">{moduleStatusLabel(props.job.status)}</div>;
  return (
    <div className="module-result-stack">
      <div className="module-result-kpis">
        <span>{classificationStatusLabel(output.status)}</span>
        <strong>{output.class_name ?? "미분류"}</strong>
        <span>{formatConfidence(output.confidence)}</span>
      </div>
      <label>
        <span>사용자 수정</span>
        <select
          value={output.class_name ?? ""}
          onChange={(event) => props.onSave({ ...output, status: event.target.value ? "classified" : "unknown", class_name: event.target.value || null })}
        >
          <option value="">미분류</option>
          {props.classes.filter((item) => item.class_name.trim()).map((item) => <option key={item.class_name} value={item.class_name}>{item.class_name}</option>)}
        </select>
      </label>
      <div className="module-table-wrap">
        <table className="module-result-table classifier-result-table">
          <thead>
            <tr>
              <th>문서 클래스</th>
              <th>상태</th>
              <th>신뢰도</th>
              <th>판단 이유</th>
              <th>근거</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{output.class_name ?? "미분류"}</td>
              <td>{classificationStatusLabel(output.status)}</td>
              <td>{formatConfidence(output.confidence)}</td>
              <td>{output.reason}</td>
              <td>{output.evidence.join(", ")}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RequiredFieldResultPanel(props: {
  job: ModuleJob<RequiredFieldResult> | null;
  onSave: (output: RequiredFieldOutput) => void;
}) {
  const output = props.job?.result?.corrected_output ?? props.job?.result?.validated_output ?? null;
  if (!props.job) return <div className="module-empty-result">실행 후 결과가 표시됩니다.</div>;
  if (props.job.error_message) return <div className="module-error">{props.job.error_message}</div>;
  if (!output) return <div className="module-empty-result">{moduleStatusLabel(props.job.status)}</div>;
  function updateStatus(index: number, status: RequiredFieldOutputItem["status"]) {
    const items = output!.items.map((item, itemIndex) => (itemIndex === index ? { ...item, status } : item));
    const missing = items.some((item) => item.required && item.status === "missing");
    const uncertain = items.some((item) => item.required && item.status === "uncertain");
    props.onSave({ ...output!, items, overall_status: uncertain ? "needs_review" : missing ? "incomplete" : "complete" });
  }
  return (
    <div className="module-result-stack">
      <div className="module-result-kpis">
        <span>전체 상태</span>
        <strong>{requiredOverallStatusLabel(output.overall_status)}</strong>
      </div>
      <div className="module-table-wrap">
        <table className="module-result-table">
          <thead>
            <tr>
              <th>체크 항목</th>
              <th>상태</th>
              <th>근거</th>
              <th>페이지</th>
            </tr>
          </thead>
          <tbody>
            {output.items.map((item, index) => (
              <tr key={item.item_name}>
                <td>{item.item_name}</td>
                <td>
                  <select value={item.status} onChange={(event) => updateStatus(index, event.target.value as RequiredFieldOutputItem["status"])}>
                    <option value="present">있음</option>
                    <option value="missing">누락</option>
                    <option value="uncertain">확인 필요</option>
                    <option value="not_applicable">해당 없음</option>
                  </select>
                </td>
                <td>{item.evidence}</td>
                <td>{item.page ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ModuleLibraryPanel(props: {
  kind: ModuleKind;
  configs: Array<DocumentClassifier | RequiredFieldChecklist>;
  activeId: string | null;
  draftName: string;
  isDraftActive: boolean;
  onNew: () => void;
  onLoad: (config: DocumentClassifier | RequiredFieldChecklist) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <aside className="module-library-panel">
      <div className="module-library-header">
        <div>
          <p className="eyebrow">{props.kind === "classifier" ? "분류 설정 목록" : "체크리스트 목록"}</p>
          <h2>설정 관리</h2>
        </div>
        <button type="button" className="icon-only secondary" onClick={props.onClose}>
          <X size={16} />
        </button>
      </div>
      <button type="button" className="primary full-width" onClick={props.onNew}>
        <Plus size={16} />
        새 설정
      </button>
      <div className="module-library-list">
        {props.isDraftActive && (
          <div className="module-library-item module-library-draft active" aria-current="true">
            <div className="module-library-draft-body">
              <strong>{props.draftName || "새 설정 초안"}</strong>
              <span>저장 전 초안 · 편집 중</span>
            </div>
            <span className="module-library-draft-pill">초안</span>
          </div>
        )}
        {props.configs.map((config) => (
          <div key={config.id} className={config.id === props.activeId ? "module-library-item active" : "module-library-item"}>
            <button type="button" onClick={() => props.onLoad(config)}>
              <strong>{config.name}</strong>
              <span>{configSummary(config)}</span>
            </button>
            <button type="button" className="icon-only danger-plain" onClick={() => props.onDelete(config.id)}>
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, options);
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(formatApiDetail(detail?.detail) || response.statusText);
  }
  return response.json() as Promise<T>;
}

async function uploadDocument(file: File): Promise<UploadedDocument> {
  const form = new FormData();
  form.append("file", file);
  return api<UploadedDocument>("/api/documents", { method: "POST", body: form });
}

async function pollJob<T>(path: string): Promise<ModuleJob<T>> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const job = await api<ModuleJob<T>>(path);
    if (["completed", "needs_review", "failed", "canceled"].includes(job.status)) return job;
    await delay(1200);
  }
  return api<ModuleJob<T>>(path);
}

function openModuleBatchExport(kind: ModuleKind, batchId: string, format: "csv" | "json") {
  const path = kind === "classifier"
    ? `/api/classification-batches/${batchId}/export?format=${format}`
    : `/api/required-field-check-batches/${batchId}/export?format=${format}`;
  window.open(`${API_BASE}${path}`, "_blank", "noopener,noreferrer");
}

function defaultClassifier(): DocumentClassifier {
  return {
    id: "",
    name: "새 문서 분류기",
    description: "업로드 문서를 사용자가 정의한 후보 class 중 하나 또는 unknown으로 분류합니다.",
    allow_unknown: true,
    archived: false,
    classes: [
      { class_name: "계약서", description: "계약 조건, 당사자, 서명 또는 날인이 포함된 문서", signals: ["계약", "서명", "날인"] },
      { class_name: "신청서", description: "신청자 정보와 동의 체크 항목이 포함된 신청서", signals: ["신청", "동의", "작성일"] }
    ],
    created_at: "",
    updated_at: ""
  };
}

function defaultChecklist(): RequiredFieldChecklist {
  return {
    id: "",
    name: "새 필수 항목 체크리스트",
    description: "문서에서 필수 항목의 존재 여부만 확인합니다.",
    archived: false,
    regions: [],
    items: [
      { item_name: "성명", description: "작성자 또는 대상자의 성명이 문서에 존재하는지 확인합니다.", evidence_type: "text_or_handwriting", required: true },
      { item_name: "서명", description: "서명 또는 날인이 존재하는지 확인합니다.", evidence_type: "signature_or_stamp", required: true }
    ],
    created_at: "",
    updated_at: ""
  };
}

function normalizeClassifier(config: DocumentClassifier): DocumentClassifier {
  return { ...config, classes: config.classes.length ? config.classes : defaultClassifier().classes };
}

function normalizeChecklist(config: RequiredFieldChecklist): RequiredFieldChecklist {
  return { ...config, items: config.items.length ? config.items : defaultChecklist().items, regions: config.regions ?? [] };
}

function toClassifierPayload(config: DocumentClassifier) {
  const classes = config.classes
    .map((item) => ({
      class_name: item.class_name.trim(),
      description: item.description.trim(),
      signals: item.signals.map((signal) => signal.trim()).filter(Boolean)
    }))
    .filter((item) => item.class_name && item.description);
  if (!config.name.trim()) throw new Error("분류 설정 이름을 입력하세요.");
  if (!classes.length) throw new Error("문서 클래스를 최소 1개 이상 입력하세요.");
  return {
    name: config.name.trim(),
    description: config.description?.trim() || null,
    allow_unknown: true,
    classes
  };
}

function toChecklistPayload(config: RequiredFieldChecklist) {
  const items = config.items
    .map((item) => ({
      item_name: item.item_name.trim(),
      description: item.description.trim(),
      evidence_type: item.evidence_type,
      required: item.required,
      region_id: item.region_id || null
    }))
    .filter((item) => item.item_name && item.description);
  if (!config.name.trim()) throw new Error("체크리스트 이름을 입력하세요.");
  if (!items.length) throw new Error("체크 항목을 최소 1개 이상 입력하세요.");
  return {
    name: config.name.trim(),
    description: config.description?.trim() || null,
    regions: config.regions.map((region) => ({
      ...region,
      x: clamp01(region.x),
      y: clamp01(region.y),
      width: clamp01(region.width),
      height: clamp01(region.height)
    })),
    items
  };
}

function defaultRegion(index: number): SchemaRegion {
  return { id: `region_${Date.now()}_${index}`, name: `영역 ${index}`, page: 1, x: 0.55, y: 0.55, width: 0.35, height: 0.2 };
}

function splitSignals(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function documentPageThumbnailSrc(documentId: string, page: number, width: number) {
  return `${API_BASE}/api/documents/${documentId}/pages/${page}/thumbnail?width=${width}`;
}

function configSummary(config: DocumentClassifier | RequiredFieldChecklist) {
  if ("classes" in config) return `${config.classes.length}개 클래스 · ${new Date(config.updated_at).toLocaleDateString()}`;
  return `${config.items.length}개 항목 · ${config.regions.length}개 영역 · ${new Date(config.updated_at).toLocaleDateString()}`;
}

function batchCanCancel(batch: ModuleBatch) {
  return ["running", "cancel_requested", "canceling"].includes(batch.status);
}

function moduleStatusLabel(status: string | null | undefined) {
  const labels: Record<string, string> = {
    queued: "대기 중",
    running: "실행 중",
    completed: "완료",
    completed_with_errors: "일부 실패",
    failed: "실패",
    canceled: "취소됨",
    cancel_requested: "중단 요청됨",
    canceling: "중단 중",
    needs_review: "검토 필요"
  };
  return status ? labels[status] ?? status : "대기 중";
}

function classificationStatusLabel(status: ClassificationOutput["status"]) {
  const labels: Record<ClassificationOutput["status"], string> = {
    classified: "분류 완료",
    unknown: "unknown"
  };
  return labels[status];
}

function requiredOverallStatusLabel(status: RequiredFieldOutput["overall_status"]) {
  const labels: Record<RequiredFieldOutput["overall_status"], string> = {
    complete: "완료",
    incomplete: "누락 있음",
    needs_review: "검토 필요"
  };
  return labels[status];
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatConfidence(value: number | null) {
  if (value === null || Number.isNaN(value)) return "-";
  return `${Math.round(value * 100)}%`;
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatApiDetail(detail: unknown): string {
  if (!detail) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail.map(formatApiDetail).filter(Boolean).join(" · ");
  }
  if (typeof detail === "object") {
    const record = detail as Record<string, unknown>;
    if (typeof record.code === "string" && typeof record.message === "string") {
      const hint = typeof record.hint === "string" ? ` ${record.hint}` : "";
      return `${record.code}: ${record.message}${hint}`;
    }
    if (typeof record.msg === "string") return record.msg;
    if (typeof record.message === "string") return record.message;
    return JSON.stringify(record);
  }
  return String(detail);
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("VLM_CREDENTIALS_MISSING") || message.includes("VLM API key and model name are required")) {
    return "VLM 인증 정보가 없습니다. Home의 Setting에서 API key와 model name을 저장하거나, 로컬 데모에서는 VLM_PROVIDER=mock을 사용하세요.";
  }
  if (message.includes("VLM_PROVIDER_UNSUPPORTED") || message.includes("Unsupported VLM_PROVIDER")) {
    return "지원하지 않는 VLM_PROVIDER입니다. auto, mock, openai_compatible, google_genai 중 하나를 사용하세요.";
  }
  if (message.includes("VLM_PROVIDER_REQUEST_FAILED")) {
    return message.replace("VLM_PROVIDER_REQUEST_FAILED: ", "");
  }
  return message;
}
