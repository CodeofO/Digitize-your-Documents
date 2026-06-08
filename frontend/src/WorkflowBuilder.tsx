import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider
} from "@xyflow/react";
import type { Connection, Edge, EdgeChange, Node, NodeChange, NodeProps } from "@xyflow/react";
import {
  AlertTriangle,
  Braces,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  CheckSquare,
  ClipboardList,
  Download,
  FileInput,
  FileJson,
  FileSpreadsheet,
  GitBranch,
  GitMerge,
  GripVertical,
  History,
  Loader2,
  Maximize2,
  Minus,
  Pause,
  Play,
  Plus,
  RefreshCcw,
  Save,
  Sparkles,
  Trash2,
  Unlink2,
  UploadCloud,
  X
} from "lucide-react";
import { ChangeEvent, CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent, UIEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "./apiClient";
import { API_BASE } from "./apiConfig";
import { DocumentPickerButton, LibraryDocument, uploadLibraryFiles } from "./DocumentLibrary";
import { ExportJobHistory } from "./ExportJobHistory";
import { createAndDownloadExportJob } from "./exportJobs";

const WORKFLOW_FILE_ACCEPT = ".pdf,.png,.jpg,.jpeg,.docx,.pptx";
const WORKFLOW_RUN_ROW_HEIGHT = 64;
const WORKFLOW_RUN_OVERSCAN = 8;
const WORKFLOW_RUN_HISTORY_LIMIT = 50;
const WORKFLOW_UPLOAD_CONCURRENCY = 2;
const WORKFLOW_RESULT_LEFT_WIDTH_KEY = "digitize_workflow_result_left_width_v1";
const WORKFLOW_RESULT_RIGHT_WIDTH_KEY = "digitize_workflow_result_right_width_v1";
const WORKFLOW_RESULT_MIN_LEFT_WIDTH = 220;
const WORKFLOW_RESULT_MIN_MIDDLE_WIDTH = 420;
const WORKFLOW_RESULT_MIN_RIGHT_WIDTH = 300;
const WORKFLOW_RESULT_SPLITTER_WIDTH = 12;
const WORKFLOW_RUN_SIDEBAR_WIDTH_KEY = "digitize_workflow_run_sidebar_width_v1";
const WORKFLOW_RUN_SIDEBAR_DEFAULT_WIDTH = 420;
const WORKFLOW_RUN_SIDEBAR_MIN_WIDTH = 340;
const WORKFLOW_RUN_SIDEBAR_MAX_WIDTH = 520;
const WORKFLOW_FIT_VIEW_PADDING = 0.16;
const BANK_POC_TOUR_PENDING_KEY = "digitize_bank_poc_tour_pending_v1";
const BANK_POC_WORKFLOW_NAME = "은행 서류 자동 분류 및 검수";
const BANK_POC_COMPACT_NODE_POSITIONS: Record<string, { x: number; y: number }> = {
  input: { x: 40, y: 240 },
  classifier: { x: 250, y: 240 },
  branch: { x: 460, y: 210 },
  kie_application: { x: 670, y: 70 },
  required_application: { x: 900, y: 70 },
  required_consent: { x: 670, y: 240 },
  kie_supporting: { x: 670, y: 410 },
  merge: { x: 900, y: 300 },
  export: { x: 1110, y: 300 }
};
const BANK_POC_CANVAS_VIEWPORT = { x: 70, y: 70, zoom: 0.72 };
const BANK_POC_CANVAS_VIEWPORT_WITH_SIDEBAR = { x: 50, y: 100, zoom: 0.54 };
const WORKFLOW_AI_DRAFT_MAX_IMAGES = 10;
const WORKFLOW_AI_DRAFT_ACCEPT = ".png,.jpg,.jpeg";
const WORKFLOW_EVIDENCE_TYPES = ["text_or_handwriting", "checkbox", "signature_or_stamp", "visual_mark", "other"] as const;
const WORKFLOW_CUSTOM_EVIDENCE_TYPE_VALUE = "__custom_evidence_type__";
const WORKFLOW_EVIDENCE_TYPE_LABELS: Record<string, string> = {
  text_or_handwriting: "문자/손글씨",
  checkbox: "체크박스",
  signature_or_stamp: "서명/도장",
  visual_mark: "시각 표시",
  other: "기타"
};

type WorkflowNodeKind = "input" | "classifier" | "branch" | "kie" | "required-checker" | "merge" | "export";
type WorkflowResultFilter = "all" | "success" | "failed" | "waiting" | "running" | "review";
type ExportFormat = "csv" | "json" | "xlsx";
type WorkflowOutputFormat = "string" | "float" | "bool" | "date";
type DemoTourTarget = "canvas" | "palette" | "documents" | "run";
type WorkflowClassFilterOption = {
  value: string;
  label: string;
  count: number;
};
type WorkflowUploadSource = "files" | "folder";
type WorkflowNodeContextMenu = {
  left: number;
  top: number;
  flowPosition: { x: number; y: number };
};
type ReactFlowScreenProjector = {
  screenToFlowPosition: (position: { x: number; y: number }) => { x: number; y: number };
  fitView?: (options?: { padding?: number; duration?: number }) => void;
  setViewport?: (viewport: { x: number; y: number; zoom: number }, options?: { duration?: number }) => void;
};

type WorkflowNodeData = {
  kind: WorkflowNodeKind;
  label: string;
  config?: Record<string, string>;
  branchKeys?: string[];
  connectedBranchKeys?: string[];
  configSelect?: WorkflowNodeConfigSelect;
  onConfigChange?: (nodeId: string, key: string, value: string) => void;
  onSelect?: (event: ReactMouseEvent, nodeId: string) => void;
};

type WorkflowNode = Node<WorkflowNodeData>;
type WorkflowEdge = Edge;

type WorkflowNodeConfigSelect = {
  key: string;
  label: string;
  placeholder: string;
  value: string;
  options: { value: string; label: string }[];
};

type WorkflowSchemaRegion = {
  id: string;
  name: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type WorkflowSchemaField = {
  key_name: string;
  description: string;
  output_format: WorkflowOutputFormat;
  region_id?: string | null;
  judgement_enabled?: boolean;
};

type WorkflowSchemaDraft = {
  name: string;
  display_name?: string | null;
  description?: string | null;
  is_template?: boolean;
  template_category?: string | null;
  pinned?: boolean;
  regions?: WorkflowSchemaRegion[];
  fields: WorkflowSchemaField[];
};

type SchemaSummary = {
  id: string;
  name: string;
  display_name: string | null;
  description?: string | null;
  regions?: WorkflowSchemaRegion[];
  fields: WorkflowSchemaField[];
};

type WorkflowClassifierClass = {
  class_name: string;
  description: string;
  signals: string[];
};

type WorkflowClassifierDraft = {
  name: string;
  description?: string | null;
  allow_unknown: boolean;
  classes: WorkflowClassifierClass[];
};

type ClassifierSummary = {
  id: string;
  name: string;
  description?: string | null;
  allow_unknown?: boolean;
  classes: WorkflowClassifierClass[];
};

type ChecklistSummary = {
  id: string;
  name: string;
  description?: string | null;
  regions?: WorkflowSchemaRegion[];
  items: WorkflowChecklistItem[];
};

type WorkflowChecklistItem = {
  item_name: string;
  description: string;
  evidence_type: string;
  required: boolean;
  region_id?: string | null;
};

type WorkflowChecklistDraft = {
  name: string;
  description?: string | null;
  regions?: WorkflowSchemaRegion[];
  items: WorkflowChecklistItem[];
};

type WorkflowAiDraft = {
  workflow_name: string;
  schema_draft: WorkflowSchemaDraft;
  checklist_draft?: WorkflowChecklistDraft | null;
  definition: { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
  sample_count: number;
  images_persisted: boolean;
  reasoning?: string | null;
};

type WorkflowDefinition = {
  id: string;
  name: string;
  description: string | null;
  definition: { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
  validation_warnings: string[];
};

type BankPocSeed = {
  template_key: string;
  created: Record<string, boolean>;
  schema: SchemaSummary;
  classifier: ClassifierSummary;
  checklist: ChecklistSummary;
  workflow: WorkflowDefinition;
  sample_document: LibraryDocument | null;
  sample_documents?: LibraryDocument[];
};

type WorkflowRunItem = {
  id: string;
  document_id: string;
  filename: string;
  upload_index?: number | null;
  status: string;
  error_message: string | null;
  upload_duration_ms?: number | null;
  inference_duration_ms?: number | null;
  result: WorkflowItemResult;
};

type WorkflowDocumentPage = {
  id: string;
  page: number;
  image_url: string;
  width: number;
  height: number;
};

type WorkflowDocument = {
  document_id: string;
  filename: string;
  page_count: number;
  pages: WorkflowDocumentPage[];
};

type WorkflowRun = {
  id: string;
  workflow_id: string;
  workflow_name?: string | null;
  restarted_from_run_id?: string | null;
  workflow_run_group_id?: string | null;
  queued_from_run_id?: string | null;
  queue_order?: number | null;
  status: string;
  total_count: number;
  completed_count: number;
  failed_count: number;
  needs_review_count: number;
  uploaded_count?: number;
  preprocessing_count?: number;
  ready_count?: number;
  queued_count?: number;
  running_count?: number;
  canceled_count?: number;
  vlm_active_count?: number;
  vlm_waiting_count?: number;
  vlm_limit?: number;
  progress_phase?: string;
  progress: number;
  error_message: string | null;
  upload_duration_ms?: number | null;
  inference_duration_ms?: number | null;
  items: WorkflowRunItem[];
  created_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
};

type WorkflowItemResult = {
  classification?: { status?: string; class_name?: string | null; reason?: string };
  branch_path?: string | null;
  kie_values?: Record<string, { value?: unknown; evidence?: string; confidence?: number } | unknown>;
  required_overall_status?: string | null;
  required_items?: Record<string, { status?: string; evidence?: string | null; region_id?: string | null }>;
  node_results?: Record<string, unknown>;
  error_message?: string | null;
  current_node_id?: string | null;
  current_node_kind?: string | null;
  current_node_label?: string | null;
  completed_node_ids?: string[];
  path_node_ids?: string[];
};

type WorkflowBuilderProps = {
  uploadMaxBatchFiles: number;
  uploadChunkFiles: number;
  initialLibraryDocuments?: LibraryDocument[];
  onConsumeInitialLibraryDocuments?: () => void;
  initialWorkflowId?: string;
  onConsumeInitialWorkflowId?: () => void;
  onCreateSchema: () => void;
  onCreateClassifier: () => void;
  onCreateChecklist: () => void;
};

type WorkflowDraft = {
  activeWorkflowId: string;
  workflowName: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  selectedNodeId: string | null;
  classifierDraftsByNodeId?: Record<string, WorkflowClassifierDraft>;
  schemaDraftsByNodeId?: Record<string, WorkflowSchemaDraft>;
  checklistDraftsByNodeId?: Record<string, WorkflowChecklistDraft>;
};

const WORKFLOW_DRAFT_KEY = "digitize_workflow_builder_draft_v1";
const TERMINAL_RUN_STATUSES = ["completed", "completed_with_errors", "needs_review", "failed", "canceled"];
const UNKNOWN_BRANCH_KEY = "unknown";

const nodePalette: { kind: WorkflowNodeKind; label: string; description: string }[] = [
  { kind: "input", label: "문서 입력", description: "처리할 문서를 워크플로우에 전달합니다." },
  { kind: "classifier", label: "문서 분류", description: "결과는 정의한 class 또는 unknown입니다." },
  { kind: "branch", label: "분기", description: "분류 class별 경로를 나눕니다." },
  { kind: "kie", label: "핵심 정보 추출", description: "저장된 schema로 값을 추출합니다." },
  { kind: "required-checker", label: "필수 항목 확인", description: "저장된 checklist를 확인합니다." },
  { kind: "merge", label: "결과 병합", description: "실행된 branch 결과를 합칩니다." },
  { kind: "export", label: "Export", description: "통합 결과 파일을 만듭니다." }
];

const defaultNodes: WorkflowNode[] = [
  workflowNode("input", "문서 입력", 0, 150, {}, undefined, "input"),
  workflowNode("classifier", "문서 분류", 230, 150, {}, undefined, "classifier"),
  workflowNode("branch", "분기", 470, 150, {}, [UNKNOWN_BRANCH_KEY], "branch"),
  workflowNode("kie", "핵심 정보 추출", 730, 70, {}, undefined, "kie_contract"),
  workflowNode("required-checker", "필수 항목 확인", 970, 70, {}, undefined, "required_contract"),
  workflowNode("merge", "결과 병합", 1210, 150, {}, undefined, "merge"),
  workflowNode("export", "Export", 1450, 150, {}, undefined, "export")
];

const defaultEdges: WorkflowEdge[] = [
  workflowEdge("input", "classifier"),
  workflowEdge("classifier", "branch"),
  workflowEdge("branch", "kie_contract", UNKNOWN_BRANCH_KEY),
  workflowEdge("kie_contract", "required_contract"),
  workflowEdge("required_contract", "merge"),
  workflowEdge("merge", "export")
];

const bankPocTourSteps: Array<{ target: DemoTourTarget; title: string; body: string }> = [
  {
    target: "canvas",
    title: "데모 워크플로우가 준비됐습니다",
    body: "은행 서류용 분류, KIE, 필수 항목 확인, export 흐름을 캔버스에서 바로 확인하고 노드를 선택해 설정을 바꿀 수 있습니다."
  },
  {
    target: "palette",
    title: "필요한 기능을 추가하세요",
    body: "왼쪽 모듈을 눌러 분류기, KIE, 체크리스트 같은 단계를 더하고 기존 노드와 연결할 수 있습니다."
  },
  {
    target: "documents",
    title: "샘플 문서 3장이 선택됐습니다",
    body: "assets/sample의 로컬 샘플을 보관함 문서로 등록했습니다. 다른 문서로 바꾸려면 보관함 버튼에서 다시 선택하세요."
  },
  {
    target: "run",
    title: "실행 버튼으로 결과를 확인하세요",
    body: "설정이 맞으면 실행을 눌러 분류, 추출, 필수 항목 확인 결과를 한 번에 만들 수 있습니다."
  }
];

const nodeTypes = {
  workflow: WorkflowCanvasNode
};

export function WorkflowBuilder({
  uploadMaxBatchFiles,
  uploadChunkFiles,
  initialLibraryDocuments = [],
  onConsumeInitialLibraryDocuments,
  initialWorkflowId = "",
  onConsumeInitialWorkflowId,
  onCreateSchema,
  onCreateClassifier,
  onCreateChecklist
}: WorkflowBuilderProps) {
  const [initialDraft] = useState<WorkflowDraft | null>(() => readWorkflowDraft());
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [activeWorkflowId, setActiveWorkflowId] = useState(initialDraft?.activeWorkflowId ?? "");
  const [workflowName, setWorkflowName] = useState(initialDraft?.workflowName ?? "문서 자동화 워크플로우");
  const [nodes, setNodes] = useState<WorkflowNode[]>(() => initialDraft?.nodes ?? defaultNodes);
  const [edges, setEdges] = useState<WorkflowEdge[]>(() => normalizeWorkflowEdges(initialDraft?.edges ?? defaultEdges));
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(initialDraft?.selectedNodeId ?? defaultNodes[1]?.id ?? null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [schemas, setSchemas] = useState<SchemaSummary[]>([]);
  const [classifiers, setClassifiers] = useState<ClassifierSummary[]>([]);
  const [checklists, setChecklists] = useState<ChecklistSummary[]>([]);
  const [classifierDraftsByNodeId, setClassifierDraftsByNodeId] = useState<Record<string, WorkflowClassifierDraft>>(
    () => initialDraft?.classifierDraftsByNodeId ?? {}
  );
  const [schemaDraftsByNodeId, setSchemaDraftsByNodeId] = useState<Record<string, WorkflowSchemaDraft>>(
    () => initialDraft?.schemaDraftsByNodeId ?? {}
  );
  const [checklistDraftsByNodeId, setChecklistDraftsByNodeId] = useState<Record<string, WorkflowChecklistDraft>>(
    () => initialDraft?.checklistDraftsByNodeId ?? {}
  );
  const [files, setFiles] = useState<File[]>([]);
  const [aiDraftOpen, setAiDraftOpen] = useState(false);
  const [aiDraftFiles, setAiDraftFiles] = useState<File[]>([]);
  const [aiDraftPersistSamples, setAiDraftPersistSamples] = useState(false);
  const [aiDraftIncludeChecklist, setAiDraftIncludeChecklist] = useState(true);
  const [isGeneratingAiDraft, setIsGeneratingAiDraft] = useState(false);
  const [libraryDocuments, setLibraryDocuments] = useState<LibraryDocument[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [activeRunId, setActiveRunId] = useState("");
  const [manualRunSelection, setManualRunSelection] = useState(false);
  const [runSidebarOpen, setRunSidebarOpen] = useState(false);
  const [runSidebarWidth, setRunSidebarWidth] = useState(() =>
    clampWorkflowPaneWidth(
      readWorkflowResultPaneWidth(WORKFLOW_RUN_SIDEBAR_WIDTH_KEY, WORKFLOW_RUN_SIDEBAR_DEFAULT_WIDTH),
      WORKFLOW_RUN_SIDEBAR_MIN_WIDTH,
      WORKFLOW_RUN_SIDEBAR_MAX_WIDTH
    )
  );
  const [viewportRevision, setViewportRevision] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [isStartingRun, setIsStartingRun] = useState(false);
  const [runStartMessage, setRunStartMessage] = useState<string | null>(null);
  const [runStartFileCount, setRunStartFileCount] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [demoTourStep, setDemoTourStep] = useState<number | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(initialDraft ? "복원됨" : null);
  const [nodeContextMenu, setNodeContextMenu] = useState<WorkflowNodeContextMenu | null>(null);
  const [assetEditorDismissedNodeId, setAssetEditorDismissedNodeId] = useState<string | null>(null);
  const workflowStartAbortRef = useRef<AbortController | null>(null);
  const workflowStartRunIdRef = useRef<string>("");
  const workflowStartCancelRequestedRef = useRef(false);
  const workflowResumeFileInputRef = useRef<HTMLInputElement | null>(null);
  const workflowResumeFolderInputRef = useRef<HTMLInputElement | null>(null);
  const workflowResumeRunIdRef = useRef<string>("");
  const reactFlowInstanceRef = useRef<ReactFlowScreenProjector | null>(null);
  const nodeContextMenuRef = useRef<HTMLDivElement | null>(null);
  const selectedNodeIdsRef = useRef<string[]>([]);
  const shiftKeyPressedRef = useRef(false);
  const ignoreNextNodeSelectChangeRef = useRef(false);
  const starterWorkflowBootstrapAttemptedRef = useRef(false);
  const starterWorkflowAutoLoadedRef = useRef(false);

  const processingRun = runs.find((run) => workflowRunIsProcessing(run)) ?? null;
  const pausedRun = runs.find((run) => workflowRunIsPaused(run)) ?? null;
  const selectedRun = runs.find((run) => run.id === activeRunId) ?? null;
  const liveRun = processingRun ?? pausedRun ?? runs.find((run) => workflowRunIsLive(run)) ?? null;
  const activeRun = selectedRun ?? liveRun ?? runs[0] ?? null;
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const assetEditorNode = selectedNode && workflowNodeHasAssetEditor(selectedNode) && assetEditorDismissedNodeId !== selectedNode.id
    ? selectedNode
    : null;
  const selectedNodeIds = useMemo(
    () => Array.from(new Set(nodes.filter((node) => node.selected || node.id === selectedNodeId).map((node) => node.id))),
    [nodes, selectedNodeId]
  );
  const canvasNodes = useMemo(
    () => buildCanvasNodes(nodes, edges, schemas, classifiers, checklists, updateNodeConfig, onWorkflowNodeSelect, selectedNodeIds),
    [nodes, edges, schemas, classifiers, checklists, selectedNodeIds]
  );
  const validation = useMemo(
    () => validateWorkflow(nodes, edges, classifierDraftsByNodeId, schemaDraftsByNodeId, checklistDraftsByNodeId),
    [nodes, edges, classifierDraftsByNodeId, schemaDraftsByNodeId, checklistDraftsByNodeId]
  );
  const runSidebarStyle = useMemo<CSSProperties>(() => ({ width: `${runSidebarWidth}px` }), [runSidebarWidth]);
  const isRunningRun = Boolean(processingRun);
  const selectedDocumentCount = files.length || libraryDocuments.length;
  const shouldAnimateCanvasEdges = isRunningRun || isStartingRun;
  const canvasEdges = useMemo(
    () =>
      edges.map((edge) => ({
        ...edge,
        animated: shouldAnimateCanvasEdges,
        className: [edge.className, shouldAnimateCanvasEdges ? "workflow-edge-flowing" : ""].filter(Boolean).join(" ") || undefined
      })),
    [edges, shouldAnimateCanvasEdges]
  );
  const runButtonTitle = validation.errors.length
    ? `실행할 수 없습니다: ${validation.errors[0]}`
    : activeWorkflowId
      ? "현재 워크플로우를 저장한 뒤 실행합니다."
      : "워크플로우를 자동 저장한 뒤 실행합니다.";

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    setAssetEditorDismissedNodeId(null);
  }, [selectedNodeId]);

  useEffect(() => {
    if (!initialLibraryDocuments.length) return;
    setLibraryDocuments(initialLibraryDocuments);
    setFiles([]);
    setMessage(`${initialLibraryDocuments.length.toLocaleString()}개 보관 문서를 선택했습니다.`);
    onConsumeInitialLibraryDocuments?.();
  }, [initialLibraryDocuments, onConsumeInitialLibraryDocuments]);

  useEffect(() => {
    if (!initialWorkflowId || !workflows.length) return;
    const workflow = workflows.find((item) => item.id === initialWorkflowId);
    if (!workflow) return;
    loadWorkflowIntoCanvas(workflow);
    onConsumeInitialWorkflowId?.();
  }, [initialWorkflowId, workflows, onConsumeInitialWorkflowId]);

  useEffect(() => {
    if (window.localStorage.getItem(BANK_POC_TOUR_PENDING_KEY) !== "1") return;
    window.localStorage.removeItem(BANK_POC_TOUR_PENDING_KEY);
    setDemoTourStep(0);
  }, []);

  useEffect(() => {
    if (!activeRun || TERMINAL_RUN_STATUSES.includes(activeRun.status)) return;
    const timer = window.setInterval(() => void refreshRun(activeRun.id), 1200);
    return () => window.clearInterval(timer);
  }, [activeRun?.id, activeRun?.status]);

  useEffect(() => {
    const shouldUseBankPocViewport = isBankPocCanvas(workflowName, nodes);
    const bankPocViewport = runSidebarOpen ? BANK_POC_CANVAS_VIEWPORT_WITH_SIDEBAR : BANK_POC_CANVAS_VIEWPORT;
    const timers = [120, 360, 760].map((delay) =>
      window.setTimeout(() => {
        const instance = reactFlowInstanceRef.current;
        if (!instance) return;
        if (shouldUseBankPocViewport && instance.setViewport) {
          instance.setViewport(bankPocViewport, { duration: 240 });
          return;
        }
        instance.fitView?.({ padding: WORKFLOW_FIT_VIEW_PADDING, duration: 240 });
      }, delay)
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [runSidebarOpen, runSidebarWidth, activeWorkflowId, workflowName, viewportRevision, nodes.length, edges.length, schemas.length, classifiers.length, checklists.length, libraryDocuments.length]);

  useEffect(() => {
    if (!runs.length) {
      if (activeRunId) setActiveRunId("");
      return;
    }
    const current = runs.find((run) => run.id === activeRunId) ?? null;
    if (liveRun && (!manualRunSelection || !current || workflowRunIsTerminalOrWaiting(current))) {
      if (activeRunId !== liveRun.id) setActiveRunId(liveRun.id);
      return;
    }
    if (!current) {
      setActiveRunId((liveRun ?? runs[0]).id);
    }
  }, [activeRunId, liveRun, manualRunSelection, runs]);

  useEffect(() => {
    const timer = window.setInterval(() => void refreshRunsList(), 3000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      writeWorkflowDraft({
        activeWorkflowId,
        workflowName,
        nodes,
        edges,
        selectedNodeId,
        classifierDraftsByNodeId,
        schemaDraftsByNodeId,
        checklistDraftsByNodeId
      });
      setDraftSavedAt(new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [activeWorkflowId, workflowName, nodes, edges, selectedNodeId, classifierDraftsByNodeId, schemaDraftsByNodeId, checklistDraftsByNodeId]);

  useEffect(() => {
    if (!nodeContextMenu) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (event.target instanceof globalThis.Node && nodeContextMenuRef.current?.contains(event.target)) return;
      setNodeContextMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNodeContextMenu(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", closeNodeContextMenu);
    window.addEventListener("scroll", closeNodeContextMenu, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", closeNodeContextMenu);
      window.removeEventListener("scroll", closeNodeContextMenu, true);
    };
  }, [nodeContextMenu]);

  useEffect(() => {
    selectedNodeIdsRef.current = selectedNodeIds;
  }, [selectedNodeIds]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Shift") shiftKeyPressedRef.current = true;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") shiftKeyPressedRef.current = false;
    };
    const onWindowBlur = () => {
      shiftKeyPressedRef.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, []);

  const onNodesChange = useCallback((changes: NodeChange<WorkflowNode>[]) => {
    setNodes((current) => {
      if (changes.every((change) => change.type === "select") && (shiftKeyPressedRef.current || ignoreNextNodeSelectChangeRef.current)) {
        ignoreNextNodeSelectChangeRef.current = false;
        return current;
      }
      const next = applyNodeChanges(changes, current);
      if (changes.some((change) => change.type === "select" || change.type === "remove")) {
        const nextSelectedId = next.filter((node) => node.selected).at(-1)?.id ?? null;
        selectedNodeIdsRef.current = next.filter((node) => node.selected).map((node) => node.id);
        setSelectedNodeId(nextSelectedId);
      }
      return next;
    });
  }, []);

  const onNodesDelete = useCallback((deletedNodes: WorkflowNode[]) => {
    const deletedIds = new Set(deletedNodes.map((node) => node.id));
    if (!deletedIds.size) return;
    setEdges((current) => current.filter((edge) => !deletedIds.has(edge.source) && !deletedIds.has(edge.target)));
    selectedNodeIdsRef.current = [];
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setNodeContextMenu(null);
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange<WorkflowEdge>[]) => {
    setEdges((current) => normalizeWorkflowEdges(applyEdgeChanges(changes, current)));
    if (selectedEdgeId && changes.some((change) => change.type === "remove" && change.id === selectedEdgeId)) {
      setSelectedEdgeId(null);
    }
  }, [selectedEdgeId]);

  const onConnect = useCallback((connection: Connection) => {
    const validationMessage = validateConnection(connection, nodes, edges);
    if (validationMessage) {
      setError(validationMessage);
      return;
    }
    setError(null);
    setSelectedEdgeId(null);
    setEdges((current) =>
      addEdge(
        {
          ...connection,
          id: `${connection.source}-${connection.sourceHandle || "out"}-${connection.target}`,
          animated: false,
          label: connection.sourceHandle ? branchKeyLabel(connection.sourceHandle) : undefined
        },
        current
      )
    );
  }, [edges, nodes]);

  function deleteSelectedEdge() {
    if (!selectedEdgeId) return;
    setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId));
    setSelectedEdgeId(null);
    setMessage("선 연결을 삭제했습니다.");
  }

  function clearSelectedNodes() {
    selectedNodeIdsRef.current = [];
    setSelectedNodeId(null);
    setNodes((current) => (current.some((node) => node.selected) ? current.map((node) => ({ ...node, selected: false })) : current));
  }

  function setSelectedNodesByIds(nodeIds: string[]) {
    selectedNodeIdsRef.current = nodeIds;
    const selectedIds = new Set(nodeIds);
    setNodes((current) => current.map((node) => ({ ...node, selected: selectedIds.has(node.id) })));
    setSelectedNodeId(nodeIds.at(-1) ?? null);
  }

  function selectSingleNode(nodeId: string) {
    setSelectedNodesByIds([nodeId]);
    setSelectedEdgeId(null);
    setNodeContextMenu(null);
  }

  function toggleNodeSelection(nodeId: string) {
    const selectedIds = new Set(selectedNodeIdsRef.current);
    if (selectedIds.has(nodeId)) {
      selectedIds.delete(nodeId);
    } else {
      selectedIds.add(nodeId);
    }
    setSelectedNodesByIds(Array.from(selectedIds));
    setSelectedEdgeId(null);
    setNodeContextMenu(null);
  }

  function onWorkflowNodeSelect(event: ReactMouseEvent, nodeId: string) {
    if (event.shiftKey || event.nativeEvent.shiftKey || shiftKeyPressedRef.current) {
      event.preventDefault();
      ignoreNextNodeSelectChangeRef.current = true;
      toggleNodeSelection(nodeId);
      return;
    }
    ignoreNextNodeSelectChangeRef.current = false;
    selectSingleNode(nodeId);
  }

  function deleteSelectedNodes() {
    if (!selectedNodeIds.length) return;
    const selectedIds = new Set(selectedNodeIds);
    setNodes((current) => current.filter((node) => !selectedIds.has(node.id)));
    setEdges((current) => current.filter((edge) => !selectedIds.has(edge.source) && !selectedIds.has(edge.target)));
    selectedNodeIdsRef.current = [];
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setNodeContextMenu(null);
    setMessage(`${selectedIds.size.toLocaleString()}개 노드를 삭제했습니다.`);
  }

  function closeNodeContextMenu() {
    setNodeContextMenu(null);
  }

  function onRunSidebarResize(event: PointerEvent<HTMLButtonElement>) {
    startWorkflowRunSidebarResize(event, runSidebarWidth, setRunSidebarWidth);
  }

  function focusWorkflowRun(runId: string, manual = true) {
    setManualRunSelection(manual);
    setActiveRunId(runId);
  }

  function pauseRunFromHistory(runId: string) {
    if (isStartingRun && (workflowStartRunIdRef.current === runId || activeRunId === runId)) {
      void pauseStartingRun();
      return;
    }
    void pauseRun(runId);
  }

  async function refreshAll() {
    setError(null);
    try {
      const [loadedWorkflows, loadedSchemas, loadedClassifiers, loadedChecklists, loadedRuns] = await Promise.all([
        api<WorkflowDefinition[]>("/api/workflows"),
        api<SchemaSummary[]>("/api/schemas"),
        api<ClassifierSummary[]>("/api/document-classifiers"),
        api<ChecklistSummary[]>("/api/required-field-checklists"),
        api<WorkflowRun[]>(`/api/workflow-runs?limit=${WORKFLOW_RUN_HISTORY_LIMIT}`)
      ]);
      const sortedRuns = sortWorkflowRunsByRegistration(loadedRuns);
      if (
        !starterWorkflowBootstrapAttemptedRef.current &&
        shouldBootstrapBankPocStarterWorkflow({
          activeWorkflowId,
          checklists: loadedChecklists,
          classifiers: loadedClassifiers,
          initialDraft,
          initialWorkflowId,
          schemas: loadedSchemas,
          workflows: loadedWorkflows
        })
      ) {
        starterWorkflowBootstrapAttemptedRef.current = true;
        setMessage("샘플 스키마와 데모 워크플로우를 준비하는 중입니다.");
        const seeded = await api<BankPocSeed>("/api/templates/bank-documents-poc/seed", { method: "POST" });
        const seededDocuments = seeded.sample_documents?.length
          ? seeded.sample_documents
          : seeded.sample_document
            ? [seeded.sample_document]
            : [];
        setWorkflows(upsertById(loadedWorkflows, seeded.workflow));
        setSchemas(upsertById(loadedSchemas, seeded.schema));
        setClassifiers(upsertById(loadedClassifiers, seeded.classifier));
        setChecklists(upsertById(loadedChecklists, seeded.checklist));
        setRuns(sortedRuns);
        if (!activeRunId && sortedRuns[0]) {
          focusWorkflowRun((sortedRuns.find((run) => workflowRunIsLive(run)) ?? sortedRuns[0]).id, false);
        }
        setFiles([]);
        setLibraryDocuments(seededDocuments);
        starterWorkflowAutoLoadedRef.current = true;
        loadWorkflowIntoCanvas(seeded.workflow);
        setMessage(
          seededDocuments.length
            ? `샘플 스키마, 체크리스트, ${seededDocuments.length.toLocaleString()}개 보관 문서를 불러왔습니다.`
            : "샘플 스키마와 체크리스트를 불러왔습니다."
        );
        return;
      }
      setWorkflows(loadedWorkflows);
      setSchemas(loadedSchemas);
      setClassifiers(loadedClassifiers);
      setChecklists(loadedChecklists);
      setRuns(sortedRuns);
      if (!activeRunId && sortedRuns[0]) {
        focusWorkflowRun((sortedRuns.find((run) => workflowRunIsLive(run)) ?? sortedRuns[0]).id, false);
      }
      if (activeWorkflowId && !loadedWorkflows.some((workflow) => workflow.id === activeWorkflowId)) {
        setActiveWorkflowId("");
      }
      if (!starterWorkflowAutoLoadedRef.current) {
        const starterWorkflow = starterWorkflowToAutoLoad({
          activeWorkflowId,
          checklists: loadedChecklists,
          classifiers: loadedClassifiers,
          initialDraft,
          initialWorkflowId,
          schemas: loadedSchemas,
          workflows: loadedWorkflows
        });
        if (starterWorkflow) {
          starterWorkflowAutoLoadedRef.current = true;
          loadWorkflowIntoCanvas(starterWorkflow);
        }
      }
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "워크플로우 데이터를 불러오지 못했습니다.");
    }
  }

  async function refreshRunsList() {
    try {
      const loadedRuns = await api<WorkflowRun[]>(`/api/workflow-runs?limit=${WORKFLOW_RUN_HISTORY_LIMIT}`);
      setRuns((current) => {
        const currentById = new Map(current.map((run) => [run.id, run]));
        return sortWorkflowRunsByRegistration(loadedRuns.map((run) => {
          const existing = currentById.get(run.id);
          return run.items.length || !existing ? run : { ...run, items: existing.items };
        }), current);
      });
    } catch {
      // Background polling should not interrupt the current editing flow.
    }
  }

  function loadWorkflowIntoCanvas(workflow: WorkflowDefinition) {
    setActiveWorkflowId(workflow.id);
    setWorkflowName(workflow.name);
    setNodes((workflow.definition.nodes?.length ? workflow.definition.nodes : defaultNodes).map(normalizeWorkflowNode));
    setEdges(normalizeWorkflowEdges(workflow.definition.edges?.length ? workflow.definition.edges : defaultEdges));
    setSelectedNodeId(workflow.definition.nodes?.[0]?.id ?? defaultNodes[0].id);
    setClassifierDraftsByNodeId({});
    setSchemaDraftsByNodeId({});
    setChecklistDraftsByNodeId({});
    setViewportRevision((current) => current + 1);
    setMessage(`불러온 워크플로우: ${workflow.name}`);
  }

  function resetWorkflowDraft() {
    setActiveWorkflowId("");
    setWorkflowName("문서 자동화 워크플로우");
    setNodes(defaultNodes.map(normalizeWorkflowNode));
    setEdges(normalizeWorkflowEdges(defaultEdges));
    setSelectedNodeId(defaultNodes[1]?.id ?? defaultNodes[0]?.id ?? null);
    setClassifierDraftsByNodeId({});
    setSchemaDraftsByNodeId({});
    setChecklistDraftsByNodeId({});
    setViewportRevision((current) => current + 1);
    setMessage("새 워크플로우를 시작합니다.");
  }

  async function persistWorkflow() {
    if (validation.errors.length) {
      throw new Error(validation.errors[0]);
    }
    const materializedNodes = await materializeWorkflowDraftAssets(nodes);
    const payload = {
      name: workflowName.trim() || "문서 자동화 워크플로우",
      description: null,
      definition: serializeDefinition(materializedNodes, edges)
    };
    const workflowKnownMissing = Boolean(activeWorkflowId && workflows.length && !workflows.some((workflow) => workflow.id === activeWorkflowId));
    const shouldUpdateWorkflow = Boolean(activeWorkflowId && !workflowKnownMissing);
    let saved: WorkflowDefinition;
    try {
      saved = await api<WorkflowDefinition>(shouldUpdateWorkflow ? `/api/workflows/${activeWorkflowId}` : "/api/workflows", {
        method: shouldUpdateWorkflow ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch (exc) {
      if (!shouldUpdateWorkflow || !isWorkflowNotFoundError(exc)) {
        throw exc;
      }
      setActiveWorkflowId("");
      saved = await api<WorkflowDefinition>("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    }
    setActiveWorkflowId(saved.id);
    setWorkflows((current) => [saved, ...current.filter((workflow) => workflow.id !== saved.id)]);
    setNodes(materializedNodes);
    setDraftSavedAt("저장됨");
    return saved;
  }

  async function materializeWorkflowDraftAssets(currentNodes: WorkflowNode[]) {
    let nextNodes = currentNodes;
    const nextClassifierDrafts = { ...classifierDraftsByNodeId };
    const nextSchemaDrafts = { ...schemaDraftsByNodeId };
    const nextChecklistDrafts = { ...checklistDraftsByNodeId };
    const savedClassifiers: ClassifierSummary[] = [];
    const savedSchemas: SchemaSummary[] = [];
    const savedChecklists: ChecklistSummary[] = [];

    for (const node of currentNodes) {
      if (node.data.kind === "classifier") {
        const draft = nextClassifierDrafts[node.id];
        if (!draft) continue;
        const classifierId = node.data.config?.classifier_id ?? "";
        const saved = classifierId
          ? await api<ClassifierSummary>(`/api/document-classifiers/${classifierId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(classifierDraftPayload(draft))
            })
          : await api<ClassifierSummary>("/api/document-classifiers", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(classifierDraftPayload(draft))
            });
        savedClassifiers.push(saved);
        delete nextClassifierDrafts[node.id];
        nextNodes = updateWorkflowNodeConfig(nextNodes, node.id, "classifier_id", saved.id);
        nextNodes = syncBranchKeys(nextNodes, saved.id, [saved, ...classifiers.filter((classifier) => classifier.id !== saved.id)]);
      }

      if (node.data.kind === "kie") {
        const draft = nextSchemaDrafts[node.id];
        if (!draft) continue;
        const schemaId = node.data.config?.schema_id ?? "";
        const saved = schemaId
          ? await api<SchemaSummary>(`/api/schemas/${schemaId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(schemaDraftPayload(draft))
            })
          : await api<SchemaSummary>("/api/schemas", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(schemaDraftPayload(draft))
            });
        savedSchemas.push(saved);
        delete nextSchemaDrafts[node.id];
        nextNodes = updateWorkflowNodeConfig(nextNodes, node.id, "schema_id", saved.id);
      }

      if (node.data.kind === "required-checker") {
        const draft = nextChecklistDrafts[node.id];
        if (!draft) continue;
        const checklistId = node.data.config?.checklist_id ?? "";
        const saved = checklistId
          ? await api<ChecklistSummary>(`/api/required-field-checklists/${checklistId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(checklistDraftPayload(draft))
            })
          : await api<ChecklistSummary>("/api/required-field-checklists", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(checklistDraftPayload(draft))
            });
        savedChecklists.push(saved);
        delete nextChecklistDrafts[node.id];
        nextNodes = updateWorkflowNodeConfig(nextNodes, node.id, "checklist_id", saved.id);
      }
    }

    if (savedClassifiers.length) {
      setClassifiers((current) => [...savedClassifiers, ...current.filter((classifier) => !savedClassifiers.some((saved) => saved.id === classifier.id))]);
      setClassifierDraftsByNodeId(nextClassifierDrafts);
    }
    if (savedSchemas.length) {
      setSchemas((current) => [...savedSchemas, ...current.filter((schema) => !savedSchemas.some((saved) => saved.id === schema.id))]);
      setSchemaDraftsByNodeId(nextSchemaDrafts);
    }
    if (savedChecklists.length) {
      setChecklists((current) => [...savedChecklists, ...current.filter((checklist) => !savedChecklists.some((saved) => saved.id === checklist.id))]);
      setChecklistDraftsByNodeId(nextChecklistDrafts);
    }
    return nextNodes;
  }

  function isWorkflowNotFoundError(exc: unknown) {
    return exc instanceof Error && exc.message === "Workflow not found";
  }

  async function saveWorkflow() {
    setIsSaving(true);
    setError(null);
    try {
      await persistWorkflow();
      setMessage("워크플로우를 저장했습니다.");
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "워크플로우 저장에 실패했습니다.");
    } finally {
      setIsSaving(false);
    }
  }

  async function runWorkflow() {
    const runFiles = sortUploadFiles(files);
    if (!runFiles.length && !libraryDocuments.length) {
      setError("실행할 문서를 업로드하거나 문서 보관함에서 선택하세요.");
      return;
    }
    if (validation.errors.length) {
      setError(`워크플로우를 실행할 수 없습니다. ${validation.errors[0]}`);
      return;
    }
    setIsStartingRun(true);
    setRunStartFileCount(runFiles.length || libraryDocuments.length);
    setRunStartMessage("작업 준비 중");
    setIsSaving(true);
    setError(null);
    workflowStartCancelRequestedRef.current = false;
    const abortController = new AbortController();
    workflowStartAbortRef.current = abortController;
    workflowStartRunIdRef.current = "";
    try {
      const saved = await persistWorkflow();
      const sourceDocuments = libraryDocuments.length
        ? libraryDocuments
        : await uploadWorkflowFilesToLibrary(runFiles, abortController);
      setRunStartMessage("작업 등록 완료");
      const run = await api<WorkflowRun>(`/api/workflows/${saved.id}/runs/from-documents`, {
        method: "POST",
        body: JSON.stringify({ document_ids: sourceDocuments.map((document) => document.document_id) }),
        signal: abortController.signal
      });
      workflowStartRunIdRef.current = run.id;
      upsertRun(run);
      focusWorkflowRun(run.id, false);
      setFiles([]);
      setLibraryDocuments([]);
      setMessage("문서 보관함 기준으로 워크플로우 실행을 시작했습니다. 변환 중인 문서는 준비되면 자동 실행됩니다.");
      void refreshRun(run.id);
    } catch (exc) {
      if (workflowStartCancelRequestedRef.current || (exc instanceof Error && exc.name === "AbortError")) {
        setMessage("워크플로우 시작을 중단했습니다.");
        return;
      }
      setError(exc instanceof Error ? exc.message : "워크플로우 실행에 실패했습니다.");
    } finally {
      if (workflowStartAbortRef.current === abortController) {
        workflowStartAbortRef.current = null;
        workflowStartRunIdRef.current = "";
      }
      setIsStartingRun(false);
      setRunStartMessage(null);
      setIsSaving(false);
    }
  }

  async function uploadWorkflowFilesToLibrary(runFiles: File[], abortController: AbortController) {
    const uploadedDocuments: LibraryDocument[] = [];
    let uploadedCount = 0;
    for (let chunkStart = 0; chunkStart < runFiles.length; chunkStart += uploadChunkFiles) {
      if (abortController.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const chunk = runFiles.slice(chunkStart, chunkStart + uploadChunkFiles);
      setRunStartMessage(`${uploadedCount.toLocaleString()} / ${runFiles.length.toLocaleString()} 문서 보관함 업로드 중`);
      const uploaded = await uploadLibraryFiles(chunk);
      uploadedDocuments.push(...uploaded);
      uploadedCount += chunk.length;
      setRunStartMessage(`${uploadedCount.toLocaleString()} / ${runFiles.length.toLocaleString()} 문서 보관함 업로드 중`);
    }
    return uploadedDocuments;
  }

  async function stopStartingRun() {
    workflowStartCancelRequestedRef.current = true;
    setRunStartMessage("시작 중단 중");
    workflowStartAbortRef.current?.abort();
    const runId = workflowStartRunIdRef.current || activeRunId;
    if (!runId) {
      setIsStartingRun(false);
      setRunStartMessage(null);
      setIsSaving(false);
      setMessage("워크플로우 시작을 중단했습니다.");
      return;
    }
    await discardRun(runId);
    setIsStartingRun(false);
    setRunStartMessage(null);
    setIsSaving(false);
  }

  async function pauseStartingRun() {
    workflowStartCancelRequestedRef.current = true;
    setRunStartMessage("일시중단 중");
    workflowStartAbortRef.current?.abort();
    const runId = workflowStartRunIdRef.current || activeRunId;
    if (!runId) {
      setIsStartingRun(false);
      setRunStartMessage(null);
      setIsSaving(false);
      setMessage("워크플로우 시작을 일시중단했습니다.");
      return;
    }
    await pauseRun(runId);
    setIsStartingRun(false);
    setRunStartMessage(null);
    setIsSaving(false);
  }

  async function refreshRun(runId: string) {
    try {
      const run = await api<WorkflowRun>(`/api/workflow-runs/${runId}/summary`);
      setRuns((current) => {
        const existing = current.find((item) => item.id === run.id);
        const merged = run.items.length || !existing ? run : { ...run, items: existing.items };
        return sortWorkflowRunsByRegistration([merged, ...current.filter((item) => item.id !== run.id)], current).slice(0, WORKFLOW_RUN_HISTORY_LIMIT);
      });
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "워크플로우 실행 상태를 갱신하지 못했습니다.");
    }
  }

  function upsertRun(run: WorkflowRun) {
    setRuns((current) => sortWorkflowRunsByRegistration([run, ...current.filter((item) => item.id !== run.id)], current).slice(0, WORKFLOW_RUN_HISTORY_LIMIT));
  }

  async function uploadWorkflowFiles(
    runId: string,
    runFiles: File[],
    initialRun: WorkflowRun,
    abortController: AbortController,
    label: string
  ) {
    const chunks = indexedChunks(runFiles, uploadChunkFiles);
    if (!chunks.length) return initialRun;
    const workerCount = Math.min(WORKFLOW_UPLOAD_CONCURRENCY, chunks.length);
    let nextChunkIndex = 0;
    let latestRun = initialRun;
    let firstError: unknown = null;

    async function uploadWorker() {
      while (!firstError && nextChunkIndex < chunks.length) {
        const chunk = chunks[nextChunkIndex];
        nextChunkIndex += 1;
        const uploadedCount = latestRun.uploaded_count ?? latestRun.items.length;
        setRunStartMessage(`${uploadedCount.toLocaleString()} / ${latestRun.total_count.toLocaleString()} ${label}`);
        const form = new FormData();
        chunk.files.forEach((file, index) => {
          const uploadIndex = chunk.start + index;
          form.append("files", file);
          form.append("client_file_ids", clientFileId(file, uploadIndex));
          form.append("upload_indexes", String(uploadIndex));
        });
        try {
          const nextRun = await api<WorkflowRun>(`/api/workflow-runs/${runId}/items`, {
            method: "POST",
            body: form,
            signal: abortController.signal
          });
          const latestUploadedCount = latestRun.uploaded_count ?? latestRun.items.length;
          const nextUploadedCount = nextRun.uploaded_count ?? nextRun.items.length;
          if (nextUploadedCount >= latestUploadedCount) {
            latestRun = nextRun;
          }
          upsertRun(nextRun);
          setRunStartMessage(`${nextUploadedCount.toLocaleString()} / ${nextRun.total_count.toLocaleString()} ${label}`);
        } catch (exc) {
          firstError = exc;
          abortController.abort();
          break;
        }
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => uploadWorker()));
    if (firstError) throw firstError;
    return latestRun;
  }

  async function resumeRun(runId: string) {
    setError(null);
    try {
      const run = await api<WorkflowRun>(`/api/workflow-runs/${runId}/resume`, { method: "POST" });
      upsertRun(run);
      focusWorkflowRun(run.id, false);
      setMessage("일시중단된 워크플로우 처리를 이어갑니다.");
      void refreshRun(run.id);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "워크플로우를 계속 처리하지 못했습니다.");
    }
  }

  async function pauseRun(runId: string) {
    setError(null);
    try {
      const run = await api<WorkflowRun>(`/api/workflow-runs/${runId}/pause`, { method: "POST" });
      upsertRun(run);
      focusWorkflowRun(run.id, false);
      setMessage("워크플로우 실행을 일시중단했습니다. 업로드된 문서는 보존됩니다.");
      void refreshRun(run.id);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "워크플로우를 일시중단하지 못했습니다.");
    }
  }

  async function enqueueRun(runId: string) {
    setError(null);
    setIsSaving(true);
    try {
      const saved = await persistWorkflow();
      const run = await api<WorkflowRun>(`/api/workflow-runs/${runId}/enqueue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow_id: saved.id })
      });
      upsertRun(run);
      setMessage("업로드된 문서를 재사용하는 워크플로우 실행을 예약했습니다.");
      void refreshRun(runId);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "워크플로우 실행을 예약하지 못했습니다.");
    } finally {
      setIsSaving(false);
    }
  }

  async function startWaitingRun(runId: string) {
    setError(null);
    try {
      const run = await api<WorkflowRun>(`/api/workflow-runs/${runId}/start`, { method: "POST" });
      upsertRun(run);
      focusWorkflowRun(run.id, false);
      setMessage("대기 중인 워크플로우 실행을 바로 시작했습니다.");
      void refreshRun(run.id);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "대기 중인 워크플로우 실행을 시작하지 못했습니다.");
    }
  }

  async function deleteQueueEntry(runId: string) {
    setError(null);
    try {
      await api<{ status: string; id: string }>(`/api/workflow-runs/${runId}/queue-entry`, { method: "DELETE" });
      setRuns((current) => current.filter((run) => run.id !== runId));
      if (activeRunId === runId) {
        setManualRunSelection(false);
        setActiveRunId("");
      }
      setMessage("추론 실행을 중단하고 대기열 항목을 삭제했습니다. 업로드된 문서는 보존됩니다.");
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "대기열 항목을 삭제하지 못했습니다.");
    }
  }

  function requestResumeUpload(runId: string) {
    workflowResumeRunIdRef.current = runId;
    setError(null);
    setMessage("새로고침 전 선택했던 전체 파일을 다시 선택하세요. 이미 등록된 파일은 건너뛰고 남은 파일만 업로드합니다.");
    workflowResumeFileInputRef.current?.click();
  }

  function requestResumeFolderUpload(runId: string) {
    workflowResumeRunIdRef.current = runId;
    setError(null);
    setMessage("새로고침 전 선택했던 전체 폴더를 다시 선택하세요. 이미 등록된 파일은 건너뛰고 남은 파일만 업로드합니다.");
    workflowResumeFolderInputRef.current?.click();
  }

  function onResumeUploadInput(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = sortUploadFiles(Array.from(event.target.files ?? []).filter(isWorkflowUploadFile));
    const runId = workflowResumeRunIdRef.current || activeRunId;
    event.currentTarget.value = "";
    workflowResumeRunIdRef.current = "";
    if (!selectedFiles.length || !runId) return;
    void continueWorkflowUpload(runId, selectedFiles);
  }

  async function continueWorkflowUpload(runId: string, selectedFiles: File[]) {
    const run = runs.find((item) => item.id === runId) ?? activeRun;
    if (!run) {
      setError("이어갈 워크플로우 실행을 찾지 못했습니다.");
      return;
    }
    if (selectedFiles.length !== run.total_count) {
      setError(
        `처음 선언된 ${run.total_count.toLocaleString()}개 전체 파일을 다시 선택하세요. 현재 선택은 ${selectedFiles.length.toLocaleString()}개입니다.`
      );
      return;
    }

    setIsStartingRun(true);
    setRunStartFileCount(run.total_count);
    setRunStartMessage("업로드 이어가기 준비 중");
    setError(null);
    workflowStartCancelRequestedRef.current = false;
    const abortController = new AbortController();
    workflowStartAbortRef.current = abortController;
    workflowStartRunIdRef.current = runId;
    try {
      let latestRun = await api<WorkflowRun>(`/api/workflow-runs/${runId}/summary`, { signal: abortController.signal });
      upsertRun(latestRun);
      focusWorkflowRun(latestRun.id, false);
      latestRun = await uploadWorkflowFiles(runId, selectedFiles, latestRun, abortController, "문서 업로드 이어가는 중");

      const uploadedCount = latestRun.uploaded_count ?? latestRun.items.length;
      if (uploadedCount < latestRun.total_count) {
        setMessage(`${uploadedCount.toLocaleString()} / ${latestRun.total_count.toLocaleString()}개까지 등록했습니다. 남은 파일을 이어서 선택하세요.`);
        return;
      }
      setRunStartMessage("업로드 완료, 실행 등록 중");
      const startedRun = await api<WorkflowRun>(`/api/workflow-runs/${runId}/start`, { method: "POST", signal: abortController.signal });
      upsertRun(startedRun);
      focusWorkflowRun(startedRun.id, false);
      setMessage("업로드를 복구했고 워크플로우 실행을 시작했습니다.");
      void refreshRun(startedRun.id);
    } catch (exc) {
      if (workflowStartCancelRequestedRef.current || (exc instanceof Error && exc.name === "AbortError")) {
        setMessage("워크플로우 업로드 이어가기를 중단했습니다.");
        return;
      }
      setError(exc instanceof Error ? exc.message : "워크플로우 업로드를 이어가지 못했습니다.");
    } finally {
      if (workflowStartAbortRef.current === abortController) {
        workflowStartAbortRef.current = null;
        workflowStartRunIdRef.current = "";
      }
      setIsStartingRun(false);
      setRunStartMessage(null);
    }
  }

  async function discardRun(runId: string) {
    setError(null);
    try {
      const run = await api<WorkflowRun>(`/api/workflow-runs/${runId}/discard`, { method: "POST" });
      upsertRun(run);
      focusWorkflowRun(run.id, false);
      setMessage("워크플로우 추론을 중단했습니다. 문서는 보관함에 유지됩니다.");
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "워크플로우 실행을 중단하지 못했습니다.");
    }
  }

  function addNode(kind: WorkflowNodeKind, position?: { x: number; y: number }) {
    const palette = nodePalette.find((item) => item.kind === kind);
    const node = workflowNode(
      kind,
      palette?.label ?? kind,
      position?.x ?? 160 + nodes.length * 48,
      position?.y ?? 260 + nodes.length * 16
    );
    selectedNodeIdsRef.current = [node.id];
    setNodes((current) => [...current.map((item) => ({ ...item, selected: false })), { ...node, selected: true }]);
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
    setNodeContextMenu(null);
  }

  function addNodeFromContextMenu(kind: WorkflowNodeKind) {
    addNode(kind, nodeContextMenu?.flowPosition);
  }

  function openNodeContextMenu(event: ReactMouseEvent | globalThis.MouseEvent) {
    event.preventDefault();
    const flowPosition = reactFlowInstanceRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? {
      x: event.clientX,
      y: event.clientY
    };
    setSelectedEdgeId(null);
    setNodeContextMenu({
      ...workflowContextMenuPosition(event.clientX, event.clientY),
      flowPosition
    });
  }

  function updateNodeConfig(nodeId: string, key: string, value: string) {
    setNodes((current) => {
      const next = current.map((node) => {
        if (node.id !== nodeId) return node;
        const config = { ...(node.data.config ?? {}), [key]: value };
        return { ...node, data: { ...node.data, config } };
      });
      return key === "classifier_id" ? syncBranchKeys(next, value, classifiers) : next;
    });
  }

  function updateSchemaDraft(nodeId: string, updater: (draft: WorkflowSchemaDraft) => WorkflowSchemaDraft) {
    const baseDraft =
      schemaDraftsByNodeId[nodeId] ??
      schemaSummaryToDraft(schemas.find((schema) => schema.id === nodes.find((node) => node.id === nodeId)?.data.config?.schema_id)) ??
      emptyWorkflowSchemaDraft(nodeId);
    setSchemaDraftsByNodeId((current) => ({ ...current, [nodeId]: updater(baseDraft) }));
  }

  function updateClassifierDraft(nodeId: string, updater: (draft: WorkflowClassifierDraft) => WorkflowClassifierDraft) {
    const baseDraft =
      classifierDraftsByNodeId[nodeId] ??
      classifierSummaryToDraft(classifiers.find((classifier) => classifier.id === nodes.find((node) => node.id === nodeId)?.data.config?.classifier_id)) ??
      emptyWorkflowClassifierDraft(nodeId);
    const nextDraft = updater(baseDraft);
    setClassifierDraftsByNodeId((current) => ({ ...current, [nodeId]: nextDraft }));
    setNodes((current) => syncBranchKeysFromClassNames(current, normalizeClassifierDraft(nextDraft).classes.map((item) => item.class_name)));
  }

  function updateChecklistDraft(nodeId: string, updater: (draft: WorkflowChecklistDraft) => WorkflowChecklistDraft) {
    const baseDraft =
      checklistDraftsByNodeId[nodeId] ??
      checklistSummaryToDraft(checklists.find((checklist) => checklist.id === nodes.find((node) => node.id === nodeId)?.data.config?.checklist_id)) ??
      emptyWorkflowChecklistDraft(nodeId);
    setChecklistDraftsByNodeId((current) => ({ ...current, [nodeId]: updater(baseDraft) }));
  }

  function onAiDraftFileInput(event: ChangeEvent<HTMLInputElement>) {
    const incomingFiles = Array.from(event.target.files ?? []);
    const nextFiles = incomingFiles.filter(isWorkflowAiDraftImage);
    const ignoredCount = incomingFiles.length - nextFiles.length;
    if (nextFiles.length > WORKFLOW_AI_DRAFT_MAX_IMAGES) {
      setAiDraftFiles([]);
      setError(`AI 워크플로우 생성은 샘플 이미지 최대 ${WORKFLOW_AI_DRAFT_MAX_IMAGES}장까지 가능합니다.`);
      event.currentTarget.value = "";
      return;
    }
    setAiDraftFiles(nextFiles);
    if (ignoredCount) setMessage(`지원하지 않는 샘플 ${ignoredCount.toLocaleString()}개는 제외했습니다.`);
    event.currentTarget.value = "";
  }

  async function generateAiWorkflowDraft() {
    if (!aiDraftFiles.length) {
      setError("AI가 참고할 샘플 이미지를 선택하세요.");
      return;
    }
    setIsGeneratingAiDraft(true);
    setError(null);
    try {
      const form = new FormData();
      aiDraftFiles.forEach((file) => form.append("files", file));
      form.append("include_checklist", aiDraftIncludeChecklist ? "true" : "false");
      const draft = await api<WorkflowAiDraft>("/api/workflows/ai-draft", {
        method: "POST",
        body: form
      });
      applyAiWorkflowDraft(draft);
      if (aiDraftPersistSamples) {
        const uploaded = await uploadLibraryFiles(aiDraftFiles);
        setLibraryDocuments(uploaded);
        setFiles([]);
      }
      setAiDraftOpen(false);
      setAiDraftFiles([]);
      setMessage(
        `${draft.sample_count.toLocaleString()}장 샘플로 워크플로우 초안을 생성했습니다. 원본 이미지는 ${
          aiDraftPersistSamples ? "문서 보관함에 저장했습니다." : "서버에 보관하지 않았습니다."
        }`
      );
      window.setTimeout(() => reactFlowInstanceRef.current?.fitView?.({ padding: WORKFLOW_FIT_VIEW_PADDING, duration: 260 }), 120);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "AI 워크플로우 초안 생성에 실패했습니다.");
    } finally {
      setIsGeneratingAiDraft(false);
    }
  }

  function applyAiWorkflowDraft(draft: WorkflowAiDraft) {
    const nextNodes = (draft.definition.nodes?.length ? draft.definition.nodes : defaultNodes).map(normalizeWorkflowNode);
    const nextEdges = normalizeWorkflowEdges(draft.definition.edges?.length ? draft.definition.edges : defaultEdges);
    const schemaNode = nextNodes.find((node) => node.data.kind === "kie");
    const checklistNode = nextNodes.find((node) => node.data.kind === "required-checker");
    setActiveWorkflowId("");
    setWorkflowName(draft.workflow_name || "AI 생성 워크플로우 초안");
    setNodes(nextNodes);
    setEdges(nextEdges);
    setSelectedNodeId(schemaNode?.id ?? nextNodes[0]?.id ?? null);
    setSelectedEdgeId(null);
    setClassifierDraftsByNodeId({});
    setSchemaDraftsByNodeId(schemaNode ? { [schemaNode.id]: normalizeSchemaDraft(draft.schema_draft) } : {});
    setChecklistDraftsByNodeId(checklistNode && draft.checklist_draft ? { [checklistNode.id]: normalizeChecklistDraft(draft.checklist_draft) } : {});
    setViewportRevision((current) => current + 1);
  }

  function onFileInput(event: ChangeEvent<HTMLInputElement>) {
    const incomingFiles = Array.from(event.target.files ?? []);
    const nextFiles = sortUploadFiles(incomingFiles.filter(isWorkflowUploadFile));
    const ignoredCount = incomingFiles.length - nextFiles.length;
    if (nextFiles.length > uploadMaxBatchFiles) {
      setFiles([]);
      setError(`한 번에 최대 ${uploadMaxBatchFiles.toLocaleString()}개 파일까지 업로드할 수 있습니다.`);
      event.currentTarget.value = "";
      return;
    }
    setError(null);
    setFiles(nextFiles);
    setMessage(ignoredCount ? `지원하지 않는 파일 ${ignoredCount.toLocaleString()}개는 제외했습니다.` : null);
    event.currentTarget.value = "";
  }

  return (
    <ReactFlowProvider>
      <main className={`workflow-builder ${demoTourStep !== null ? `demo-tour-active demo-tour-${bankPocTourSteps[demoTourStep].target}` : ""}`}>
        <aside className="workflow-palette" aria-label="워크플로우 모듈">
          <div className="workflow-panel-header">
            <p className="eyebrow">Builder</p>
            <h2>모듈</h2>
          </div>
          <div className="workflow-node-list">
            {nodePalette.map((item) => (
              <button key={item.kind} type="button" className="workflow-palette-item" onClick={() => addNode(item.kind)}>
                <NodeIcon kind={item.kind} />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
                <Plus size={15} />
              </button>
            ))}
          </div>
          <div className="workflow-library-shortcuts">
            <button type="button" className="secondary" onClick={onCreateSchema}>
              <Sparkles size={15} /> Schema 생성
            </button>
            <button type="button" className="secondary" onClick={onCreateClassifier}>
              <ClipboardList size={15} /> 분류기 생성
            </button>
            <button type="button" className="secondary" onClick={onCreateChecklist}>
              <CheckSquare size={15} /> 체크리스트 생성
            </button>
          </div>
        </aside>

        <section className="workflow-canvas-shell">
          <div className="workflow-toolbar">
            <div className="workflow-title-fields">
              <input value={workflowName} onChange={(event) => setWorkflowName(event.target.value)} aria-label="워크플로우 이름" />
            </div>
            <select value={activeWorkflowId} onChange={(event) => {
              const workflow = workflows.find((item) => item.id === event.target.value);
              if (workflow) {
                loadWorkflowIntoCanvas(workflow);
              } else {
                resetWorkflowDraft();
              }
            }}>
              <option value="">새 워크플로우</option>
              {workflows.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>
                  {workflow.name}
                </option>
              ))}
            </select>
            <button type="button" className="secondary" onClick={() => setAiDraftOpen(true)} disabled={isGeneratingAiDraft || isStartingRun || isRunningRun}>
              {isGeneratingAiDraft ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />} AI 생성
            </button>
            <button type="button" onClick={() => void saveWorkflow()} disabled={isSaving || validation.errors.length > 0}>
              {isSaving ? <Loader2 size={16} className="spin" /> : <Save size={16} />} 저장
            </button>
            <div className="workflow-run-toolbar-actions">
              <WorkflowUploadButton
                disabled={isStartingRun || isRunningRun}
                selectedCount={files.length}
                onChange={(event) => {
                  setLibraryDocuments([]);
                  onFileInput(event);
                }}
              />
              <DocumentPickerButton
                selectedDocuments={libraryDocuments}
                uploadChunkFiles={uploadChunkFiles}
                disabled={isStartingRun || isRunningRun}
                onSelected={(documents) => {
                  setLibraryDocuments(documents);
                  setFiles([]);
                  setMessage(documents.length ? `${documents.length.toLocaleString()}개 보관 문서를 선택했습니다.` : null);
                }}
              />
              <input
                ref={workflowResumeFileInputRef}
                type="file"
                multiple
                accept={WORKFLOW_FILE_ACCEPT}
                className="visually-hidden"
                onChange={onResumeUploadInput}
              />
              <input
                ref={workflowResumeFolderInputRef}
                type="file"
                multiple
                accept={WORKFLOW_FILE_ACCEPT}
                className="visually-hidden"
                onChange={onResumeUploadInput}
                {...{ webkitdirectory: "", directory: "" }}
              />
              <button
                type="button"
                className="primary workflow-run-primary-button"
                onClick={() => void runWorkflow()}
                disabled={isStartingRun || isRunningRun || !selectedDocumentCount}
                title={runButtonTitle}
              >
                {isStartingRun || isRunningRun ? <Loader2 size={16} className="spin" /> : <Play size={16} />}
                {isStartingRun ? "시작 중" : isRunningRun ? "실행 중" : "실행"}
              </button>
              {activeRun && workflowRunCanEnqueue(activeRun) && (
                <button
                  type="button"
                  className="secondary workflow-run-reserve-button"
                  onClick={() => void enqueueRun(activeRun.id)}
                  disabled={isStartingRun || isSaving || validation.errors.length > 0}
                  title={
                    validation.errors.length
                      ? `예약할 수 없습니다: ${validation.errors[0]}`
                      : `${workflowRunSourceTitle(activeRun)}를 재사용해 캔버스의 워크플로우를 다음 실행으로 예약합니다.`
                  }
                >
                  <Plus size={15} /> {workflowRunSourceLabel(activeRun)}로 실행 예약
                </button>
              )}
            </div>
            <button
              type="button"
              className={`secondary workflow-run-sidebar-toolbar-toggle ${runSidebarOpen ? "active" : ""}`}
              onClick={() => setRunSidebarOpen((current) => !current)}
              aria-expanded={runSidebarOpen}
              title={runSidebarOpen ? "실행 현황 접기" : "실행 현황 펼치기"}
            >
              {runSidebarOpen ? <ChevronRight size={16} /> : <ClipboardList size={16} />}
              실행 현황
            </button>
            {selectedEdge && (
              <div className="workflow-edge-actions">
                <span>{edgeLabel(selectedEdge, nodes)}</span>
                <button type="button" className="secondary" onClick={deleteSelectedEdge}>
                  <Unlink2 size={15} /> 선 삭제
                </button>
              </div>
            )}
            {!selectedEdge && selectedNodeIds.length > 0 && (
              <div className="workflow-edge-actions">
                <span>{selectedNodeIds.length.toLocaleString()}개 노드 선택됨</span>
                <button type="button" className="secondary danger-outline" onClick={deleteSelectedNodes}>
                  <Trash2 size={15} /> 노드 삭제
                </button>
              </div>
            )}
            <span className="workflow-autosave">
              자동 저장 {draftSavedAt ?? "대기"}
            </span>
          </div>

          {libraryDocuments.length > 0 && (
            <WorkflowSelectedDocumentsStrip
              documents={libraryDocuments}
              onClear={() => {
                setLibraryDocuments([]);
                setMessage("선택한 보관 문서를 비웠습니다.");
              }}
            />
          )}

          <div className={`workflow-main-area ${runSidebarOpen ? "sidebar-open" : "sidebar-collapsed"}`}>
            <div className="workflow-canvas">
              <ReactFlow
                nodes={canvasNodes}
                edges={canvasEdges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodesDelete={onNodesDelete}
                onConnect={onConnect}
                onInit={(instance) => {
                  reactFlowInstanceRef.current = instance;
                }}
                onEdgeClick={(_, edge) => {
                  setSelectedEdgeId(edge.id);
                  clearSelectedNodes();
                  setNodeContextMenu(null);
                }}
                onPaneClick={() => {
                  setSelectedEdgeId(null);
                  setNodeContextMenu(null);
                  clearSelectedNodes();
                }}
                onPaneContextMenu={openNodeContextMenu}
                deleteKeyCode={["Backspace", "Delete"]}
                multiSelectionKeyCode={null}
                fitView
                fitViewOptions={{ padding: WORKFLOW_FIT_VIEW_PADDING }}
                minZoom={0.25}
              >
                <Background />
                <Controls />
                <MiniMap pannable zoomable />
              </ReactFlow>
              <WorkflowNodeAssetEditor
                selectedNode={assetEditorNode}
                classifiers={classifiers}
                classifierDraftsByNodeId={classifierDraftsByNodeId}
                schemas={schemas}
                schemaDraftsByNodeId={schemaDraftsByNodeId}
                checklists={checklists}
                checklistDraftsByNodeId={checklistDraftsByNodeId}
                onClassifierDraftChange={updateClassifierDraft}
                onSchemaDraftChange={updateSchemaDraft}
                onChecklistDraftChange={updateChecklistDraft}
                onClose={() => {
                  if (assetEditorNode) setAssetEditorDismissedNodeId(assetEditorNode.id);
                }}
              />
              {nodeContextMenu && (
                <div
                  ref={nodeContextMenuRef}
                  className="workflow-upload-menu workflow-upload-menu-fixed workflow-node-create-menu"
                  role="menu"
                  style={{ top: nodeContextMenu.top, left: nodeContextMenu.left }}
                >
                  {nodePalette.map((item) => (
                    <button
                      key={item.kind}
                      type="button"
                      className="workflow-upload-menu-item"
                      role="menuitem"
                      onClick={() => addNodeFromContextMenu(item.kind)}
                    >
                      <NodeIcon kind={item.kind} /> {item.label}
                    </button>
                  ))}
                </div>
              )}

            </div>

            {runSidebarOpen ? (
              <aside className="workflow-run-sidebar" aria-label="워크플로우 실행 현황 사이드바" style={runSidebarStyle}>
                <button
                  type="button"
                  className="workflow-run-sidebar-resize"
                  aria-label="실행 현황 너비 조절"
                  title="실행 현황 너비 조절"
                  onPointerDown={onRunSidebarResize}
                >
                  <GripVertical size={16} />
                </button>
                <button
                  type="button"
                  className="workflow-run-sidebar-close"
                  onClick={() => setRunSidebarOpen(false)}
                  title="실행 현황 접기"
                >
                  <ChevronRight size={15} />
                  접기
                </button>
                <WorkflowRunHistory
                  runs={runs}
                  activeRunId={activeRunId}
                  onSelect={(runId) => focusWorkflowRun(runId, true)}
                  onOpen={(runId) => openWorkflowResultScreen(runId)}
                  onResume={(runId) => void resumeRun(runId)}
                  onPause={pauseRunFromHistory}
                  onStartWaiting={(runId) => void startWaitingRun(runId)}
                  onDeleteQueueEntry={(runId) => void deleteQueueEntry(runId)}
                />
              </aside>
            ) : (
              <aside className="workflow-run-sidebar-rail" aria-label="접힌 실행 현황 사이드바">
                <button
                  type="button"
                  onClick={() => setRunSidebarOpen(true)}
                  aria-expanded={runSidebarOpen}
                  title="실행 현황 펼치기"
                >
                  <ClipboardList size={17} />
                  <span>실행 현황</span>
                  {runs.length > 0 && <small>{runs.length.toLocaleString()}</small>}
                </button>
              </aside>
            )}
          </div>

          {(error || message || validation.errors.length > 0 || validation.warnings.length > 0) && (
            <div className="workflow-validation">
              {error && <span className="danger"><AlertTriangle size={14} /> {error}</span>}
              {message && <span><CheckCircle2 size={14} /> {message}</span>}
              {validation.errors.map((item) => <span key={item} className="danger"><AlertTriangle size={14} /> {item}</span>)}
              {validation.warnings.map((item) => <span key={item}><AlertTriangle size={14} /> {item}</span>)}
            </div>
          )}

          {demoTourStep !== null && (
            <BankPocTour
              currentStep={demoTourStep}
              totalSteps={bankPocTourSteps.length}
              step={bankPocTourSteps[demoTourStep]}
              onSkip={() => setDemoTourStep(null)}
              onNext={() => {
                setDemoTourStep((current) => {
                  if (current === null) return null;
                  const next = current + 1;
                  return next >= bankPocTourSteps.length ? null : next;
                });
              }}
            />
          )}

          {aiDraftOpen && (
            <AiWorkflowDraftDialog
              files={aiDraftFiles}
              persistSamples={aiDraftPersistSamples}
              includeChecklist={aiDraftIncludeChecklist}
              isGenerating={isGeneratingAiDraft}
              onFilesChange={onAiDraftFileInput}
              onPersistSamplesChange={setAiDraftPersistSamples}
              onIncludeChecklistChange={setAiDraftIncludeChecklist}
              onGenerate={() => void generateAiWorkflowDraft()}
              onClose={() => {
                if (!isGeneratingAiDraft) setAiDraftOpen(false);
              }}
            />
          )}

        </section>
      </main>
    </ReactFlowProvider>
  );
}

function BankPocTour(props: {
  currentStep: number;
  totalSteps: number;
  step: { target: DemoTourTarget; title: string; body: string };
  onSkip: () => void;
  onNext: () => void;
}) {
  const isLast = props.currentStep + 1 >= props.totalSteps;
  return (
    <div className={`bank-poc-tour bank-poc-tour-${props.step.target}`} role="dialog" aria-live="polite" aria-label="은행 서류 데모 안내">
      <div className="bank-poc-tour-badge">
        <Sparkles size={15} />
        데모 가이드 {props.currentStep + 1}/{props.totalSteps}
      </div>
      <strong>{props.step.title}</strong>
      <p>{props.step.body}</p>
      <div className="bank-poc-tour-actions">
        <button type="button" className="secondary compact" onClick={props.onSkip}>
          건너뛰기
        </button>
        <button type="button" className="primary compact" onClick={props.onNext}>
          {isLast ? "시작하기" : "다음"}
        </button>
      </div>
    </div>
  );
}

function WorkflowSelectedDocumentsStrip(props: {
  documents: LibraryDocument[];
  onClear: () => void;
}) {
  const visibleDocuments = props.documents.slice(0, 3);
  const hiddenCount = props.documents.length - visibleDocuments.length;
  return (
    <div className="workflow-selected-documents" aria-label="선택된 보관 문서">
      <div className="workflow-selected-documents-head">
        <div>
          <strong>{props.documents.length.toLocaleString()}개 보관 문서 선택됨</strong>
          <span>준비된 문서는 즉시 실행되고 변환 중인 문서는 준비 후 처리됩니다.</span>
        </div>
        <button type="button" className="secondary compact" onClick={props.onClear}>
          <X size={14} />
          비우기
        </button>
      </div>
      <div className="workflow-selected-document-list">
        {visibleDocuments.map((document) => (
          <div key={document.document_id} className="workflow-selected-document">
            <FileJson size={15} />
            <span>{document.filename}</span>
            <small className={document.status}>{workflowStatusLabel(document.status)}</small>
            {(document.source_path || document.library_path) && (
              <em>{document.source_path ? `출처: ${document.source_path}` : document.library_path}</em>
            )}
          </div>
        ))}
        {hiddenCount > 0 && <div className="workflow-selected-document-more">+ {hiddenCount.toLocaleString()}개 더 있음</div>}
      </div>
    </div>
  );
}

function WorkflowNodeAssetEditor(props: {
  selectedNode: WorkflowNode | null;
  classifiers: ClassifierSummary[];
  classifierDraftsByNodeId: Record<string, WorkflowClassifierDraft>;
  schemas: SchemaSummary[];
  schemaDraftsByNodeId: Record<string, WorkflowSchemaDraft>;
  checklists: ChecklistSummary[];
  checklistDraftsByNodeId: Record<string, WorkflowChecklistDraft>;
  onClassifierDraftChange: (nodeId: string, updater: (draft: WorkflowClassifierDraft) => WorkflowClassifierDraft) => void;
  onSchemaDraftChange: (nodeId: string, updater: (draft: WorkflowSchemaDraft) => WorkflowSchemaDraft) => void;
  onChecklistDraftChange: (nodeId: string, updater: (draft: WorkflowChecklistDraft) => WorkflowChecklistDraft) => void;
  onClose: () => void;
}) {
  const node = props.selectedNode;
  if (!node || !workflowNodeHasAssetEditor(node)) {
    return null;
  }

  if (node.data.kind === "classifier") {
    const savedClassifier = props.classifiers.find((classifier) => classifier.id === node.data.config?.classifier_id);
    const classifierDraft = props.classifierDraftsByNodeId[node.id];
    const editableClassifier = classifierDraft ?? classifierSummaryToDraft(savedClassifier);
    if (!editableClassifier) {
      return (
        <section className="workflow-node-asset-editor" aria-label="분류기 편집">
          <div className="workflow-node-asset-head">
            <div>
              <strong>Classifier 편집</strong>
              <span>선택된 classifier가 없습니다.</span>
            </div>
            <div className="workflow-node-asset-actions">
              <button
                type="button"
                className="secondary compact"
                onClick={() => props.onClassifierDraftChange(node.id, (draft) => draft)}
              >
                <Plus size={14} /> 새 classifier 초안
              </button>
              <button type="button" className="icon-only" onClick={props.onClose} aria-label="편집 닫기">
                <X size={15} />
              </button>
            </div>
          </div>
        </section>
      );
    }
    const updateDraft = (updater: (draft: WorkflowClassifierDraft) => WorkflowClassifierDraft) => props.onClassifierDraftChange(node.id, updater);
    return (
      <section className="workflow-node-asset-editor" aria-label="분류기 편집">
        <div className="workflow-node-asset-head">
          <div>
            <strong>Classifier 편집</strong>
            <span>{classifierDraft ? "저장 대기 중인 변경사항" : savedClassifier ? `${savedClassifier.name} 수정` : "새 분류기 초안"}</span>
          </div>
          <div className="workflow-node-asset-actions">
            <button
              type="button"
              className="secondary compact"
              onClick={() =>
                updateDraft((draft) => ({
                  ...draft,
                  classes: [
                    ...draft.classes,
                    {
                      class_name: `class_${draft.classes.length + 1}`,
                      description: "분류 기준을 설명하세요.",
                      signals: []
                    }
                  ]
                }))
              }
            >
              <Plus size={14} /> 클래스 추가
            </button>
            <button type="button" className="icon-only" onClick={props.onClose} aria-label="편집 닫기">
              <X size={15} />
            </button>
          </div>
        </div>
        <div className="module-config-editor workflow-asset-config-editor">
          <div className="module-form-grid workflow-classifier-form-grid">
            <label>
              <span>설정 이름</span>
              <input
                value={editableClassifier.name}
                onChange={(event) => updateDraft((draft) => ({ ...draft, name: event.target.value }))}
                aria-label="classifier 이름"
              />
            </label>
            <label className="module-toggle-row classifier-outcome-note">
              <span>결과 범위</span>
              <strong>{editableClassifier.allow_unknown ? "사용자 정의 class 또는 unknown" : "사용자 정의 class"}</strong>
            </label>
          </div>
          <label>
            <span>설명</span>
            <textarea
              value={editableClassifier.description ?? ""}
              onChange={(event) => updateDraft((draft) => ({ ...draft, description: event.target.value }))}
              aria-label="classifier 설명"
              rows={2}
            />
          </label>
          <label className="module-toggle-row workflow-asset-toggle-row">
            <span>unknown 허용</span>
            <input
              type="checkbox"
              checked={editableClassifier.allow_unknown}
              onChange={(event) => updateDraft((draft) => ({ ...draft, allow_unknown: event.target.checked }))}
            />
          </label>
          <div className="module-section-title workflow-asset-section-title">
            <CheckSquare size={16} />
            <strong>문서 클래스</strong>
          </div>
          <div className="module-table-wrap workflow-asset-table-wrap">
            <table className="module-config-table classifier-table workflow-classifier-config-table">
              <thead>
                <tr>
                  <th>문서 클래스</th>
                  <th>설명</th>
                  <th>판단 신호</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {editableClassifier.classes.map((candidate, index) => (
                  <tr key={`${candidate.class_name}-${index}`}>
                    <td>
                      <input
                        value={candidate.class_name}
                        onChange={(event) => updateDraft((draft) => updateClassifierDraftClass(draft, index, { class_name: event.target.value }))}
                        aria-label="분류 클래스명"
                      />
                    </td>
                    <td>
                      <textarea
                        value={candidate.description ?? ""}
                        onChange={(event) => updateDraft((draft) => updateClassifierDraftClass(draft, index, { description: event.target.value }))}
                        aria-label="분류 클래스 설명"
                      />
                    </td>
                    <td>
                      <textarea
                        value={formatClassifierSignals(candidate.signals ?? [])}
                        onChange={(event) => updateDraft((draft) => updateClassifierDraftClass(draft, index, { signals: parseClassifierSignals(event.target.value) }))}
                        aria-label="분류 시그널"
                        placeholder="쉼표 또는 줄바꿈으로 구분"
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="icon-only danger-plain"
                        onClick={() => updateDraft((draft) => ({ ...draft, classes: draft.classes.filter((_, classIndex) => classIndex !== index) }))}
                        disabled={editableClassifier.classes.length <= 1}
                        aria-label="분류 클래스 삭제"
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    );
  }

  if (node.data.kind === "kie") {
    const savedSchema = props.schemas.find((schema) => schema.id === node.data.config?.schema_id);
    const schemaDraft = props.schemaDraftsByNodeId[node.id];
    const editableSchema = schemaDraft ?? schemaSummaryToDraft(savedSchema);
    if (!editableSchema) {
      return (
        <section className="workflow-node-asset-editor">
          <div className="workflow-node-asset-head">
            <div>
              <strong>Schema 편집</strong>
              <span>선택된 schema가 없습니다.</span>
            </div>
            <div className="workflow-node-asset-actions">
              <button
                type="button"
                className="secondary compact"
                onClick={() => props.onSchemaDraftChange(node.id, (draft) => draft)}
              >
                <Plus size={14} /> 새 schema 초안
              </button>
              <button type="button" className="icon-only" onClick={props.onClose} aria-label="편집 닫기">
                <X size={15} />
              </button>
            </div>
          </div>
        </section>
      );
    }
    const updateDraft = (updater: (draft: WorkflowSchemaDraft) => WorkflowSchemaDraft) => props.onSchemaDraftChange(node.id, updater);
    return (
      <section className="workflow-node-asset-editor">
        <div className="workflow-node-asset-head">
          <div>
            <strong>Schema 편집</strong>
            <span>{schemaDraft ? "저장 대기 중인 변경사항" : savedSchema ? `${savedSchema.name} 수정` : "AI 생성 초안"}</span>
          </div>
          <div className="workflow-node-asset-actions">
            <button
              type="button"
              className="secondary compact"
              onClick={() =>
                updateDraft((draft) => ({
                  ...draft,
                  fields: [
                    ...draft.fields,
                    {
                      key_name: `field_${draft.fields.length + 1}`,
                      description: "추출할 값을 설명하세요.",
                      output_format: "string"
                    }
                  ]
                }))
              }
            >
              <Plus size={14} /> 필드 추가
            </button>
            <button type="button" className="icon-only" onClick={props.onClose} aria-label="편집 닫기">
              <X size={15} />
            </button>
          </div>
        </div>
        <div className="module-config-editor workflow-asset-config-editor">
          <div className="module-form-grid workflow-schema-form-grid">
            <label>
              <span>Schema 이름</span>
              <input
                value={editableSchema.name}
                onChange={(event) => updateDraft((draft) => ({ ...draft, name: event.target.value }))}
                aria-label="schema 이름"
              />
            </label>
            <label>
              <span>표시 이름</span>
              <input
                value={editableSchema.display_name ?? ""}
                onChange={(event) => updateDraft((draft) => ({ ...draft, display_name: event.target.value }))}
                aria-label="schema 표시 이름"
              />
            </label>
            <label>
              <span>설명</span>
              <textarea
                value={editableSchema.description ?? ""}
                onChange={(event) => updateDraft((draft) => ({ ...draft, description: event.target.value }))}
                aria-label="schema 설명"
                rows={2}
              />
            </label>
          </div>
          <div className="module-section-title workflow-asset-section-title">
            <Sparkles size={16} />
            <strong>Schema 필드</strong>
          </div>
          <div className="module-table-wrap workflow-asset-table-wrap">
            <table className="module-config-table workflow-schema-config-table">
              <thead>
                <tr>
                  <th>필드명</th>
                  <th>설명</th>
                  <th>타입</th>
                  <th>영역</th>
                  <th>AI 검수</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {editableSchema.fields.map((field, index) => (
                  <tr key={`${field.key_name}-${index}`}>
                    <td>
                      <input
                        value={field.key_name}
                        onChange={(event) => updateDraft((draft) => updateSchemaDraftField(draft, index, { key_name: event.target.value }))}
                        aria-label="필드명"
                      />
                    </td>
                    <td>
                      <textarea
                        className="schema-description-input"
                        value={field.description}
                        onChange={(event) => updateDraft((draft) => updateSchemaDraftField(draft, index, { description: event.target.value }))}
                        aria-label="필드 설명"
                      />
                    </td>
                    <td>
                      <select
                        value={field.output_format}
                        onChange={(event) => updateDraft((draft) => updateSchemaDraftField(draft, index, { output_format: event.target.value as WorkflowOutputFormat }))}
                        aria-label="출력 형식"
                      >
                        <option value="string">string</option>
                        <option value="float">float</option>
                        <option value="bool">bool</option>
                        <option value="date">date</option>
                      </select>
                    </td>
                    <td>
                      <select
                        value={field.region_id ?? ""}
                        onChange={(event) => updateDraft((draft) => updateSchemaDraftField(draft, index, { region_id: event.target.value || null }))}
                        aria-label="영역"
                      >
                        <option value="">-</option>
                        {(editableSchema.regions ?? []).map((region) => (
                          <option key={region.id} value={region.id}>
                            {region.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <label className="workflow-table-toggle">
                        <input
                          type="checkbox"
                          checked={Boolean(field.judgement_enabled)}
                          onChange={(event) => updateDraft((draft) => updateSchemaDraftField(draft, index, { judgement_enabled: event.target.checked }))}
                        />
                        <span>{field.judgement_enabled ? "사용" : "미사용"}</span>
                      </label>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="icon-only danger-plain"
                        onClick={() => updateDraft((draft) => ({ ...draft, fields: draft.fields.filter((_, fieldIndex) => fieldIndex !== index) }))}
                        disabled={editableSchema.fields.length <= 1}
                        aria-label="필드 삭제"
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    );
  }

  if (node.data.kind === "required-checker") {
    const savedChecklist = props.checklists.find((checklist) => checklist.id === node.data.config?.checklist_id);
    const checklistDraft = props.checklistDraftsByNodeId[node.id];
    const editableChecklist = checklistDraft ?? checklistSummaryToDraft(savedChecklist);
    if (!editableChecklist) {
      return (
        <section className="workflow-node-asset-editor">
          <div className="workflow-node-asset-head">
            <div>
              <strong>Checklist 편집</strong>
              <span>선택된 checklist가 없습니다.</span>
            </div>
            <div className="workflow-node-asset-actions">
              <button
                type="button"
                className="secondary compact"
                onClick={() => props.onChecklistDraftChange(node.id, (draft) => draft)}
              >
                <Plus size={14} /> 새 checklist 초안
              </button>
              <button type="button" className="icon-only" onClick={props.onClose} aria-label="편집 닫기">
                <X size={15} />
              </button>
            </div>
          </div>
        </section>
      );
    }
    const updateDraft = (updater: (draft: WorkflowChecklistDraft) => WorkflowChecklistDraft) => props.onChecklistDraftChange(node.id, updater);
    return (
      <section className="workflow-node-asset-editor compact-list">
        <div className="workflow-node-asset-head">
          <div>
            <strong>Checklist 편집</strong>
            <span>{checklistDraft ? "저장 대기 중인 변경사항" : savedChecklist ? `${savedChecklist.name} 수정` : "새 checklist 초안"} · {editableChecklist.items.length.toLocaleString()}개 항목</span>
          </div>
          <div className="workflow-node-asset-actions">
            <button
              type="button"
              className="secondary compact"
              onClick={() =>
                updateDraft((draft) => ({
                  ...draft,
                  items: [
                    ...draft.items,
                    {
                      item_name: `항목 ${draft.items.length + 1}`,
                      description: "확인할 항목을 설명하세요.",
                      evidence_type: "text_or_handwriting",
                      required: true
                    }
                  ]
                }))
              }
            >
              <Plus size={14} /> 항목 추가
            </button>
            <button type="button" className="icon-only" onClick={props.onClose} aria-label="편집 닫기">
              <X size={15} />
            </button>
          </div>
        </div>
        <div className="module-config-editor workflow-asset-config-editor">
          <div className="module-form-grid workflow-checklist-form-grid">
            <label>
              <span>설정 이름</span>
              <input
                value={editableChecklist.name}
                onChange={(event) => updateDraft((draft) => ({ ...draft, name: event.target.value }))}
                aria-label="checklist 이름"
              />
            </label>
            <label>
              <span>설명</span>
              <textarea
                value={editableChecklist.description ?? ""}
                onChange={(event) => updateDraft((draft) => ({ ...draft, description: event.target.value }))}
                aria-label="checklist 설명"
                rows={2}
              />
            </label>
          </div>
          <div className="module-section-title workflow-asset-section-title">
            <CheckSquare size={16} />
            <strong>필요 부분 체크</strong>
          </div>
          <div className="module-table-wrap workflow-asset-table-wrap">
            <table className="module-config-table checklist-table workflow-checklist-config-table">
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
                {editableChecklist.items.map((item, index) => (
                  <tr key={`${item.item_name}-${index}`}>
                    <td>
                      <input
                        value={item.item_name}
                        onChange={(event) => updateDraft((draft) => updateChecklistDraftItem(draft, index, { item_name: event.target.value }))}
                        aria-label="체크리스트 항목명"
                      />
                    </td>
                    <td>
                      <textarea
                        value={item.description ?? ""}
                        onChange={(event) => updateDraft((draft) => updateChecklistDraftItem(draft, index, { description: event.target.value }))}
                        aria-label="체크리스트 설명"
                      />
                    </td>
                    <td>
                      <div className="evidence-type-control">
                        <select
                          value={workflowEvidenceTypeIsPreset(item.evidence_type || "text_or_handwriting") ? item.evidence_type || "text_or_handwriting" : WORKFLOW_CUSTOM_EVIDENCE_TYPE_VALUE}
                          onChange={(event) =>
                            updateDraft((draft) => updateChecklistDraftItem(draft, index, { evidence_type: event.target.value === WORKFLOW_CUSTOM_EVIDENCE_TYPE_VALUE ? "" : event.target.value }))
                          }
                          aria-label="증거 타입"
                        >
                          {WORKFLOW_EVIDENCE_TYPES.map((type) => (
                            <option key={type} value={type}>
                              {WORKFLOW_EVIDENCE_TYPE_LABELS[type]}
                            </option>
                          ))}
                          <option value={WORKFLOW_CUSTOM_EVIDENCE_TYPE_VALUE}>직접 입력</option>
                        </select>
                        {!workflowEvidenceTypeIsPreset(item.evidence_type || "text_or_handwriting") && (
                          <input
                            value={item.evidence_type || ""}
                            placeholder="증거 유형 입력"
                            onChange={(event) => updateDraft((draft) => updateChecklistDraftItem(draft, index, { evidence_type: event.target.value }))}
                            aria-label="직접 입력 증거 타입"
                          />
                        )}
                      </div>
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={item.required ?? true}
                        onChange={(event) => updateDraft((draft) => updateChecklistDraftItem(draft, index, { required: event.target.checked }))}
                        aria-label="필수 여부"
                      />
                    </td>
                    <td>
                      <select
                        value={item.region_id ?? ""}
                        onChange={(event) => updateDraft((draft) => updateChecklistDraftItem(draft, index, { region_id: event.target.value || null }))}
                        aria-label="체크리스트 영역"
                      >
                        <option value="">-</option>
                        {(editableChecklist.regions ?? []).map((region) => (
                          <option key={region.id} value={region.id}>
                            {region.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="icon-only danger-plain"
                        onClick={() => updateDraft((draft) => ({ ...draft, items: draft.items.filter((_, itemIndex) => itemIndex !== index) }))}
                        disabled={editableChecklist.items.length <= 1}
                        aria-label="체크리스트 항목 삭제"
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    );
  }
  return null;
}

function AiWorkflowDraftDialog(props: {
  files: File[];
  persistSamples: boolean;
  includeChecklist: boolean;
  isGenerating: boolean;
  onFilesChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onPersistSamplesChange: (value: boolean) => void;
  onIncludeChecklistChange: (value: boolean) => void;
  onGenerate: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-panel ai-workflow-draft-dialog" role="dialog" aria-modal="true" aria-label="AI 워크플로우 생성">
        <div className="modal-header">
          <div>
            <p className="eyebrow">AI Workflow Draft</p>
            <h2>샘플로 워크플로우 생성</h2>
          </div>
          <button type="button" className="icon-only" onClick={props.onClose} aria-label="닫기" disabled={props.isGenerating}>
            <X size={18} />
          </button>
        </div>
        <label className="ai-workflow-dropzone">
          <Sparkles size={22} />
          <strong>{props.files.length ? `${props.files.length.toLocaleString()}개 이미지 선택됨` : "샘플 이미지 선택"}</strong>
          <span>PNG/JPG 최대 {WORKFLOW_AI_DRAFT_MAX_IMAGES}장</span>
          <input type="file" multiple accept={WORKFLOW_AI_DRAFT_ACCEPT} onChange={props.onFilesChange} disabled={props.isGenerating} />
        </label>
        {props.files.length > 0 && (
          <div className="ai-workflow-file-list">
            {props.files.map((file) => (
              <span key={`${file.name}-${file.lastModified}`}>{file.name}</span>
            ))}
          </div>
        )}
        <div className="ai-workflow-options">
          <label className="ai-workflow-option">
            <input
              type="checkbox"
              checked={props.includeChecklist}
              onChange={(event) => props.onIncludeChecklistChange(event.target.checked)}
              disabled={props.isGenerating}
            />
            <span>필수 항목 확인 초안 포함</span>
          </label>
          <label className="ai-workflow-option">
            <input
              type="checkbox"
              checked={props.persistSamples}
              onChange={(event) => props.onPersistSamplesChange(event.target.checked)}
              disabled={props.isGenerating}
            />
            <span>샘플 문서를 보관함에 저장</span>
          </label>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={props.onClose} disabled={props.isGenerating}>
            취소
          </button>
          <button type="button" className="primary" onClick={props.onGenerate} disabled={props.isGenerating || !props.files.length}>
            {props.isGenerating ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
            생성
          </button>
        </div>
      </section>
    </div>
  );
}

export function WorkflowRunResultWindow({ runId }: { runId: string }) {
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedDocument, setSelectedDocument] = useState<WorkflowDocument | null>(null);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [activeDocumentPage, setActiveDocumentPage] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const selectedItem = run?.items.find((item) => item.id === selectedItemId) ?? run?.items[0] ?? null;

  useEffect(() => {
    void refreshRun();
  }, [runId]);

  useEffect(() => {
    if (!run || TERMINAL_RUN_STATUSES.includes(run.status)) return;
    const timer = window.setInterval(() => void refreshRun(), 1200);
    return () => window.clearInterval(timer);
  }, [run?.id, run?.status]);

  useEffect(() => {
    let canceled = false;
    setActiveDocumentPage(0);
    setSelectedDocument(null);
    if (!selectedItem?.document_id) return;
    setDocumentLoading(true);
    api<WorkflowDocument>(`/api/documents/${selectedItem.document_id}`)
      .then((document) => {
        if (!canceled) setSelectedDocument(document);
      })
      .catch((exc) => {
        if (!canceled) setError(exc instanceof Error ? exc.message : "문서 preview를 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!canceled) setDocumentLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [selectedItem?.document_id]);

  async function refreshRun() {
    try {
      const nextRun = await api<WorkflowRun>(`/api/workflow-runs/${runId}`);
      setRun(nextRun);
      setSelectedItemId((current) => current ?? nextRun.items[0]?.id ?? null);
      setError(null);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "워크플로우 실행 결과를 불러오지 못했습니다.");
    }
  }

  async function resumeRun() {
    try {
      const nextRun = await api<WorkflowRun>(`/api/workflow-runs/${runId}/resume`, { method: "POST" });
      setRun(nextRun);
      setSelectedItemId((current) => current ?? nextRun.items[0]?.id ?? null);
      setError(null);
      void refreshRun();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "워크플로우를 계속 처리하지 못했습니다.");
    }
  }

  async function pauseRun() {
    try {
      const nextRun = await api<WorkflowRun>(`/api/workflow-runs/${runId}/pause`, { method: "POST" });
      setRun(nextRun);
      setError(null);
      void refreshRun();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "워크플로우를 일시중단하지 못했습니다.");
    }
  }

  async function startWaitingRun() {
    try {
      const nextRun = await api<WorkflowRun>(`/api/workflow-runs/${runId}/start`, { method: "POST" });
      setRun(nextRun);
      setSelectedItemId((current) => current ?? nextRun.items[0]?.id ?? null);
      setError(null);
      void refreshRun();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "대기 중인 워크플로우 실행을 시작하지 못했습니다.");
    }
  }

  async function deleteQueueEntry() {
    try {
      await api<{ status: string; id: string }>(`/api/workflow-runs/${runId}/queue-entry`, { method: "DELETE" });
      setError(null);
      closeWindow();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "대기열 항목을 삭제하지 못했습니다.");
    }
  }

  async function retryFailedRun() {
    try {
      const nextRun = await api<WorkflowRun>(`/api/workflow-runs/${runId}/retry-failed`, { method: "POST" });
      setRun(nextRun);
      setSelectedItemId((current) => current ?? nextRun.items[0]?.id ?? null);
      setError(null);
      void refreshRun();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "실패한 항목을 재시도하지 못했습니다.");
    }
  }

  async function discardRun() {
    try {
      const nextRun = await api<WorkflowRun>(`/api/workflow-runs/${runId}/discard`, { method: "POST" });
      setRun(nextRun);
      setSelectedItemId(null);
      setSelectedDocument(null);
      setError(null);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "워크플로우 실행을 중단하지 못했습니다.");
    }
  }

  function closeWindow() {
    window.location.hash = "workflow";
  }

  return (
    <main className="workflow-result-window">
      {error && <div className="alert">{error}</div>}
      {run ? (
        <WorkflowRunResults
          run={run}
          selectedItem={selectedItem}
          document={selectedDocument}
          documentLoading={documentLoading}
          activePage={activeDocumentPage}
          onSelectItem={(itemId) => setSelectedItemId(itemId)}
          onPage={setActiveDocumentPage}
          onResume={() => void resumeRun()}
          onPause={() => void pauseRun()}
          onStartWaiting={() => void startWaitingRun()}
          onDeleteQueueEntry={() => void deleteQueueEntry()}
          onRetryFailed={() => void retryFailedRun()}
          onDiscard={() => void discardRun()}
          onClose={closeWindow}
        />
      ) : (
        <section className="workflow-results">
          <div className="workflow-preview-empty">워크플로우 실행 결과를 불러오는 중입니다.</div>
        </section>
      )}
    </main>
  );
}

function WorkflowCanvasNode({ id, data, selected }: NodeProps<WorkflowNode>) {
  const kind = data.kind;
  const branchKeys = normalizeBranchKeys(data.branchKeys);
  const connectedBranchKeys = new Set(data.connectedBranchKeys ?? []);
  return (
    <div
      className={`workflow-node workflow-node-${kind} ${data.configSelect ? "workflow-node-configurable" : ""} ${selected ? "selected" : ""}`}
      onClick={(event) => data.onSelect?.(event, id)}
    >
      {kind !== "input" && <Handle className="workflow-handle workflow-handle-target" type="target" position={Position.Left} />}
      <div className="workflow-node-title">
        <NodeIcon kind={kind} />
        <strong>{data.label}</strong>
      </div>
      <span>{nodeKindDescription(kind)}</span>
      {data.configSelect && (
        <label
          className="workflow-node-config nodrag nowheel"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <small>{data.configSelect.label}</small>
          <select
            value={data.configSelect.value}
            onChange={(event) => data.onConfigChange?.(id, data.configSelect!.key, event.target.value)}
          >
            <option value="">{data.configSelect.placeholder}</option>
            {data.configSelect.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind === "branch" ? (
        <>
          <div className="branch-handles">
            {branchKeys.map((key) => (
              <div key={key} className={`branch-handle-row ${connectedBranchKeys.has(key) ? "connected" : "missing"}`}>
                <span
                  className="branch-route-dot"
                  title={connectedBranchKeys.has(key) ? "후속 노드 연결됨" : "후속 노드 없음 · 분류 결과만 export"}
                />
                <small>{branchKeyLabel(key)}</small>
              </div>
            ))}
          </div>
          {branchKeys.map((key, index) => (
            <Handle
              key={key}
              id={key}
              className="workflow-handle workflow-handle-branch-source"
              type="source"
              position={Position.Right}
              style={{ top: 76 + index * 26 }}
            />
          ))}
        </>
      ) : kind !== "export" ? (
        <Handle className="workflow-handle workflow-handle-source" type="source" position={Position.Right} />
      ) : null}
    </div>
  );
}

function WorkflowUploadButton(props: {
  disabled: boolean;
  selectedCount: number;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const menu = useWorkflowUploadMenu();
  const triggerLabel = props.selectedCount ? `${props.selectedCount.toLocaleString()}개 파일 선택됨` : "업로드";
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    menu.close();
    props.onChange(event);
  };

  return (
    <div className="workflow-upload-picker" ref={menu.ref}>
      <button
        type="button"
        className="workflow-upload"
        disabled={props.disabled}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
      >
        <UploadCloud size={17} />
        <span>{triggerLabel}</span>
      </button>
      {menu.open && !props.disabled && (
        <div className="workflow-upload-menu workflow-upload-menu-fixed" role="menu" style={menu.menuStyle}>
          <label className="workflow-upload-menu-item" role="menuitem">
            파일 선택
            <input type="file" multiple accept={WORKFLOW_FILE_ACCEPT} onChange={onChange} />
          </label>
          <label className="workflow-upload-menu-item" role="menuitem">
            폴더 선택
            <input
              type="file"
              multiple
              accept={WORKFLOW_FILE_ACCEPT}
              onChange={onChange}
              {...{ webkitdirectory: "", directory: "" }}
            />
          </label>
        </div>
      )}
    </div>
  );
}

function WorkflowResumeUploadButton(props: {
  onSelect: (source: WorkflowUploadSource) => void;
}) {
  const menu = useWorkflowUploadMenu("right");
  const select = (source: WorkflowUploadSource) => {
    menu.close();
    props.onSelect(source);
  };

  return (
    <div className="workflow-upload-picker" ref={menu.ref}>
      <button
        type="button"
        className="secondary"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
      >
        <UploadCloud size={15} /> 이어가기
      </button>
      {menu.open && (
        <div className="workflow-upload-menu workflow-upload-menu-right workflow-upload-menu-fixed" role="menu" style={menu.menuStyle}>
          <button type="button" className="workflow-upload-menu-item" role="menuitem" onClick={() => select("files")}>
            파일 선택
          </button>
          <button type="button" className="workflow-upload-menu-item" role="menuitem" onClick={() => select("folder")}>
            폴더 선택
          </button>
        </div>
      )}
    </div>
  );
}

function WorkflowRunExportButton(props: {
  runId: string;
  compact?: boolean;
  title?: string;
}) {
  const menu = useWorkflowUploadMenu("right");
  const [pendingFormat, setPendingFormat] = useState<ExportFormat | null>(null);
  const buttonClass = props.compact ? "secondary compact" : "secondary";
  const iconSize = props.compact ? 14 : 15;
  const formats: { format: ExportFormat; label: string }[] = [
    { format: "csv", label: "CSV" },
    { format: "json", label: "JSON" },
    { format: "xlsx", label: "XLSX" }
  ];
  const onExport = async (format: ExportFormat) => {
    if (pendingFormat) return;
    menu.close();
    setPendingFormat(format);
    try {
      await createAndDownloadExportJob("workflow_run", props.runId, format);
    } catch (exc) {
      window.alert(exc instanceof Error ? exc.message : "Export 요청에 실패했습니다.");
    } finally {
      setPendingFormat(null);
    }
  };

  return (
    <div className="workflow-upload-picker" ref={menu.ref}>
      <button type="button" className={buttonClass} aria-haspopup="menu" aria-expanded={menu.open} onClick={menu.toggle} title={props.title} disabled={pendingFormat !== null}>
        {pendingFormat ? <Loader2 size={iconSize} className="spin" /> : <Download size={iconSize} />} Export
      </button>
      {menu.open && (
        <div className="workflow-upload-menu workflow-upload-menu-right workflow-upload-menu-fixed" role="menu" style={menu.menuStyle}>
          {formats.map((item) => (
            <button
              key={item.format}
              type="button"
              className="workflow-upload-menu-item"
              role="menuitem"
              disabled={pendingFormat !== null}
              onClick={() => void onExport(item.format)}
            >
              {pendingFormat === item.format ? <Loader2 size={iconSize} className="spin" /> : exportFormatIcon(item.format, iconSize)} {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function useWorkflowUploadMenu(placement: "left" | "right" = "left") {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const ref = useRef<HTMLDivElement | null>(null);
  const updatePosition = useCallback(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const top = Math.round(rect.bottom + 6);
    if (placement === "right") {
      setMenuStyle({ top, right: Math.max(8, Math.round(window.innerWidth - rect.right)) });
      return;
    }
    setMenuStyle({ top, left: Math.max(8, Math.round(rect.left)) });
  }, [placement]);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (event.target instanceof globalThis.Node && ref.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onPositionChange = () => updatePosition();
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onPositionChange);
    window.addEventListener("scroll", onPositionChange, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onPositionChange);
      window.removeEventListener("scroll", onPositionChange, true);
    };
  }, [open, updatePosition]);

  return {
    open,
    ref,
    menuStyle,
    close: () => setOpen(false),
    toggle: () => {
      updatePosition();
      setOpen((current) => !current);
    }
  };
}

function exportFormatIcon(format: ExportFormat, size: number) {
  if (format === "json") return <FileJson size={size} />;
  if (format === "xlsx") return <FileSpreadsheet size={size} />;
  return <Download size={size} />;
}

function WorkflowRunProgressDock(props: {
  run: WorkflowRun;
  canStartWaiting?: boolean;
  onOpen: () => void;
  onResume: () => void;
  onPause: () => void;
  onStartWaiting: () => void;
  onDeleteQueueEntry: () => void;
  onResumeUpload: (source: WorkflowUploadSource) => void;
  onDiscard: () => void;
}) {
  const finishedCount = workflowRunFinishedCount(props.run);
  const uploadedCount = props.run.uploaded_count ?? props.run.items.length;
  const preprocessingCount = props.run.preprocessing_count ?? props.run.items.filter((item) => item.status === "preprocessing").length;
  const runningCount = props.run.running_count ?? props.run.items.filter((item) => item.status === "running").length;
  const queuedCount = props.run.queued_count ?? props.run.items.filter((item) => item.status === "queued").length;
  const percent = Math.round(props.run.progress * 100);
  return (
    <div className={`workflow-progress-dock ${workflowRunStatusClass(props.run)}`} aria-label="워크플로우 실행 진행상황">
      <div className="workflow-progress-dock-head">
        <div>
          <p className="eyebrow">Run</p>
          <h3>{props.run.workflow_name || "워크플로우"} · {workflowRunHeadline(props.run)} · {percent}%</h3>
        </div>
        <div className="workflow-run-kpis">
          <span><strong>{uploadedCount}</strong> / {props.run.total_count.toLocaleString()} 업로드됨</span>
          {preprocessingCount ? <span><strong>{preprocessingCount}</strong> 전처리 중</span> : null}
          <span><strong>{runningCount}</strong> 처리 중</span>
          <span><strong>{queuedCount}</strong> 대기</span>
          <span><strong>{props.run.vlm_active_count ?? 0}{props.run.vlm_limit ? ` / ${props.run.vlm_limit}` : ""}</strong> AI 요청 중</span>
          <span><strong>{props.run.vlm_waiting_count ?? 0}</strong> AI 요청 대기</span>
          <span><strong>{finishedCount}</strong> 완료/검토/실패</span>
          <span><strong>{formatDurationMs(props.run.upload_duration_ms)}</strong> 업로드</span>
          <span><strong>{formatDurationMs(props.run.inference_duration_ms)}</strong> 추론</span>
          <span><strong>{workflowRunStartedAtLabel(props.run)}</strong> 시작</span>
          <span><strong>{workflowRunCompletedAtLabel(props.run)}</strong> 종료</span>
        </div>
        <div className="workflow-progress-dock-actions">
          <button type="button" className="secondary" onClick={props.onOpen}>
            <Maximize2 size={15} /> 결과 상세보기
          </button>
          {workflowRunCanResumeUpload(props.run) && (
            <WorkflowResumeUploadButton onSelect={props.onResumeUpload} />
          )}
          {workflowRunCanResume(props.run) && (
            <button type="button" className="secondary" onClick={props.onResume}>
              <Play size={15} /> 이어하기
            </button>
          )}
          {workflowRunCanPause(props.run) && (
            <button type="button" className="secondary" onClick={props.onPause}>
              <Pause size={15} /> 추론 일시중단
            </button>
          )}
          {workflowRunCanStartWaiting(props.run) && props.canStartWaiting !== false && (
            <button type="button" className="secondary" onClick={props.onStartWaiting}>
              <Play size={15} /> 바로 실행
            </button>
          )}
          {workflowRunCanDeleteQueueEntry(props.run) && (
            <button type="button" className="secondary danger-outline" onClick={props.onDeleteQueueEntry}>
              <X size={15} /> {workflowRunDeleteQueueEntryLabel(props.run)}
            </button>
          )}
          {workflowRunCanDiscard(props.run) && (
            <button type="button" className="secondary danger-outline" onClick={props.onDiscard}>
              <X size={15} /> 추론 중단
            </button>
          )}
        </div>
      </div>
      <progress className={`workflow-run-progress ${workflowRunStatusClass(props.run)}`} value={props.run.progress} max={1} />
    </div>
  );
}

function WorkflowRunPreparingDock(props: {
  fileCount: number;
  message: string;
  onDiscard: () => void;
}) {
  return (
    <div className="workflow-progress-dock workflow-progress-dock-preparing" aria-label="워크플로우 실행 준비상황">
      <div className="workflow-progress-dock-head">
        <div>
          <p className="eyebrow">Run</p>
          <h3>{props.message}</h3>
        </div>
        <div className="workflow-run-kpis">
          <span><strong>{props.fileCount.toLocaleString()}</strong> 선택됨</span>
          <span><strong>0</strong> 완료</span>
          <span><strong>{props.fileCount.toLocaleString()}</strong> 준비 중</span>
        </div>
        <div className="workflow-progress-dock-actions">
          <button type="button" className="secondary danger-outline" onClick={props.onDiscard}>
            <X size={15} /> 시작 중단
          </button>
        </div>
      </div>
      <progress className="workflow-run-progress workflow-run-progress-indeterminate" />
    </div>
  );
}

function WorkflowRunHistory(props: {
  runs: WorkflowRun[];
  activeRunId: string;
  onSelect: (runId: string) => void;
  onOpen: (runId: string) => void;
  onResume: (runId: string) => void;
  onPause: (runId: string) => void;
  onStartWaiting: (runId: string) => void;
  onDeleteQueueEntry: (runId: string) => void;
}) {
  return (
    <section className="workflow-run-history" aria-label="워크플로우 실행 현황">
      <div className="workflow-run-history-head">
        <div>
          <p className="eyebrow">현황</p>
          <h3>실행 현황</h3>
        </div>
      </div>
      {props.runs.length ? (
        <div className="workflow-run-history-list">
          {props.runs.map((run) => {
            const finishedCount = workflowRunFinishedCount(run);
            const isActive = run.id === props.activeRunId;
            const percent = Math.round(run.progress * 100);
            const failureSummary = workflowRunFailureSummary(run);
            return (
              <article
                key={run.id}
                className={`workflow-run-history-item ${workflowRunStatusClass(run)} ${isActive ? "active" : ""}`}
                role="button"
                aria-current={isActive ? "true" : undefined}
                tabIndex={0}
                onClick={() => props.onSelect(run.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    props.onSelect(run.id);
                  }
                }}
              >
                <div className="workflow-run-history-main">
                  <span className="workflow-run-history-status">{workflowRunStatusLabel(run)}</span>
                  <strong>{run.workflow_name || "워크플로우"} · {workflowRunHeadline(run)}</strong>
                  <small>
                    등록 {formatWorkflowRunDate(run.created_at)} · 시작 {workflowRunStartedAtLabel(run)} · 종료 {workflowRunCompletedAtLabel(run)}
                  </small>
                  <small>
                    {finishedCount.toLocaleString()} / {run.total_count.toLocaleString()} 처리
                    {run.restarted_from_run_id ? " · 새 실행" : ""}
                    {workflowRunQueueMeta(run)}
                    {run.queue_order ? ` · 예약 순서 #${run.queue_order}` : ""}
                    {run.failed_count ? ` · ${run.failed_count.toLocaleString()} 실패` : ""}
                    {run.needs_review_count ? ` · ${run.needs_review_count.toLocaleString()} 검토` : ""}
                  </small>
                  {failureSummary && <small className="workflow-run-history-error">실패 사유 · {failureSummary}</small>}
                  <div className="workflow-run-history-progress" aria-label={`${percent}%`}>
                    <div><span style={{ width: `${percent}%` }} /></div>
                    <em>{percent}%</em>
                  </div>
                </div>
                <div
                  className="workflow-run-history-actions"
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  {workflowRunCanResume(run) && (
                    <button type="button" className="secondary" onClick={() => props.onResume(run.id)}>
                      <Play size={14} /> 이어하기
                    </button>
                  )}
                  {workflowRunCanPause(run) && (
                    <button type="button" className="secondary" onClick={() => props.onPause(run.id)}>
                      <Pause size={14} /> 추론 일시중단
                    </button>
                  )}
                  {workflowRunCanStartWaiting(run, props.runs) && (
                    <button type="button" className="secondary" onClick={() => props.onStartWaiting(run.id)}>
                      <Play size={14} /> 바로 실행
                    </button>
                  )}
                  {workflowRunCanDeleteQueueEntry(run) && (
                    <button type="button" className="secondary danger-outline" onClick={() => props.onDeleteQueueEntry(run.id)}>
                      <X size={14} /> {workflowRunDeleteQueueEntryLabel(run)}
                    </button>
                  )}
                  <button type="button" className="secondary" onClick={() => props.onOpen(run.id)}>
                    <Maximize2 size={14} /> 결과 보기
                  </button>
                  <WorkflowRunExportButton runId={run.id} compact />
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="workflow-run-history-empty">
          <History size={18} />
          <span>아직 실행 작업이 없습니다.</span>
        </div>
      )}
    </section>
  );
}

function WorkflowRunResults(props: {
  run: WorkflowRun;
  selectedItem: WorkflowRunItem | null;
  document: WorkflowDocument | null;
  documentLoading: boolean;
  activePage: number;
  onSelectItem: (itemId: string) => void;
  onPage: (page: number) => void;
  onResume?: () => void;
  onPause?: () => void;
  onStartWaiting?: () => void;
  onDeleteQueueEntry?: () => void;
  onRetryFailed?: () => void;
  onDiscard?: () => void;
  onClose: () => void;
}) {
  const finishedCount = workflowRunFinishedCount(props.run);
  const [statusFilter, setStatusFilter] = useState<WorkflowResultFilter>("all");
  const [classFilter, setClassFilter] = useState("all");
  const [leftWidth, setLeftWidth] = useState(() => readWorkflowResultPaneWidth(WORKFLOW_RESULT_LEFT_WIDTH_KEY, 280));
  const [rightWidth, setRightWidth] = useState(() => readWorkflowResultPaneWidth(WORKFLOW_RESULT_RIGHT_WIDTH_KEY, 420));
  const statusScopedItems = useMemo(
    () => props.run.items.filter((item) => workflowResultFilterMatches(item, statusFilter)),
    [props.run.items, statusFilter]
  );
  const classScopedItems = useMemo(
    () => props.run.items.filter((item) => workflowClassFilterMatches(item, classFilter)),
    [props.run.items, classFilter]
  );
  const filteredItems = useMemo(
    () => props.run.items.filter((item) => workflowResultFilterMatches(item, statusFilter) && workflowClassFilterMatches(item, classFilter)),
    [classFilter, props.run.items, statusFilter]
  );
  const reviewItems = useMemo(() => props.run.items.filter((item) => item.status === "needs_review"), [props.run.items]);
  const visibleSelectedItem =
    props.selectedItem && filteredItems.some((item) => item.id === props.selectedItem?.id)
      ? props.selectedItem
      : filteredItems[0] ?? null;
  const filterCounts = useMemo(() => workflowResultFilterCounts(classScopedItems), [classScopedItems]);
  const classFilterOptions = useMemo(() => workflowClassFilterOptions(statusScopedItems), [statusScopedItems]);
  const workbenchStyle = useMemo<CSSProperties>(
    () => ({
      gridTemplateColumns: `${leftWidth}px ${WORKFLOW_RESULT_SPLITTER_WIDTH}px minmax(${WORKFLOW_RESULT_MIN_MIDDLE_WIDTH}px, 1fr) ${WORKFLOW_RESULT_SPLITTER_WIDTH}px ${rightWidth}px`
    }),
    [leftWidth, rightWidth]
  );

  useEffect(() => {
    if (!filteredItems.length) return;
    if (!props.selectedItem || !filteredItems.some((item) => item.id === props.selectedItem?.id)) {
      props.onSelectItem(filteredItems[0].id);
    }
  }, [filteredItems, props.selectedItem?.id, props.onSelectItem]);

  useEffect(() => {
    if (classFilter !== "all" && !classFilterOptions.some((option) => option.value === classFilter)) {
      setClassFilter("all");
    }
  }, [classFilter, classFilterOptions]);

  const onLeftResize = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    startWorkflowResultResize(event, "left", leftWidth, rightWidth, setLeftWidth, setRightWidth);
  }, [leftWidth, rightWidth]);
  const onRightResize = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    startWorkflowResultResize(event, "right", leftWidth, rightWidth, setLeftWidth, setRightWidth);
  }, [leftWidth, rightWidth]);
  const goToNextReviewItem = useCallback(() => {
    if (!reviewItems.length) return;
    const currentIndex = reviewItems.findIndex((item) => item.id === props.selectedItem?.id);
    const nextItem = reviewItems[(currentIndex + 1) % reviewItems.length];
    setStatusFilter("review");
    setClassFilter("all");
    props.onSelectItem(nextItem.id);
  }, [props.onSelectItem, props.selectedItem?.id, reviewItems]);

  return (
    <section className={`workflow-results ${workflowRunStatusClass(props.run)}`}>
      <div className="workflow-results-header">
        <button type="button" className="workflow-results-close" onClick={props.onClose} aria-label="닫기" title="닫기">
          <X size={18} />
        </button>
        <div>
          <p className="eyebrow">Run</p>
          <h2>{props.run.workflow_name || "워크플로우"} · {workflowRunHeadline(props.run)} · {Math.round(props.run.progress * 100)}%</h2>
        </div>
        <div className="workflow-run-kpis">
          <span><strong>{finishedCount}</strong> 완료/검토/실패</span>
          <span><strong>{props.run.preprocessing_count ?? props.run.items.filter((item) => item.status === "preprocessing").length}</strong> 전처리 중</span>
          <span><strong>{props.run.running_count ?? props.run.items.filter((item) => item.status === "running").length}</strong> 처리 중</span>
          <span><strong>{props.run.queued_count ?? props.run.items.filter((item) => item.status === "queued").length}</strong> 대기</span>
          <span><strong>{props.run.vlm_active_count ?? 0}{props.run.vlm_limit ? ` / ${props.run.vlm_limit}` : ""}</strong> AI 요청 중</span>
          <span><strong>{props.run.vlm_waiting_count ?? 0}</strong> AI 요청 대기</span>
          <span><strong>{formatDurationMs(props.run.upload_duration_ms)}</strong> 업로드</span>
          <span><strong>{formatDurationMs(props.run.inference_duration_ms)}</strong> 추론</span>
          <span><strong>{workflowRunStartedAtLabel(props.run)}</strong> 시작</span>
          <span><strong>{workflowRunCompletedAtLabel(props.run)}</strong> 종료</span>
        </div>
        <div className="workflow-results-actions">
          <button type="button" className="secondary" onClick={goToNextReviewItem} disabled={!reviewItems.length}>
            <CheckSquare size={15} /> 다음 검토 {reviewItems.length ? reviewItems.length.toLocaleString() : ""}
          </button>
          {props.onResume && workflowRunCanResume(props.run) && (
            <button type="button" className="secondary" onClick={props.onResume}>
              <Play size={15} /> 이어하기
            </button>
          )}
          {props.onPause && workflowRunCanPause(props.run) && (
            <button type="button" className="secondary" onClick={props.onPause}>
              <Pause size={15} /> 추론 일시중단
            </button>
          )}
          {props.onStartWaiting && workflowRunCanStartWaiting(props.run) && (
            <button type="button" className="secondary" onClick={props.onStartWaiting}>
              <Play size={15} /> 바로 실행
            </button>
          )}
          {props.onDeleteQueueEntry && workflowRunCanDeleteQueueEntry(props.run) && (
            <button type="button" className="secondary danger-outline" onClick={props.onDeleteQueueEntry}>
              <X size={15} /> {workflowRunDeleteQueueEntryLabel(props.run)}
            </button>
          )}
          {props.onRetryFailed && workflowRunCanRetryFailed(props.run) && (
            <button type="button" className="secondary" onClick={props.onRetryFailed}>
              <RefreshCcw size={15} /> 실패 재시도
            </button>
          )}
          {props.onDiscard && workflowRunCanDiscard(props.run) && (
            <button type="button" className="secondary danger-outline" onClick={props.onDiscard}>
              <X size={15} /> 추론 중단
            </button>
          )}
        </div>
      </div>
      <ExportJobHistory ownerType="workflow_run" ownerId={props.run.id} compact limit={3} />
      <progress className={`workflow-run-progress ${workflowRunStatusClass(props.run)}`} value={props.run.progress} max={1} />
      <div className="workflow-run-workbench workflow-run-workbench-resizable resize-scope" style={workbenchStyle}>
        <WorkflowRunRail
          run={props.run}
          items={filteredItems}
          selectedItem={visibleSelectedItem}
          statusFilter={statusFilter}
          classFilter={classFilter}
          filterCounts={filterCounts}
          classFilterOptions={classFilterOptions}
          onStatusFilter={setStatusFilter}
          onClassFilter={setClassFilter}
          onSelectItem={props.onSelectItem}
        />
        <button className="splitter workflow-result-splitter" type="button" title="목록 영역 너비 조절" aria-label="목록 영역 너비 조절" onPointerDown={onLeftResize}>
          <GripVertical size={18} />
        </button>
        <WorkflowDocumentPreview document={props.document} loading={props.documentLoading} activePage={props.activePage} onPage={props.onPage} item={visibleSelectedItem} />
        <button className="splitter workflow-result-splitter" type="button" title="결과 영역 너비 조절" aria-label="결과 영역 너비 조절" onPointerDown={onRightResize}>
          <GripVertical size={18} />
        </button>
        <WorkflowItemInspector item={visibleSelectedItem} />
      </div>
    </section>
  );
}

function workflowRunFinishedCount(run: WorkflowRun) {
  return Math.min(
    run.total_count,
    run.completed_count + run.failed_count + run.needs_review_count + (run.canceled_count ?? 0)
  );
}

const workflowResultFilterOptions: { value: WorkflowResultFilter; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "success", label: "성공" },
  { value: "failed", label: "실패" },
  { value: "waiting", label: "대기" },
  { value: "running", label: "처리" },
  { value: "review", label: "검토" }
];

function workflowResultFilterCounts(items: WorkflowRunItem[]): Record<WorkflowResultFilter, number> {
  return {
    all: items.length,
    success: items.filter((item) => workflowResultFilterMatches(item, "success")).length,
    failed: items.filter((item) => workflowResultFilterMatches(item, "failed")).length,
    waiting: items.filter((item) => workflowResultFilterMatches(item, "waiting")).length,
    running: items.filter((item) => workflowResultFilterMatches(item, "running")).length,
    review: items.filter((item) => workflowResultFilterMatches(item, "review")).length
  };
}

function workflowResultFilterMatches(item: WorkflowRunItem, filter: WorkflowResultFilter) {
  if (filter === "all") return true;
  if (filter === "success") return item.status === "completed";
  if (filter === "failed") return item.status === "failed";
  if (filter === "waiting") return ["uploading", "preprocessing", "queued", "paused"].includes(item.status);
  if (filter === "running") return item.status === "running";
  return item.status === "needs_review";
}

function workflowClassFilterMatches(item: WorkflowRunItem, filter: string) {
  if (filter === "all") return true;
  return workflowItemClassFilterValue(item) === filter;
}

function workflowClassFilterOptions(items: WorkflowRunItem[]): WorkflowClassFilterOption[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const item of items) {
    const value = workflowItemClassFilterValue(item);
    const label = workflowItemClassLabel(item);
    const current = counts.get(value);
    if (current) {
      current.count += 1;
    } else {
      counts.set(value, { label, count: 1 });
    }
  }
  return [
    { value: "all", label: "전체 분류", count: items.length },
    ...Array.from(counts.entries())
      .map(([value, item]) => ({ value, label: item.label, count: item.count }))
      .sort((a, b) => a.label.localeCompare(b.label, "ko"))
  ];
}

function workflowItemClassLabel(item: WorkflowRunItem) {
  const classification = item.result?.classification;
  return classification?.class_name || classification?.status || "미분류";
}

function workflowItemClassFilterValue(item: WorkflowRunItem) {
  return workflowItemClassLabel(item).trim().toLowerCase() || "미분류";
}

function workflowRunCanResume(run: WorkflowRun) {
  const uploadedCount = run.uploaded_count ?? run.items.length;
  const pausedCount = run.items.filter((item) => item.status === "paused").length;
  return run.status === "paused" && uploadedCount === run.total_count && (pausedCount > 0 || run.items.length > 0);
}

function workflowRunCanPause(run: WorkflowRun) {
  if (run.status === "waiting") return false;
  const uploadedCount = run.uploaded_count ?? run.items.length;
  const preprocessingCount = run.preprocessing_count ?? run.items.filter((item) => item.status === "preprocessing").length;
  const queuedCount = run.queued_count ?? run.items.filter((item) => item.status === "queued").length;
  const runningCount = run.running_count ?? run.items.filter((item) => item.status === "running").length;
  return !TERMINAL_RUN_STATUSES.includes(run.status) && run.status !== "paused" && (uploadedCount < run.total_count || preprocessingCount + queuedCount + runningCount > 0);
}

function workflowRunCanRestart(run: WorkflowRun) {
  if (run.status === "waiting") return false;
  const uploadedCount = run.uploaded_count ?? run.items.length;
  const restartableStatus = ["paused", "completed", "completed_with_errors", "needs_review", "failed", "canceled"].includes(run.status);
  return restartableStatus && run.items.length > 0 && (uploadedCount === run.total_count || run.status === "paused");
}

function workflowRunCanRetryFailed(run: WorkflowRun) {
  if (run.status === "canceled" || run.status === "waiting" || run.failed_count <= 0) return false;
  const activeCount = run.items.filter((item) => ["uploading", "preprocessing", "queued", "running", "paused"].includes(item.status)).length;
  return activeCount === 0;
}

function workflowRunCanResumeUpload(run: WorkflowRun) {
  const uploadedCount = run.uploaded_count ?? run.items.length;
  return run.status !== "waiting" && !TERMINAL_RUN_STATUSES.includes(run.status) && run.total_count > 0 && uploadedCount < run.total_count;
}

function workflowRunCanEnqueue(run: WorkflowRun) {
  const uploadedCount = run.uploaded_count ?? run.items.length;
  return !["waiting", "canceled", "failed"].includes(run.status) && run.items.length > 0 && uploadedCount === run.total_count;
}

function workflowRunCanStartWaiting(run: WorkflowRun, runs?: WorkflowRun[]) {
  if (run.status !== "waiting") return false;
  if (!runs?.length) return true;
  const groupRuns = workflowRunQueueGroup(run, runs);
  const firstWaiting = groupRuns.filter((item) => item.status === "waiting").sort(compareWorkflowQueueRuns)[0] ?? null;
  if (!firstWaiting || firstWaiting.id !== run.id) return false;
  const runPosition = workflowRunQueuePosition(run);
  return !groupRuns.some(
    (item) => item.id !== run.id && !TERMINAL_RUN_STATUSES.includes(item.status) && compareWorkflowQueuePositions(workflowRunQueuePosition(item), runPosition) < 0
  );
}

function workflowRunCanDeleteQueueEntry(run: WorkflowRun) {
  return Boolean(run.queued_from_run_id && !["completed", "completed_with_errors", "needs_review", "failed"].includes(run.status));
}

function workflowRunDeleteQueueEntryLabel(run: WorkflowRun) {
  if (workflowRunIsProcessing(run) || workflowRunIsPaused(run)) return "중단 후 삭제";
  if (run.status === "waiting") return "대기 삭제";
  return "목록 삭제";
}

function workflowRunCanDiscard(run: WorkflowRun) {
  return run.status !== "waiting" && !["completed", "completed_with_errors", "needs_review", "failed", "canceled"].includes(run.status);
}

function workflowRunIsLive(run: WorkflowRun) {
  return !workflowRunIsTerminalOrWaiting(run);
}

function workflowRunIsProcessing(run: WorkflowRun) {
  return workflowRunIsLive(run) && run.status !== "paused" && run.progress_phase !== "paused";
}

function workflowRunIsPaused(run: WorkflowRun) {
  return run.status === "paused" || run.progress_phase === "paused";
}

function workflowRunIsTerminalOrWaiting(run: WorkflowRun) {
  return TERMINAL_RUN_STATUSES.includes(run.status) || run.status === "waiting";
}

function workflowRunStatusClass(run: WorkflowRun) {
  const status = workflowRunVisualStatus(run).replace(/_/g, "-");
  return `status-${status}`;
}

function workflowRunVisualStatus(run: WorkflowRun) {
  if (run.status === "completed_with_errors") return "completed-with-errors";
  if (run.status === "needs_review") return "needs-review";
  if (run.status === "canceled") return "canceled";
  if (run.status === "failed") return "failed";
  if (run.status === "completed") return "completed";
  if (run.status === "paused" || run.progress_phase === "paused") return "paused";
  if (run.status === "waiting" || run.progress_phase === "waiting") return "waiting";
  if (run.status === "uploading" || run.progress_phase === "uploading") return "uploading";
  if (run.status === "preprocessing" || run.progress_phase === "preprocessing") return "preprocessing";
  if (run.status === "queued") return "queued";
  return "running";
}

function workflowRunSourceLabel(run: WorkflowRun) {
  return `${run.total_count.toLocaleString()}개 문서`;
}

function workflowRunSourceTitle(run: WorkflowRun) {
  return `${run.workflow_name || "선택한 실행"}의 ${workflowRunSourceLabel(run)}`;
}

function workflowRunQueueMeta(run: WorkflowRun) {
  if (!run.queued_from_run_id) return "";
  if (run.status === "waiting") return " · 실행 예약";
  if (run.status === "canceled") return " · 예약 취소";
  if (TERMINAL_RUN_STATUSES.includes(run.status)) return " · 예약 실행 완료";
  return " · 예약 실행 중";
}

function workflowRunQueueGroup(run: WorkflowRun, runs: WorkflowRun[]) {
  const groupId = run.workflow_run_group_id ?? run.id;
  return runs.filter((item) => (item.workflow_run_group_id ?? item.id) === groupId);
}

function compareWorkflowQueueRuns(a: WorkflowRun, b: WorkflowRun) {
  return compareWorkflowQueuePositions(workflowRunQueuePosition(a), workflowRunQueuePosition(b));
}

function workflowRunQueuePosition(run: WorkflowRun): [number, number, string] {
  return [run.queue_order ?? 0, workflowRunTimestamp(run.created_at), run.id];
}

function compareWorkflowQueuePositions(a: [number, number, string], b: [number, number, string]) {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2].localeCompare(b[2]);
}

function sortWorkflowRunsByRegistration(runs: WorkflowRun[], previousOrder: WorkflowRun[] = []) {
  const previousIndex = new Map(previousOrder.map((run, index) => [run.id, index]));
  return [...runs].sort((a, b) => {
    const timeDiff = workflowRunTimestamp(b.created_at) - workflowRunTimestamp(a.created_at);
    if (timeDiff) return timeDiff;
    const previousA = previousIndex.get(a.id);
    const previousB = previousIndex.get(b.id);
    if (previousA !== undefined && previousB !== undefined) return previousA - previousB;
    return 0;
  });
}

function workflowRunTimestamp(value: string | undefined | null) {
  if (!value) return 0;
  const normalized = normalizeBackendUtcDate(value);
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function normalizeBackendUtcDate(value: string) {
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)) return value;
  return `${value}Z`;
}

function workflowRunHeadline(run: WorkflowRun) {
  if (run.status === "canceled") return "취소됨";
  if (run.status === "failed") return "실패";
  if (run.status === "completed_with_errors") return "일부 실패";
  if (run.status === "needs_review") return "검토 필요";
  if (run.status === "completed") return "작업 완료";
  if (run.status === "waiting" || run.progress_phase === "waiting") return "실행 대기";
  if (run.status === "paused" || run.progress_phase === "paused") return "일시중단";
  if (workflowRunCanResumeUpload(run) || run.progress_phase === "uploading") return "문서 업로드 중";
  if (run.progress_phase === "preprocessing") return "문서 전처리 중";
  if (!TERMINAL_RUN_STATUSES.includes(run.status) && run.progress < 1) return "작업 진행 중";
  return workflowRunStatusLabel(run);
}

function workflowRunFailureSummary(run: WorkflowRun) {
  if (run.error_message) return run.error_message;
  if (run.status === "failed") return "결과 보기에서 항목별 오류를 확인하세요.";
  if (run.failed_count > 0) return `${run.failed_count.toLocaleString()}개 항목 실패. 결과 보기에서 항목별 오류를 확인하세요.`;
  return "";
}

function workflowRunStatusLabel(run: WorkflowRun) {
  if (run.status === "uploading") return "업로드 중";
  if (run.status === "preprocessing") return "전처리 중";
  if (run.status === "paused") return "일시중단";
  if (run.status === "waiting") return "실행 대기";
  if (run.status === "running") return "처리 중";
  if (run.status === "queued") return "대기";
  if (run.status === "failed") return "실패";
  if (run.status === "completed_with_errors") return "일부 실패";
  if (run.status === "needs_review") return "검토 필요";
  if (run.status === "canceled") return "취소";
  return "완료";
}

function formatWorkflowRunDate(value: string | undefined | null) {
  if (!value) return "시간 없음";
  const date = new Date(normalizeBackendUtcDate(value));
  if (Number.isNaN(date.getTime())) return "시간 없음";
  return date.toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function workflowRunStartedAtLabel(run: WorkflowRun) {
  if (run.started_at) return formatWorkflowRunDate(run.started_at);
  if (run.status === "waiting" || run.progress_phase === "waiting") return "대기 중";
  if (["uploading", "preprocessing", "queued"].includes(run.status) || ["uploading", "preprocessing"].includes(run.progress_phase ?? "")) return "준비 중";
  return "기록 없음";
}

function workflowRunCompletedAtLabel(run: WorkflowRun) {
  if (run.completed_at) return formatWorkflowRunDate(run.completed_at);
  if (workflowRunIsProcessing(run)) return "진행 중";
  if (workflowRunIsPaused(run)) return "일시중단";
  if (run.status === "waiting" || run.progress_phase === "waiting") return "대기 중";
  return "기록 없음";
}

function formatDurationMs(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  if (value < 1000) return `${value}ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}초`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}분 ${remainingSeconds}초`;
}

function readWorkflowResultPaneWidth(key: string, fallback: number) {
  if (typeof window === "undefined") return fallback;
  const parsed = Number(window.localStorage.getItem(key));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function saveWorkflowResultPaneWidth(key: string, value: number) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, String(Math.round(value)));
}

function clampWorkflowPaneWidth(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function workflowContextMenuPosition(clientX: number, clientY: number) {
  const menuWidth = 220;
  const menuHeight = 300;
  return {
    left: Math.max(8, Math.min(clientX, window.innerWidth - menuWidth)),
    top: Math.max(8, Math.min(clientY, window.innerHeight - menuHeight))
  };
}

function startWorkflowResultResize(
  event: PointerEvent<HTMLButtonElement>,
  side: "left" | "right",
  leftWidth: number,
  rightWidth: number,
  setLeftWidth: (value: number) => void,
  setRightWidth: (value: number) => void
) {
  event.preventDefault();
  const container = event.currentTarget.closest<HTMLElement>(".workflow-run-workbench-resizable");
  if (!container) return;
  const pointerId = event.pointerId;
  event.currentTarget.setPointerCapture(pointerId);

  const update = (clientX: number) => {
    const rect = container.getBoundingClientRect();
    const maxLeft = Math.max(
      WORKFLOW_RESULT_MIN_LEFT_WIDTH,
      rect.width - rightWidth - WORKFLOW_RESULT_MIN_MIDDLE_WIDTH - WORKFLOW_RESULT_SPLITTER_WIDTH * 2
    );
    const maxRight = Math.max(
      WORKFLOW_RESULT_MIN_RIGHT_WIDTH,
      rect.width - leftWidth - WORKFLOW_RESULT_MIN_MIDDLE_WIDTH - WORKFLOW_RESULT_SPLITTER_WIDTH * 2
    );
    if (side === "left") {
      const next = clampWorkflowPaneWidth(clientX - rect.left, WORKFLOW_RESULT_MIN_LEFT_WIDTH, maxLeft);
      setLeftWidth(next);
      saveWorkflowResultPaneWidth(WORKFLOW_RESULT_LEFT_WIDTH_KEY, next);
    } else {
      const next = clampWorkflowPaneWidth(rect.right - clientX, WORKFLOW_RESULT_MIN_RIGHT_WIDTH, maxRight);
      setRightWidth(next);
      saveWorkflowResultPaneWidth(WORKFLOW_RESULT_RIGHT_WIDTH_KEY, next);
    }
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

function startWorkflowRunSidebarResize(
  event: PointerEvent<HTMLButtonElement>,
  currentWidth: number,
  setWidth: (value: number) => void
) {
  event.preventDefault();
  const container = event.currentTarget.closest<HTMLElement>(".workflow-canvas-shell");
  if (!container) return;
  const pointerId = event.pointerId;
  event.currentTarget.setPointerCapture(pointerId);
  const startX = event.clientX;
  const startWidth = currentWidth;

  const update = (clientX: number) => {
    const rect = container.getBoundingClientRect();
    const availableWidth = Math.max(WORKFLOW_RUN_SIDEBAR_MIN_WIDTH, rect.width - 28);
    const maxWidth = Math.min(WORKFLOW_RUN_SIDEBAR_MAX_WIDTH, availableWidth);
    const next = clampWorkflowPaneWidth(startWidth + startX - clientX, WORKFLOW_RUN_SIDEBAR_MIN_WIDTH, maxWidth);
    setWidth(next);
    saveWorkflowResultPaneWidth(WORKFLOW_RUN_SIDEBAR_WIDTH_KEY, next);
  };

  const onMove = (moveEvent: globalThis.PointerEvent) => update(moveEvent.clientX);
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function useWorkflowRunVirtualRows(count: number, activeIndex: number, activeKey: string | null | undefined) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(420);
  const previousActiveKeyRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const updateHeight = () => setViewportHeight(element.clientHeight || 420);
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
    if (previousActiveKeyRef.current === activeKey) return;
    previousActiveKeyRef.current = activeKey;

    const rowTop = activeIndex * WORKFLOW_RUN_ROW_HEIGHT;
    const rowBottom = rowTop + WORKFLOW_RUN_ROW_HEIGHT;
    const viewTop = element.scrollTop;
    const viewBottom = viewTop + element.clientHeight;
    if (rowTop < viewTop) {
      element.scrollTop = Math.max(0, rowTop - WORKFLOW_RUN_ROW_HEIGHT * 2);
      setScrollTop(element.scrollTop);
    } else if (rowBottom > viewBottom) {
      element.scrollTop = Math.max(0, rowBottom - element.clientHeight + WORKFLOW_RUN_ROW_HEIGHT * 2);
      setScrollTop(element.scrollTop);
    }
  }, [activeIndex, activeKey, count]);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  const start = Math.max(0, Math.floor(scrollTop / WORKFLOW_RUN_ROW_HEIGHT) - WORKFLOW_RUN_OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / WORKFLOW_RUN_ROW_HEIGHT) + WORKFLOW_RUN_OVERSCAN * 2;
  const end = Math.min(count, start + visibleCount);
  const spacerStyle = useMemo<CSSProperties>(
    () => ({ height: Math.max(1, count) * WORKFLOW_RUN_ROW_HEIGHT }),
    [count]
  );
  const windowStyle = useMemo<CSSProperties>(
    () => ({ transform: `translateY(${start * WORKFLOW_RUN_ROW_HEIGHT}px)` }),
    [start]
  );

  return { containerRef, onScroll, start, end, spacerStyle, windowStyle };
}

function WorkflowRunRail(props: {
  run: WorkflowRun;
  items: WorkflowRunItem[];
  selectedItem: WorkflowRunItem | null;
  statusFilter: WorkflowResultFilter;
  classFilter: string;
  filterCounts: Record<WorkflowResultFilter, number>;
  classFilterOptions: WorkflowClassFilterOption[];
  onStatusFilter: (filter: WorkflowResultFilter) => void;
  onClassFilter: (filter: string) => void;
  onSelectItem: (itemId: string) => void;
}) {
  const activeIndex = Math.max(0, props.items.findIndex((item) => item.id === props.selectedItem?.id));
  const virtual = useWorkflowRunVirtualRows(props.items.length, activeIndex, props.selectedItem?.id);
  const visibleItems = props.items.slice(virtual.start, virtual.end);

  return (
    <aside className="workflow-run-rail">
      <div className="workflow-run-rail-head">
        <span>{props.items.length.toLocaleString()} / {props.run.total_count.toLocaleString()}개 문서</span>
        <small>{workflowStatusLabel(props.run.status)}</small>
      </div>
      <div className="workflow-run-filter" role="tablist" aria-label="문서 상태 필터">
        {workflowResultFilterOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            className={props.statusFilter === option.value ? "active" : ""}
            onClick={() => props.onStatusFilter(option.value)}
          >
            <span>{option.label}</span>
            <strong>{props.filterCounts[option.value].toLocaleString()}</strong>
          </button>
        ))}
      </div>
      <label className="workflow-class-filter">
        <span>Class</span>
        <select value={props.classFilter} onChange={(event) => props.onClassFilter(event.target.value)}>
          {props.classFilterOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label} · {option.count.toLocaleString()}
            </option>
          ))}
        </select>
      </label>
      {(props.statusFilter !== "all" || props.classFilter !== "all") && (
        <div className="workflow-active-filters">
          <span>{props.items.length.toLocaleString()}개 표시 중</span>
          <button type="button" onClick={() => {
            props.onStatusFilter("all");
            props.onClassFilter("all");
          }}>
            필터 해제
          </button>
        </div>
      )}
      <div className="workflow-run-list workflow-virtual-list" ref={virtual.containerRef} onScroll={virtual.onScroll}>
        {props.items.length ? (
          <div className="virtual-list-spacer" style={virtual.spacerStyle}>
            <div className="virtual-list-window" style={virtual.windowStyle}>
              {visibleItems.map((item) => {
                const result = item.result ?? {};
                const classification = result.classification?.class_name || result.classification?.status || "-";
                const activeNode = item.status === "queued" ? "대기 중" : result.current_node_label || workflowStatusLabel(item.status);
                return (
                  <button key={item.id} type="button" className={item.id === props.selectedItem?.id ? "active" : ""} onClick={() => props.onSelectItem(item.id)}>
                    <span>
                      <i className={`workflow-status-dot ${item.status}`} />
                      <strong>{item.filename}</strong>
                    </span>
                    <small>{classification} · {activeNode}</small>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="workflow-run-list-empty">선택한 상태의 문서가 없습니다.</div>
        )}
      </div>
    </aside>
  );
}

function WorkflowDocumentPreview(props: {
  document: WorkflowDocument | null;
  loading: boolean;
  activePage: number;
  item: WorkflowRunItem | null;
  onPage: (page: number) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setIsPanning(false);
    panStartRef.current = null;
  }, [props.document?.document_id, props.activePage]);

  const setPreviewZoom = useCallback((nextZoom: number) => {
    const clamped = Math.min(3, Math.max(0.5, Number(nextZoom.toFixed(2))));
    setZoom(clamped);
    if (clamped <= 1) setPan({ x: 0, y: 0 });
  }, []);

  const resetPreview = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setIsPanning(false);
    panStartRef.current = null;
  }, []);

  const onPreviewPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (zoom <= 1) return;
    panStartRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: pan.x,
      originY: pan.y
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsPanning(true);
  }, [pan.x, pan.y, zoom]);

  const onPreviewPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const start = panStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    setPan({
      x: start.originX + event.clientX - start.startX,
      y: start.originY + event.clientY - start.startY
    });
  }, []);

  const stopPreviewPan = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const start = panStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    panStartRef.current = null;
    setIsPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  if (props.loading) {
    return <section className="workflow-preview-pane"><div className="workflow-preview-empty">문서 preview를 불러오는 중입니다.</div></section>;
  }
  if (!props.document) {
    return <section className="workflow-preview-pane"><div className="workflow-preview-empty">문서를 선택하면 이미지가 표시됩니다.</div></section>;
  }
  const document = props.document;
  const safePage = Math.min(Math.max(0, props.activePage), Math.max(0, document.page_count - 1));
  const page = document.pages[safePage];
  return (
    <section className="workflow-preview-pane">
      <div className="workflow-preview-toolbar">
        <div className="workflow-preview-status">
          {props.item?.result.current_node_label && <strong>{props.item.result.current_node_label} 진행 중</strong>}
        </div>
        <div className="workflow-preview-page-controls">
          <button type="button" onClick={() => props.onPage(Math.max(0, safePage - 1))} disabled={safePage <= 0} aria-label="이전 페이지">
            <ChevronLeft size={15} />
          </button>
          <span>{safePage + 1} / {document.page_count}</span>
          <button type="button" onClick={() => props.onPage(Math.min(document.page_count - 1, safePage + 1))} disabled={safePage >= document.page_count - 1} aria-label="다음 페이지">
            <ChevronRight size={15} />
          </button>
        </div>
        <div className="workflow-preview-zoom-controls">
          <button type="button" onClick={() => setPreviewZoom(zoom - 0.25)} disabled={zoom <= 0.5} aria-label="축소" title="축소">
            <Minus size={15} />
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => setPreviewZoom(zoom + 0.25)} disabled={zoom >= 3} aria-label="확대" title="확대">
            <Plus size={15} />
          </button>
          <button type="button" onClick={resetPreview} aria-label="전체 보기" title="전체 보기">
            <Maximize2 size={15} />
          </button>
        </div>
      </div>
      <div
        className={`workflow-preview-stage ${zoom > 1 ? "can-pan" : ""} ${isPanning ? "is-panning" : ""}`}
        onPointerDown={onPreviewPointerDown}
        onPointerMove={onPreviewPointerMove}
        onPointerUp={stopPreviewPan}
        onPointerCancel={stopPreviewPan}
      >
        <div className="workflow-preview-image-wrap" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          {page && <img src={workflowDocumentPageSrc(page)} alt={`${document.filename} ${safePage + 1}페이지`} draggable={false} />}
        </div>
      </div>
    </section>
  );
}

function WorkflowItemInspector({ item }: { item: WorkflowRunItem | null }) {
  if (!item) {
    return <aside className="workflow-item-detail">결과 문서를 선택하세요.</aside>;
  }
  const result = item.result ?? {};
  const kieEntries = Object.entries(result.kie_values ?? {});
  const requiredEntries = Object.entries(result.required_items ?? {});
  const classificationOnly = result.branch_path && !kieEntries.length && !requiredEntries.length && item.status !== "running" && item.status !== "queued";
  return (
    <aside className="workflow-item-detail">
      <div className="workflow-inspector-head">
        <p className="eyebrow">Document</p>
        <h3>{item.filename}</h3>
        <span className={`workflow-status-pill ${item.status}`}>{workflowStatusLabel(item.status)}</span>
      </div>
      <div className="workflow-inspector-cards">
        <div>
          <strong>분류</strong>
          <span>{result.classification?.class_name || result.classification?.status || "-"}</span>
        </div>
        <div>
          <strong>Branch</strong>
          <span>{result.branch_path || "-"}</span>
        </div>
        <div>
          <strong>현재 모듈</strong>
          <span>{item.status === "queued" ? "대기 중" : result.current_node_label || "-"}</span>
        </div>
        <div>
          <strong>필수항목</strong>
          <span>{result.required_overall_status || "-"}</span>
        </div>
        <div>
          <strong>업로드</strong>
          <span>{formatDurationMs(item.upload_duration_ms)}</span>
        </div>
        <div>
          <strong>추론</strong>
          <span>{formatDurationMs(item.inference_duration_ms)}</span>
        </div>
      </div>
      {classificationOnly && <div className="workflow-classification-only">이 문서는 후속 route가 없어 분류 결과만 export됩니다.</div>}
      {item.status === "running" && <div className="workflow-running-skeleton">모듈 처리 결과를 기다리는 중입니다.</div>}
      {item.error_message && <div className="module-error">{item.error_message}</div>}
      <h4>KIE 결과</h4>
      <div className="workflow-result-table-wrap compact">
        <table className="module-result-table workflow-module-table">
          <thead>
            <tr><th>필드</th><th>값</th><th>신뢰도</th><th>근거</th></tr>
          </thead>
          <tbody>
            {kieEntries.length ? kieEntries.map(([key, value]) => {
              const entry = typeof value === "object" && value !== null ? value as { value?: unknown; evidence?: string; confidence?: number } : { value };
              return (
                <tr key={key}>
                  <td>{key}</td>
                  <td>{formatWorkflowValue(entry.value)}</td>
                  <td>{typeof entry.confidence === "number" ? `${Math.round(entry.confidence * 100)}%` : "-"}</td>
                  <td>{entry.evidence || "-"}</td>
                </tr>
              );
            }) : <tr><td colSpan={4}>표시할 KIE 결과가 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>
      <h4>필수 항목</h4>
      <div className="workflow-result-table-wrap compact">
        <table className="module-result-table workflow-module-table">
          <thead>
            <tr><th>항목</th><th>상태</th><th>근거</th></tr>
          </thead>
          <tbody>
            {requiredEntries.length ? requiredEntries.map(([key, value]) => (
              <tr key={key}>
                <td>{key}</td>
                <td>{value.status || "-"}</td>
                <td>{value.evidence || "-"}</td>
              </tr>
            )) : <tr><td colSpan={3}>표시할 필수항목 결과가 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>
    </aside>
  );
}

function NodeIcon({ kind }: { kind: WorkflowNodeKind }) {
  if (kind === "input") return <FileInput size={17} />;
  if (kind === "classifier") return <ClipboardList size={17} />;
  if (kind === "branch") return <GitBranch size={17} />;
  if (kind === "kie") return <Sparkles size={17} />;
  if (kind === "required-checker") return <CheckSquare size={17} />;
  if (kind === "merge") return <GitMerge size={17} />;
  return <Braces size={17} />;
}

function workflowNode(
  kind: WorkflowNodeKind,
  label: string,
  x: number,
  y: number,
  config: Record<string, string> = {},
  branchKeys?: string[],
  id?: string
): WorkflowNode {
  return {
    id: id ?? `${kind}_${crypto.randomUUID().slice(0, 8)}`,
    type: "workflow",
    position: { x, y },
    data: { kind, label, config, branchKeys }
  };
}

function workflowEdge(source: string, target: string, sourceHandle?: string): WorkflowEdge {
  return {
    id: `${source}-${sourceHandle || "out"}-${target}`,
    source,
    target,
    sourceHandle,
    animated: false,
    label: sourceHandle ? branchKeyLabel(sourceHandle) : undefined
  };
}

function normalizeWorkflowEdge(edge: WorkflowEdge): WorkflowEdge {
  const sourceHandle = normalizeBranchHandle(typeof edge.sourceHandle === "string" ? edge.sourceHandle : undefined);
  return {
    ...edge,
    id: edge.id || `${edge.source}-${sourceHandle || "out"}-${edge.target}`,
    sourceHandle,
    animated: false,
    label: sourceHandle ? branchKeyLabel(sourceHandle) : edge.label
  };
}

function normalizeWorkflowEdges(edges: WorkflowEdge[]): WorkflowEdge[] {
  const seenRouteKeys = new Set<string>();
  return edges.map(normalizeWorkflowEdge).filter((edge) => {
    if (!edge.sourceHandle) return true;
    const routeKey = `${edge.source}:${edge.sourceHandle}`;
    if (seenRouteKeys.has(routeKey)) return false;
    seenRouteKeys.add(routeKey);
    return true;
  });
}

function normalizeBranchHandle(handle: string | undefined) {
  if (handle === "default" || handle === "needs_review") return UNKNOWN_BRANCH_KEY;
  return handle;
}

function normalizeWorkflowNode(node: WorkflowNode): WorkflowNode {
  const {
    connectedBranchKeys: _connectedBranchKeys,
    configSelect: _configSelect,
    onConfigChange: _onConfigChange,
    onSelect: _onSelect,
    ...data
  } = node.data;
  const branchKeys = data.kind === "branch" ? normalizeBranchKeys(data.branchKeys) : data.branchKeys;
  return {
    ...node,
    type: "workflow",
    data: {
      ...data,
      branchKeys,
      config: data.config ?? {}
    }
  };
}

function buildCanvasNodes(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  schemas: SchemaSummary[],
  classifiers: ClassifierSummary[],
  checklists: ChecklistSummary[],
  onConfigChange: (nodeId: string, key: string, value: string) => void,
  onNodeSelect: (event: ReactMouseEvent, nodeId: string) => void,
  selectedNodeIds: string[] = []
): WorkflowNode[] {
  const selectedSet = new Set(selectedNodeIds);
  return nodes.map((node) => {
    const configSelect = workflowNodeConfigSelect(node, schemas, classifiers, checklists);
    const connectedBranchKeys = edges
      .filter((edge) => edge.source === node.id && edge.sourceHandle)
      .map((edge) => String(edge.sourceHandle));
    return {
      ...node,
      selected: selectedSet.has(node.id),
      data: {
        ...node.data,
        connectedBranchKeys: node.data.kind === "branch" ? connectedBranchKeys : undefined,
        configSelect,
        onConfigChange: configSelect ? onConfigChange : undefined,
        onSelect: onNodeSelect
      }
    };
  });
}

function workflowNodeConfigSelect(
  node: WorkflowNode,
  schemas: SchemaSummary[],
  classifiers: ClassifierSummary[],
  checklists: ChecklistSummary[]
): WorkflowNodeConfigSelect | undefined {
  if (node.data.kind === "classifier") {
    return {
      key: "classifier_id",
      label: "분류 설정",
      placeholder: "분류 설정 선택",
      value: node.data.config?.classifier_id ?? "",
      options: classifiers.map((item) => ({ value: item.id, label: `${item.name} · ${item.classes.length}개 클래스` }))
    };
  }
  if (node.data.kind === "kie") {
    return {
      key: "schema_id",
      label: "스키마",
      placeholder: "스키마 선택",
      value: node.data.config?.schema_id ?? "",
      options: schemas.map((item) => ({ value: item.id, label: `${item.display_name || item.name} · ${item.fields.length}개 필드` }))
    };
  }
  if (node.data.kind === "required-checker") {
    return {
      key: "checklist_id",
      label: "체크리스트",
      placeholder: "체크리스트 선택",
      value: node.data.config?.checklist_id ?? "",
      options: checklists.map((item) => ({ value: item.id, label: `${item.name} · ${item.items.length}개 항목` }))
    };
  }
  return undefined;
}

function edgeLabel(edge: WorkflowEdge, nodes: WorkflowNode[]) {
  const source = nodes.find((node) => node.id === edge.source);
  const target = nodes.find((node) => node.id === edge.target);
  const sourceLabel = source?.data.label ?? edge.source;
  const targetLabel = target?.data.label ?? edge.target;
  const routeLabel = edge.sourceHandle ? ` · ${branchKeyLabel(String(edge.sourceHandle))}` : "";
  return `${sourceLabel}${routeLabel} → ${targetLabel}`;
}

function serializeDefinition(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: "workflow",
      position: node.position,
      data: normalizeWorkflowNode(node).data
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      data: edge.data
    }))
  };
}

function updateWorkflowNodeConfig(nodes: WorkflowNode[], nodeId: string, key: string, value: string) {
  return nodes.map((node) => {
    if (node.id !== nodeId) return node;
    return { ...node, data: { ...node.data, config: { ...(node.data.config ?? {}), [key]: value } } };
  });
}

function schemaSummaryToDraft(schema: SchemaSummary | undefined): WorkflowSchemaDraft | null {
  if (!schema) return null;
  return normalizeSchemaDraft({
    name: schema.name,
    display_name: schema.display_name,
    description: schema.description ?? null,
    regions: schema.regions ?? [],
    fields: schema.fields
  });
}

function emptyWorkflowSchemaDraft(nodeId: string): WorkflowSchemaDraft {
  const suffix = nodeId.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || Date.now().toString(36);
  return {
    name: `workflow_schema_${suffix}`.slice(0, 120),
    display_name: "Workflow schema",
    description: "Workflow Builder에서 만든 schema 초안입니다.",
    is_template: false,
    template_category: null,
    pinned: false,
    regions: [],
    fields: [
      {
        key_name: "field_1",
        description: "추출할 값을 설명하세요.",
        output_format: "string"
      }
    ]
  };
}

function normalizeSchemaDraft(schema: WorkflowSchemaDraft): WorkflowSchemaDraft {
  return {
    name: schema.name || "AI 추천 schema",
    display_name: schema.display_name ?? schema.name,
    description: schema.description ?? null,
    is_template: Boolean(schema.is_template),
    template_category: schema.template_category ?? null,
    pinned: Boolean(schema.pinned),
    regions: schema.regions ?? [],
    fields: schema.fields.length ? schema.fields.map(normalizeSchemaField) : [{
      key_name: "field_1",
      description: "추출할 값을 설명하세요.",
      output_format: "string"
    }]
  };
}

function normalizeSchemaField(field: WorkflowSchemaField): WorkflowSchemaField {
  return {
    key_name: field.key_name || "field",
    description: field.description || "추출할 값을 설명하세요.",
    output_format: field.output_format || "string",
    region_id: field.region_id ?? null,
    judgement_enabled: Boolean(field.judgement_enabled)
  };
}

function schemaDraftPayload(draft: WorkflowSchemaDraft) {
  const normalized = normalizeSchemaDraft(draft);
  return {
    name: normalized.name.trim() || "AI 추천 schema",
    display_name: normalized.display_name?.trim() || normalized.name.trim() || "AI 추천 schema",
    description: normalized.description ?? null,
    is_template: Boolean(normalized.is_template),
    template_category: normalized.template_category ?? null,
    pinned: Boolean(normalized.pinned),
    regions: normalized.regions ?? [],
    fields: normalized.fields.map((field) => ({
      key_name: field.key_name.trim() || "field",
      description: field.description.trim() || "추출할 값을 설명하세요.",
      output_format: field.output_format,
      region_id: field.region_id || null,
      judgement_enabled: Boolean(field.judgement_enabled)
    }))
  };
}

function classifierSummaryToDraft(classifier: ClassifierSummary | undefined): WorkflowClassifierDraft | null {
  if (!classifier) return null;
  return normalizeClassifierDraft({
    name: classifier.name,
    description: classifier.description ?? null,
    allow_unknown: classifier.allow_unknown ?? true,
    classes: classifier.classes ?? []
  });
}

function emptyWorkflowClassifierDraft(nodeId: string): WorkflowClassifierDraft {
  const suffix = nodeId.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || Date.now().toString(36);
  return {
    name: `workflow_classifier_${suffix}`.slice(0, 120),
    description: "Workflow Builder에서 만든 classifier 초안입니다.",
    allow_unknown: true,
    classes: [
      {
        class_name: "class_1",
        description: "분류 기준을 설명하세요.",
        signals: []
      }
    ]
  };
}

function normalizeClassifierDraft(draft: WorkflowClassifierDraft): WorkflowClassifierDraft {
  return {
    name: draft.name || "AI 추천 classifier",
    description: draft.description ?? null,
    allow_unknown: draft.allow_unknown ?? true,
    classes: draft.classes.length ? draft.classes.map(normalizeClassifierClass) : [{
      class_name: "class_1",
      description: "분류 기준을 설명하세요.",
      signals: []
    }]
  };
}

function normalizeClassifierClass(candidate: WorkflowClassifierClass): WorkflowClassifierClass {
  return {
    class_name: candidate.class_name || "class",
    description: candidate.description || "분류 기준을 설명하세요.",
    signals: (candidate.signals ?? []).map((signal) => signal.trim()).filter(Boolean)
  };
}

function classifierDraftPayload(draft: WorkflowClassifierDraft) {
  const normalized = normalizeClassifierDraft(draft);
  return {
    name: normalized.name.trim() || "AI 추천 classifier",
    description: normalized.description?.trim() || null,
    allow_unknown: Boolean(normalized.allow_unknown),
    classes: normalized.classes.map((candidate) => ({
      class_name: candidate.class_name.trim() || "class",
      description: candidate.description.trim() || "분류 기준을 설명하세요.",
      signals: candidate.signals.map((signal) => signal.trim()).filter(Boolean)
    }))
  };
}

function checklistSummaryToDraft(checklist: ChecklistSummary | undefined): WorkflowChecklistDraft | null {
  if (!checklist) return null;
  return normalizeChecklistDraft({
    name: checklist.name,
    description: checklist.description ?? null,
    regions: checklist.regions ?? [],
    items: checklist.items ?? []
  });
}

function emptyWorkflowChecklistDraft(nodeId: string): WorkflowChecklistDraft {
  const suffix = nodeId.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || Date.now().toString(36);
  return {
    name: `workflow_checklist_${suffix}`.slice(0, 120),
    description: "Workflow Builder에서 만든 checklist 초안입니다.",
    regions: [],
    items: [
      {
        item_name: "항목 1",
        description: "확인할 항목을 설명하세요.",
        evidence_type: "text_or_handwriting",
        required: true
      }
    ]
  };
}

function normalizeChecklistDraft(draft: WorkflowChecklistDraft): WorkflowChecklistDraft {
  return {
    name: draft.name || "AI 추천 checklist",
    description: draft.description ?? null,
    regions: draft.regions ?? [],
    items: draft.items.length ? draft.items.map(normalizeChecklistItem) : [{
      item_name: "항목 1",
      description: "확인할 항목을 설명하세요.",
      evidence_type: "text_or_handwriting",
      required: true
    }]
  };
}

function normalizeChecklistItem(item: WorkflowChecklistItem): WorkflowChecklistItem {
  return {
    item_name: item.item_name || "항목",
    description: item.description || "확인할 항목을 설명하세요.",
    evidence_type: item.evidence_type || "text_or_handwriting",
    required: item.required ?? true,
    region_id: item.region_id ?? null
  };
}

function checklistDraftPayload(draft: WorkflowChecklistDraft) {
  const normalized = normalizeChecklistDraft(draft);
  return {
    name: normalized.name.trim() || "AI 추천 checklist",
    description: normalized.description?.trim() || null,
    regions: normalized.regions ?? [],
    items: normalized.items.map((item) => ({
      item_name: item.item_name.trim() || "항목",
      description: item.description.trim() || "확인할 항목을 설명하세요.",
      evidence_type: item.evidence_type || "text_or_handwriting",
      required: item.required,
      region_id: item.region_id || null
    }))
  };
}

function updateSchemaDraftField(draft: WorkflowSchemaDraft, index: number, patch: Partial<WorkflowSchemaField>): WorkflowSchemaDraft {
  return {
    ...draft,
    fields: draft.fields.map((field, fieldIndex) => (fieldIndex === index ? { ...field, ...patch } : field))
  };
}

function updateClassifierDraftClass(draft: WorkflowClassifierDraft, index: number, patch: Partial<WorkflowClassifierClass>): WorkflowClassifierDraft {
  return {
    ...draft,
    classes: draft.classes.map((candidate, classIndex) => (classIndex === index ? { ...candidate, ...patch } : candidate))
  };
}

function updateChecklistDraftItem(draft: WorkflowChecklistDraft, index: number, patch: Partial<WorkflowChecklistItem>): WorkflowChecklistDraft {
  return {
    ...draft,
    items: draft.items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item))
  };
}

function formatClassifierSignals(signals: string[]) {
  return signals.join(", ");
}

function parseClassifierSignals(value: string) {
  return value.split(/[,\n]+/).map((signal) => signal.trim()).filter(Boolean);
}

function workflowEvidenceTypeIsPreset(value: string) {
  return WORKFLOW_EVIDENCE_TYPES.includes(value as (typeof WORKFLOW_EVIDENCE_TYPES)[number]);
}

function isWorkflowAiDraftImage(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ["png", "jpg", "jpeg"].includes(extension);
}

function workflowNodeHasAssetEditor(node: WorkflowNode) {
  return node.data.kind === "classifier" || node.data.kind === "kie" || node.data.kind === "required-checker";
}

function syncBranchKeys(nodes: WorkflowNode[], classifierId: string, classifiers: ClassifierSummary[]) {
  const classifier = classifiers.find((item) => item.id === classifierId);
  return syncBranchKeysFromClassNames(nodes, classifier?.classes.map((item) => item.class_name) ?? []);
}

function syncBranchKeysFromClassNames(nodes: WorkflowNode[], classNames: string[]) {
  const branchKeys = [
    ...classNames.map((className) => className.trim()).filter(Boolean).map((className) => `class:${className}`),
    UNKNOWN_BRANCH_KEY
  ];
  return nodes.map((node) => {
    if (node.data.kind !== "branch") return node;
    return { ...node, data: { ...node.data, branchKeys } };
  });
}

function shouldBootstrapBankPocStarterWorkflow(params: {
  activeWorkflowId: string;
  checklists: ChecklistSummary[];
  classifiers: ClassifierSummary[];
  initialDraft: WorkflowDraft | null;
  initialWorkflowId: string;
  schemas: SchemaSummary[];
  workflows: WorkflowDefinition[];
}) {
  if (params.initialWorkflowId || !isStarterWorkflowDraft(params.initialDraft)) return false;
  const bankWorkflow = params.workflows.find(isBankPocWorkflow);
  if (bankWorkflow) {
    return bankPocWorkflowNeedsRefresh(bankWorkflow, params.schemas, params.classifiers, params.checklists);
  }
  return !params.activeWorkflowId && !params.workflows.length && !params.schemas.length && !params.classifiers.length && !params.checklists.length;
}

function starterWorkflowToAutoLoad(params: {
  activeWorkflowId: string;
  checklists: ChecklistSummary[];
  classifiers: ClassifierSummary[];
  initialDraft: WorkflowDraft | null;
  initialWorkflowId: string;
  schemas: SchemaSummary[];
  workflows: WorkflowDefinition[];
}) {
  if (params.initialWorkflowId || !isStarterWorkflowDraft(params.initialDraft)) return null;
  if (params.activeWorkflowId) {
    const activeWorkflow = params.workflows.find((workflow) => workflow.id === params.activeWorkflowId);
    return activeWorkflow && isBankPocWorkflow(activeWorkflow) ? activeWorkflow : null;
  }
  return (
    params.workflows.find((workflow) => isBankPocWorkflow(workflow) && bankPocWorkflowIsConnected(workflow, params.schemas, params.classifiers, params.checklists)) ??
    params.workflows[0] ??
    null
  );
}

function isStarterWorkflowDraft(draft: WorkflowDraft | null) {
  if (!draft) return true;
  if (
    Object.keys(draft.classifierDraftsByNodeId ?? {}).length ||
    Object.keys(draft.schemaDraftsByNodeId ?? {}).length ||
    Object.keys(draft.checklistDraftsByNodeId ?? {}).length
  ) return false;
  if (draft.workflowName === BANK_POC_WORKFLOW_NAME) return true;
  if (draft.activeWorkflowId) return false;
  if (draft.nodes.length !== defaultNodes.length || draft.edges.length !== defaultEdges.length) return false;
  return draft.nodes.every((node, index) => {
    const defaultNode = defaultNodes[index];
    return (
      node.id === defaultNode.id &&
      node.data.kind === defaultNode.data.kind &&
      node.data.label === defaultNode.data.label &&
      workflowNodeConfigIsEmpty(node) &&
      Math.abs(node.position.x - defaultNode.position.x) < 0.5 &&
      Math.abs(node.position.y - defaultNode.position.y) < 0.5
    );
  });
}

function workflowNodeConfigIsEmpty(node: WorkflowNode) {
  return !Object.values(node.data.config ?? {}).some((value) => String(value || "").trim());
}

function isBankPocWorkflow(workflow: WorkflowDefinition) {
  return workflow.name === BANK_POC_WORKFLOW_NAME;
}

function isBankPocCanvas(workflowName: string, nodes: WorkflowNode[]) {
  if (workflowName !== BANK_POC_WORKFLOW_NAME) return false;
  const nodeIds = new Set(nodes.map((node) => node.id));
  return Object.keys(BANK_POC_COMPACT_NODE_POSITIONS).every((nodeId) => nodeIds.has(nodeId));
}

function bankPocWorkflowNeedsRefresh(
  workflow: WorkflowDefinition,
  schemas: SchemaSummary[],
  classifiers: ClassifierSummary[],
  checklists: ChecklistSummary[]
) {
  return (
    Boolean(workflow.validation_warnings.length) ||
    !bankPocWorkflowIsConnected(workflow, schemas, classifiers, checklists) ||
    !bankPocWorkflowUsesCompactLayout(workflow)
  );
}

function bankPocWorkflowIsConnected(
  workflow: WorkflowDefinition,
  schemas: SchemaSummary[],
  classifiers: ClassifierSummary[],
  checklists: ChecklistSummary[]
) {
  const schemaIds = new Set(schemas.map((schema) => schema.id));
  const classifierIds = new Set(classifiers.map((classifier) => classifier.id));
  const checklistIds = new Set(checklists.map((checklist) => checklist.id));
  return workflow.definition.nodes.every((node) => {
    if (node.data.kind === "classifier") return classifierIds.has(node.data.config?.classifier_id ?? "");
    if (node.data.kind === "kie") return schemaIds.has(node.data.config?.schema_id ?? "");
    if (node.data.kind === "required-checker") return checklistIds.has(node.data.config?.checklist_id ?? "");
    return true;
  });
}

function bankPocWorkflowUsesCompactLayout(workflow: WorkflowDefinition) {
  return Object.entries(BANK_POC_COMPACT_NODE_POSITIONS).every(([nodeId, position]) => {
    const node = workflow.definition.nodes.find((item) => item.id === nodeId);
    return Boolean(node && Math.abs(node.position.x - position.x) < 0.5 && Math.abs(node.position.y - position.y) < 0.5);
  });
}

function upsertById<T extends { id: string }>(items: T[], item: T) {
  return [item, ...items.filter((current) => current.id !== item.id)];
}

function readWorkflowDraft(): WorkflowDraft | null {
  try {
    const raw = window.localStorage.getItem(WORKFLOW_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WorkflowDraft>;
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    return {
      activeWorkflowId: typeof parsed.activeWorkflowId === "string" ? parsed.activeWorkflowId : "",
      workflowName: typeof parsed.workflowName === "string" && parsed.workflowName.trim() ? parsed.workflowName : "문서 자동화 워크플로우",
      nodes: parsed.nodes.map(normalizeWorkflowNode),
      edges: normalizeWorkflowEdges(parsed.edges as WorkflowEdge[]),
      selectedNodeId: typeof parsed.selectedNodeId === "string" ? parsed.selectedNodeId : parsed.nodes[0]?.id ?? null,
      classifierDraftsByNodeId: isRecord(parsed.classifierDraftsByNodeId) ? parsed.classifierDraftsByNodeId as Record<string, WorkflowClassifierDraft> : {},
      schemaDraftsByNodeId: isRecord(parsed.schemaDraftsByNodeId) ? parsed.schemaDraftsByNodeId as Record<string, WorkflowSchemaDraft> : {},
      checklistDraftsByNodeId: isRecord(parsed.checklistDraftsByNodeId) ? parsed.checklistDraftsByNodeId as Record<string, WorkflowChecklistDraft> : {}
    };
  } catch {
    return null;
  }
}

function writeWorkflowDraft(draft: WorkflowDraft) {
  try {
    window.localStorage.setItem(
      WORKFLOW_DRAFT_KEY,
      JSON.stringify({
        ...draft,
        nodes: draft.nodes.map((node) => ({
          id: node.id,
          type: "workflow",
          position: node.position,
          data: node.data
        })),
        edges: draft.edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle,
          targetHandle: edge.targetHandle,
          label: edge.label,
          animated: false,
          data: edge.data
        })),
        classifierDraftsByNodeId: draft.classifierDraftsByNodeId ?? {},
        schemaDraftsByNodeId: draft.schemaDraftsByNodeId ?? {},
        checklistDraftsByNodeId: draft.checklistDraftsByNodeId ?? {}
      })
    );
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateConnection(connection: Connection, nodes: WorkflowNode[], edges: WorkflowEdge[]) {
  if (!connection.source || !connection.target) return "연결할 시작/도착 노드가 필요합니다.";
  if (connection.source === connection.target) return "같은 노드끼리는 연결할 수 없습니다.";
  const source = nodes.find((node) => node.id === connection.source);
  const target = nodes.find((node) => node.id === connection.target);
  if (!source || !target) return "연결 대상 노드를 찾지 못했습니다.";
  if (source.data.kind === "export") return "Export 뒤에는 노드를 연결할 수 없습니다.";
  if (target.data.kind === "input") return "Input 앞에는 노드를 연결할 수 없습니다.";
  if (target.data.kind === "branch" && source.data.kind !== "classifier") return "Branch 앞에는 Document Classifier만 연결하세요.";
  if (source.data.kind === "branch" && !connection.sourceHandle) return "Branch는 class 또는 unknown handle에서 연결하세요.";
  if (source.data.kind === "branch" && edges.some((edge) => edge.source === connection.source && edge.sourceHandle === connection.sourceHandle)) {
    return "이 branch route는 이미 후속 노드가 있습니다. 기존 선을 삭제한 뒤 다시 연결하세요.";
  }
  if (edges.some((edge) => edge.source === connection.source && edge.target === connection.target && edge.sourceHandle === connection.sourceHandle)) {
    return "이미 같은 연결이 있습니다.";
  }
  if (source.data.kind !== "branch" && edges.some((edge) => edge.source === connection.source)) {
    return "이 노드의 기존 outgoing 연결을 먼저 삭제하세요.";
  }
  return null;
}

function validateWorkflow(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  classifierDraftsByNodeId: Record<string, WorkflowClassifierDraft> = {},
  schemaDraftsByNodeId: Record<string, WorkflowSchemaDraft> = {},
  checklistDraftsByNodeId: Record<string, WorkflowChecklistDraft> = {}
) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const inputNode = nodes.find((node) => node.data.kind === "input");
  const activeNodeIds = inputNode ? reachableNodeIds(inputNode.id, edges) : new Set(nodes.map((node) => node.id));
  const inputCount = nodes.filter((node) => node.data.kind === "input").length;
  if (inputCount !== 1) errors.push("Input 노드는 정확히 1개여야 합니다.");
  if (!nodes.some((node) => node.data.kind === "export")) errors.push("Export 노드가 필요합니다.");
  nodes.forEach((node) => {
    if (!activeNodeIds.has(node.id)) {
      warnings.push(`${node.data.label} 노드는 현재 실행 경로에 연결되어 있지 않습니다.`);
      return;
    }
    if (node.data.kind === "classifier" && !node.data.config?.classifier_id && !classifierDraftsByNodeId[node.id]) {
      errors.push("문서 분류 노드에 classifier를 선택하세요.");
    }
    if (node.data.kind === "kie" && !node.data.config?.schema_id && !schemaDraftsByNodeId[node.id]) errors.push("KIE 노드에 schema를 선택하세요.");
    if (node.data.kind === "required-checker" && !node.data.config?.checklist_id && !checklistDraftsByNodeId[node.id]) {
      errors.push("필수 항목 확인 노드에 checklist를 선택하세요.");
    }
    if (node.data.kind === "branch") {
      const incoming = edges.filter((edge) => edge.target === node.id);
      if (!incoming.some((edge) => byId.get(edge.source)?.data.kind === "classifier")) errors.push("Branch 노드는 classifier 바로 뒤에 연결하세요.");
      const sourceHandles = edges.filter((edge) => edge.source === node.id).map((edge) => edge.sourceHandle || UNKNOWN_BRANCH_KEY);
      const branchKeys = normalizeBranchKeys(node.data.branchKeys);
      branchKeys.forEach((key) => {
        if (!sourceHandles.includes(key)) {
          warnings.push(`Branch ${branchKeyLabel(key)} 경로가 없습니다. 해당 문서는 분류 결과만 export됩니다.`);
        }
      });
    }
  });
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

function reachableNodeIds(startNodeId: string, edges: WorkflowEdge[]) {
  const visited = new Set<string>();
  const stack = [startNodeId];
  while (stack.length) {
    const nodeId = stack.pop();
    if (!nodeId || visited.has(nodeId)) continue;
    visited.add(nodeId);
    edges.filter((edge) => edge.source === nodeId).forEach((edge) => stack.push(edge.target));
  }
  return visited;
}

function nodeKindDescription(kind: WorkflowNodeKind) {
  const found = nodePalette.find((item) => item.kind === kind);
  return found?.description ?? kind;
}

function branchKeyLabel(key: string) {
  if (key.startsWith("class:")) return key.replace("class:", "분류 · ");
  return key;
}

function normalizeBranchKeys(keys: string[] | undefined) {
  const normalized = (keys?.length ? keys : [UNKNOWN_BRANCH_KEY])
    .filter((key) => key && key !== "default" && key !== "needs_review");
  if (!normalized.includes(UNKNOWN_BRANCH_KEY)) normalized.push(UNKNOWN_BRANCH_KEY);
  return [...new Set(normalized)];
}

function workflowStatusLabel(status: string | null | undefined) {
  const labels: Record<string, string> = {
    uploading: "업로드 중",
    preprocessing: "전처리 중",
    queued: "대기 중",
    ready: "준비 완료",
    running: "처리 중",
    paused: "일시중단",
    completed: "완료",
    completed_with_errors: "일부 실패",
    failed: "실패",
    canceled: "취소됨",
    needs_review: "검토 필요",
    complete: "완료",
    incomplete: "누락 있음"
  };
  return status ? labels[status] ?? status : "-";
}

function workflowDocumentPageSrc(page: WorkflowDocumentPage) {
  return `${API_BASE}${page.image_url}?v=${page.width}x${page.height}`;
}

function openWorkflowResultScreen(runId: string) {
  window.location.hash = `workflow-result:${encodeURIComponent(runId)}`;
}

function formatWorkflowValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function indexedChunks<T>(items: T[], size: number) {
  const chunks: { start: number; files: T[] }[] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push({ start: index, files: items.slice(index, index + size) });
  }
  return chunks;
}

function sortUploadFiles(files: File[]) {
  return [...files].sort(compareUploadFiles);
}

function compareUploadFiles(left: File, right: File) {
  return uploadFileSortKey(left).localeCompare(uploadFileSortKey(right), "ko-KR", { numeric: true, sensitivity: "base" });
}

function uploadFileSortKey(file: File) {
  const relativePath = "webkitRelativePath" in file && typeof file.webkitRelativePath === "string" ? file.webkitRelativePath : "";
  return `${file.name}\u0000${relativePath}\u0000${file.size}\u0000${file.lastModified}`;
}

function isWorkflowUploadFile(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ["pdf", "png", "jpg", "jpeg", "docx", "pptx"].includes(extension);
}

function clientFileId(file: File, index: number) {
  const relativePath = "webkitRelativePath" in file && typeof file.webkitRelativePath === "string" ? file.webkitRelativePath : "";
  return `${index}:${relativePath || file.name}:${file.size}:${file.lastModified}`;
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, options);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (typeof body.detail === "string") message = body.detail;
      if (typeof body.detail?.message === "string") message = body.detail.message;
      if (body.detail?.errors) message = body.detail.errors.join(", ");
    } catch {
      // Keep HTTP status.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}
