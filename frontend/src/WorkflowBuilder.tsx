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
  GitBranch,
  GitMerge,
  GripVertical,
  History,
  Library,
  Loader2,
  Maximize2,
  Pause,
  Play,
  Plus,
  RefreshCcw,
  Save,
  Sparkles,
  Unlink2,
  UploadCloud,
  X
} from "lucide-react";
import { ChangeEvent, CSSProperties, PointerEvent, UIEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "./apiClient";
import { API_BASE } from "./apiConfig";

const WORKFLOW_FILE_ACCEPT = ".pdf,.png,.jpg,.jpeg,.docx,.pptx";
const WORKFLOW_RUN_ROW_HEIGHT = 64;
const WORKFLOW_RUN_OVERSCAN = 8;
const WORKFLOW_RUN_HISTORY_LIMIT = 50;
const WORKFLOW_UPLOAD_CONCURRENCY = 2;
const WORKFLOW_RESULT_LEFT_WIDTH_KEY = "digitize_workflow_result_left_width_v1";
const WORKFLOW_RESULT_RIGHT_WIDTH_KEY = "digitize_workflow_result_right_width_v1";
const WORKFLOW_RESULT_MIN_LEFT_WIDTH = 220;
const WORKFLOW_RESULT_MIN_MIDDLE_WIDTH = 420;
const WORKFLOW_RESULT_MIN_RIGHT_WIDTH = 360;
const WORKFLOW_RESULT_SPLITTER_WIDTH = 12;

type WorkflowNodeKind = "input" | "classifier" | "branch" | "kie" | "required-checker" | "merge" | "export";
type WorkflowResultFilter = "all" | "success" | "failed" | "waiting" | "running" | "review";
type WorkflowClassFilterOption = {
  value: string;
  label: string;
  count: number;
};
type WorkflowUploadSource = "files" | "folder";

type WorkflowNodeData = {
  kind: WorkflowNodeKind;
  label: string;
  config?: Record<string, string>;
  branchKeys?: string[];
  connectedBranchKeys?: string[];
  configSelect?: WorkflowNodeConfigSelect;
  onConfigChange?: (nodeId: string, key: string, value: string) => void;
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

type SchemaSummary = {
  id: string;
  name: string;
  display_name: string | null;
  fields: { key_name: string }[];
};

type ClassifierSummary = {
  id: string;
  name: string;
  classes: { class_name: string; description: string; signals: string[] }[];
};

type ChecklistSummary = {
  id: string;
  name: string;
  items: { item_name: string }[];
};

type WorkflowDefinition = {
  id: string;
  name: string;
  description: string | null;
  definition: { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
  validation_warnings: string[];
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
  progress_phase?: string;
  progress: number;
  error_message: string | null;
  upload_duration_ms?: number | null;
  inference_duration_ms?: number | null;
  items: WorkflowRunItem[];
  created_at?: string;
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
  onCreateSchema: () => void;
  onCreateClassifier: () => void;
  onCreateChecklist: () => void;
};

type WorkflowDraft = {
  activeWorkflowId: string;
  workflowName: string;
  workflowDescription: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  selectedNodeId: string | null;
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
  { kind: "export", label: "Export", description: "통합 CSV/JSON 결과를 만듭니다." }
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

const nodeTypes = {
  workflow: WorkflowCanvasNode
};

export function WorkflowBuilder({ uploadMaxBatchFiles, uploadChunkFiles, onCreateSchema, onCreateClassifier, onCreateChecklist }: WorkflowBuilderProps) {
  const [initialDraft] = useState<WorkflowDraft | null>(() => readWorkflowDraft());
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [activeWorkflowId, setActiveWorkflowId] = useState(initialDraft?.activeWorkflowId ?? "");
  const [workflowName, setWorkflowName] = useState(initialDraft?.workflowName ?? "문서 자동화 워크플로우");
  const [workflowDescription, setWorkflowDescription] = useState(initialDraft?.workflowDescription ?? "");
  const [nodes, setNodes] = useState<WorkflowNode[]>(() => initialDraft?.nodes ?? defaultNodes);
  const [edges, setEdges] = useState<WorkflowEdge[]>(() => normalizeWorkflowEdges(initialDraft?.edges ?? defaultEdges));
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(initialDraft?.selectedNodeId ?? defaultNodes[1]?.id ?? null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [schemas, setSchemas] = useState<SchemaSummary[]>([]);
  const [classifiers, setClassifiers] = useState<ClassifierSummary[]>([]);
  const [checklists, setChecklists] = useState<ChecklistSummary[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [activeRunId, setActiveRunId] = useState("");
  const [runSidebarOpen, setRunSidebarOpen] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isStartingRun, setIsStartingRun] = useState(false);
  const [runStartMessage, setRunStartMessage] = useState<string | null>(null);
  const [runStartFileCount, setRunStartFileCount] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(initialDraft ? "복원됨" : null);
  const workflowStartAbortRef = useRef<AbortController | null>(null);
  const workflowStartRunIdRef = useRef<string>("");
  const workflowStartCancelRequestedRef = useRef(false);
  const workflowResumeFileInputRef = useRef<HTMLInputElement | null>(null);
  const workflowResumeFolderInputRef = useRef<HTMLInputElement | null>(null);
  const workflowResumeRunIdRef = useRef<string>("");

  const activeRun = runs.find((run) => run.id === activeRunId) ?? runs[0] ?? null;
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const canvasNodes = useMemo(
    () => buildCanvasNodes(nodes, edges, schemas, classifiers, checklists, updateNodeConfig),
    [nodes, edges, schemas, classifiers, checklists]
  );
  const validation = useMemo(() => validateWorkflow(nodes, edges), [nodes, edges]);
  const isRunningRun = Boolean(activeRun && !TERMINAL_RUN_STATUSES.includes(activeRun.status) && activeRun.status !== "waiting");
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
    if (!activeRun || TERMINAL_RUN_STATUSES.includes(activeRun.status)) return;
    const timer = window.setInterval(() => void refreshRun(activeRun.id), 1200);
    return () => window.clearInterval(timer);
  }, [activeRun?.id, activeRun?.status]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      writeWorkflowDraft({
        activeWorkflowId,
        workflowName,
        workflowDescription,
        nodes,
        edges,
        selectedNodeId
      });
      setDraftSavedAt(new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [activeWorkflowId, workflowName, workflowDescription, nodes, edges, selectedNodeId]);

  const onNodesChange = useCallback((changes: NodeChange<WorkflowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
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
      setWorkflows(loadedWorkflows);
      setSchemas(loadedSchemas);
      setClassifiers(loadedClassifiers);
      setChecklists(loadedChecklists);
      setRuns(loadedRuns);
      if (!activeWorkflowId && !initialDraft && loadedWorkflows[0]) {
        loadWorkflowIntoCanvas(loadedWorkflows[0]);
      }
      if (!activeRunId && loadedRuns[0]) {
        setActiveRunId(loadedRuns[0].id);
      }
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "워크플로우 데이터를 불러오지 못했습니다.");
    }
  }

  function loadWorkflowIntoCanvas(workflow: WorkflowDefinition) {
    setActiveWorkflowId(workflow.id);
    setWorkflowName(workflow.name);
    setWorkflowDescription(workflow.description ?? "");
    setNodes((workflow.definition.nodes?.length ? workflow.definition.nodes : defaultNodes).map(normalizeWorkflowNode));
    setEdges(normalizeWorkflowEdges(workflow.definition.edges?.length ? workflow.definition.edges : defaultEdges));
    setSelectedNodeId(workflow.definition.nodes?.[0]?.id ?? defaultNodes[0].id);
    setMessage(`불러온 워크플로우: ${workflow.name}`);
  }

  function resetWorkflowDraft() {
    setActiveWorkflowId("");
    setWorkflowName("문서 자동화 워크플로우");
    setWorkflowDescription("");
    setNodes(defaultNodes.map(normalizeWorkflowNode));
    setEdges(normalizeWorkflowEdges(defaultEdges));
    setSelectedNodeId(defaultNodes[1]?.id ?? defaultNodes[0]?.id ?? null);
    setMessage("새 워크플로우를 시작합니다.");
  }

  async function persistWorkflow() {
    if (validation.errors.length) {
      throw new Error(validation.errors[0]);
    }
    const payload = {
      name: workflowName.trim() || "문서 자동화 워크플로우",
      description: workflowDescription || null,
      definition: serializeDefinition(nodes, edges)
    };
    const saved = await api<WorkflowDefinition>(activeWorkflowId ? `/api/workflows/${activeWorkflowId}` : "/api/workflows", {
      method: activeWorkflowId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    setActiveWorkflowId(saved.id);
    setWorkflows((current) => [saved, ...current.filter((workflow) => workflow.id !== saved.id)]);
    setDraftSavedAt("저장됨");
    return saved;
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
    if (!runFiles.length) {
      setError("실행할 문서를 업로드하세요.");
      return;
    }
    if (validation.errors.length) {
      setError(`워크플로우를 실행할 수 없습니다. ${validation.errors[0]}`);
      return;
    }
    setIsStartingRun(true);
    setRunStartFileCount(runFiles.length);
    setRunStartMessage("작업 준비 중");
    setIsSaving(true);
    setError(null);
    workflowStartCancelRequestedRef.current = false;
    const abortController = new AbortController();
    workflowStartAbortRef.current = abortController;
    workflowStartRunIdRef.current = "";
    try {
      const saved = await persistWorkflow();
      const initializedRun = await api<WorkflowRun>(`/api/workflows/${saved.id}/runs/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ total_count: runFiles.length }),
        signal: abortController.signal
      });
      workflowStartRunIdRef.current = initializedRun.id;
      setRuns((current) => [initializedRun, ...current.filter((item) => item.id !== initializedRun.id)].slice(0, WORKFLOW_RUN_HISTORY_LIMIT));
      setActiveRunId(initializedRun.id);

      await uploadWorkflowFiles(initializedRun.id, runFiles, initializedRun, abortController, "문서 업로드 중");
      setRunStartMessage("작업 등록 완료");
      const run = await api<WorkflowRun>(`/api/workflow-runs/${initializedRun.id}/start`, { method: "POST", signal: abortController.signal });
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)].slice(0, WORKFLOW_RUN_HISTORY_LIMIT));
      setActiveRunId(run.id);
      setMessage("워크플로우 실행을 시작했습니다. 실행 전에 워크플로우를 저장했습니다.");
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

  async function stopStartingRun() {
    workflowStartCancelRequestedRef.current = true;
    setRunStartMessage("중단·정리 중");
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
        return [merged, ...current.filter((item) => item.id !== run.id)].slice(0, WORKFLOW_RUN_HISTORY_LIMIT);
      });
      setActiveRunId(run.id);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "워크플로우 실행 상태를 갱신하지 못했습니다.");
    }
  }

  function upsertRun(run: WorkflowRun) {
    setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)].slice(0, WORKFLOW_RUN_HISTORY_LIMIT));
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
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)].slice(0, WORKFLOW_RUN_HISTORY_LIMIT));
      setActiveRunId(run.id);
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
      setActiveRunId(run.id);
      setMessage("워크플로우 실행을 일시중단했습니다. 업로드된 문서는 보존됩니다.");
      void refreshRun(run.id);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "워크플로우를 일시중단하지 못했습니다.");
    }
  }

  async function restartRun(runId: string) {
    setError(null);
    setIsSaving(true);
    try {
      const currentRun = runs.find((item) => item.id === runId) ?? activeRun;
      if (!confirmWorkflowRestart(currentRun)) return;
      const saved = await persistWorkflow();
      const run = await api<WorkflowRun>(`/api/workflow-runs/${runId}/restart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow_id: saved.id })
      });
      upsertRun(run);
      setActiveRunId(run.id);
      setMessage("업로드된 문서는 재사용하고 새 워크플로우 실행 기록으로 다시 추론합니다.");
      void refreshRun(run.id);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "워크플로우를 재시작하지 못했습니다.");
    } finally {
      setIsSaving(false);
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
      setActiveRunId(run.id);
      setMessage("업로드된 문서를 재사용하는 워크플로우 실행을 대기열에 추가했습니다.");
      void refreshRun(run.id);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "워크플로우 실행을 대기열에 추가하지 못했습니다.");
    } finally {
      setIsSaving(false);
    }
  }

  async function startWaitingRun(runId: string) {
    setError(null);
    try {
      const run = await api<WorkflowRun>(`/api/workflow-runs/${runId}/start`, { method: "POST" });
      upsertRun(run);
      setActiveRunId(run.id);
      setMessage("대기 중인 워크플로우 실행을 바로 시작했습니다.");
      void refreshRun(run.id);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "대기 중인 워크플로우 실행을 시작하지 못했습니다.");
    }
  }

  async function cancelWaitingRun(runId: string) {
    setError(null);
    try {
      const run = await api<WorkflowRun>(`/api/workflow-runs/${runId}/cancel-waiting`, { method: "POST" });
      upsertRun(run);
      setActiveRunId(run.id);
      setMessage("워크플로우 실행 대기를 취소했습니다. 공유 문서는 보존됩니다.");
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "대기 중인 워크플로우 실행을 취소하지 못했습니다.");
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
      setRuns((current) => [latestRun, ...current.filter((item) => item.id !== latestRun.id)].slice(0, WORKFLOW_RUN_HISTORY_LIMIT));
      setActiveRunId(latestRun.id);
      latestRun = await uploadWorkflowFiles(runId, selectedFiles, latestRun, abortController, "문서 업로드 이어가는 중");

      const uploadedCount = latestRun.uploaded_count ?? latestRun.items.length;
      if (uploadedCount < latestRun.total_count) {
        setMessage(`${uploadedCount.toLocaleString()} / ${latestRun.total_count.toLocaleString()}개까지 등록했습니다. 남은 파일을 이어서 선택하세요.`);
        return;
      }
      setRunStartMessage("업로드 완료, 실행 등록 중");
      const startedRun = await api<WorkflowRun>(`/api/workflow-runs/${runId}/start`, { method: "POST", signal: abortController.signal });
      setRuns((current) => [startedRun, ...current.filter((item) => item.id !== startedRun.id)].slice(0, WORKFLOW_RUN_HISTORY_LIMIT));
      setActiveRunId(startedRun.id);
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
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)].slice(0, WORKFLOW_RUN_HISTORY_LIMIT));
      setActiveRunId(run.id);
      setMessage("워크플로우 실행 기록만 남기고 업로드 산출물을 정리했습니다.");
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "워크플로우 실행을 중단하지 못했습니다.");
    }
  }

  function addNode(kind: WorkflowNodeKind) {
    const palette = nodePalette.find((item) => item.kind === kind);
    const node = workflowNode(kind, palette?.label ?? kind, 160 + nodes.length * 48, 260 + nodes.length * 16);
    setNodes((current) => [...current, node]);
    setSelectedNodeId(node.id);
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
      <main className="workflow-builder">
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
              <input
                value={workflowDescription}
                onChange={(event) => setWorkflowDescription(event.target.value)}
                placeholder="설명"
                aria-label="워크플로우 설명"
              />
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
            <button type="button" className="secondary" onClick={() => void refreshAll()}>
              <Library size={16} /> 갱신
            </button>
            <button type="button" onClick={() => void saveWorkflow()} disabled={isSaving || validation.errors.length > 0}>
              {isSaving ? <Loader2 size={16} className="spin" /> : <Save size={16} />} 저장
            </button>
            {selectedEdge && (
              <div className="workflow-edge-actions">
                <span>{edgeLabel(selectedEdge, nodes)}</span>
                <button type="button" className="secondary" onClick={deleteSelectedEdge}>
                  <Unlink2 size={15} /> 선 삭제
                </button>
              </div>
            )}
            <span className="workflow-autosave">
              자동 저장 {draftSavedAt ?? "대기"}
            </span>
          </div>

          <div className="workflow-canvas">
            <ReactFlow
              nodes={canvasNodes}
              edges={canvasEdges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_, node) => {
                setSelectedNodeId(node.id);
                setSelectedEdgeId(null);
              }}
              onEdgeClick={(_, edge) => {
                setSelectedEdgeId(edge.id);
                setSelectedNodeId(null);
              }}
              onPaneClick={() => setSelectedEdgeId(null)}
              deleteKeyCode={["Backspace", "Delete"]}
              fitView
            >
              <Background />
              <Controls />
              <MiniMap pannable zoomable />
            </ReactFlow>

            {isStartingRun ? (
              <WorkflowRunPreparingDock
                fileCount={runStartFileCount || files.length}
                message={runStartMessage ?? "작업 준비 중"}
                onPause={() => void pauseStartingRun()}
                onDiscard={() => void stopStartingRun()}
              />
            ) : activeRun ? (
              <WorkflowRunProgressDock
                run={activeRun}
                canStartWaiting={workflowRunCanStartWaiting(activeRun, runs)}
                onOpen={() => openWorkflowResultScreen(activeRun.id)}
                onRefresh={() => void refreshRun(activeRun.id)}
                onResume={() => void resumeRun(activeRun.id)}
                onPause={() => void pauseRun(activeRun.id)}
                onRestart={() => void restartRun(activeRun.id)}
                onEnqueue={() => void enqueueRun(activeRun.id)}
                onStartWaiting={() => void startWaitingRun(activeRun.id)}
                onCancelWaiting={() => void cancelWaitingRun(activeRun.id)}
                onResumeUpload={(source) => source === "folder" ? requestResumeFolderUpload(activeRun.id) : requestResumeUpload(activeRun.id)}
                onDiscard={() => void discardRun(activeRun.id)}
              />
            ) : null}

          </div>

          <button
            type="button"
            className={`workflow-run-sidebar-toggle ${runSidebarOpen ? "open" : ""}`}
            onClick={() => setRunSidebarOpen((current) => !current)}
            aria-expanded={runSidebarOpen}
            title={runSidebarOpen ? "실행 기록 접기" : "실행 기록 펼치기"}
          >
            {runSidebarOpen ? <ChevronRight size={16} /> : <History size={16} />}
            <span>실행 기록</span>
          </button>
          {runSidebarOpen && (
            <aside className="workflow-run-sidebar" aria-label="워크플로우 실행 기록 사이드바">
              <WorkflowRunHistory
                runs={runs}
                activeRunId={activeRunId}
                onOpen={(runId) => openWorkflowResultScreen(runId)}
                onRefresh={() => void refreshAll()}
                onEnqueue={(runId) => void enqueueRun(runId)}
                onStartWaiting={(runId) => void startWaitingRun(runId)}
                onCancelWaiting={(runId) => void cancelWaitingRun(runId)}
              />
            </aside>
          )}

          <div className="workflow-run-bar">
            <WorkflowUploadButton
              disabled={isStartingRun || isRunningRun}
              selectedCount={files.length}
              onChange={onFileInput}
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
              disabled={isStartingRun || isRunningRun || !files.length}
              title={runButtonTitle}
            >
              {isStartingRun || isRunningRun ? <Loader2 size={16} className="spin" /> : <Play size={16} />}
              {isStartingRun ? "시작 중" : isRunningRun ? "실행 중" : "실행"}
            </button>
            {activeRun && (
              <>
                <a className="link-button secondary" href={`${API_BASE}/api/workflow-runs/${activeRun.id}/export?format=csv`}>
                  <Download size={15} /> CSV
                </a>
                <a className="link-button secondary" href={`${API_BASE}/api/workflow-runs/${activeRun.id}/export?format=json`}>
                  <FileJson size={15} /> JSON
                </a>
              </>
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

        </section>
      </main>
    </ReactFlowProvider>
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

  async function restartRun() {
    try {
      if (!confirmWorkflowRestart(run)) return;
      const nextRun = await api<WorkflowRun>(`/api/workflow-runs/${runId}/restart`, { method: "POST" });
      setRun(nextRun);
      setSelectedItemId((current) => current ?? nextRun.items[0]?.id ?? null);
      setError(null);
      if (nextRun.id !== runId) {
        openWorkflowResultScreen(nextRun.id);
      } else {
        void refreshRun();
      }
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "워크플로우를 재시작하지 못했습니다.");
    }
  }

  async function enqueueRun() {
    try {
      const nextRun = await api<WorkflowRun>(`/api/workflow-runs/${runId}/enqueue`, { method: "POST" });
      setRun(nextRun);
      setSelectedItemId((current) => current ?? nextRun.items[0]?.id ?? null);
      setError(null);
      if (nextRun.id !== runId) {
        openWorkflowResultScreen(nextRun.id);
      } else {
        void refreshRun();
      }
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "워크플로우 실행을 대기열에 추가하지 못했습니다.");
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

  async function cancelWaitingRun() {
    try {
      const nextRun = await api<WorkflowRun>(`/api/workflow-runs/${runId}/cancel-waiting`, { method: "POST" });
      setRun(nextRun);
      setError(null);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "대기 중인 워크플로우 실행을 취소하지 못했습니다.");
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
          onRefresh={() => void refreshRun()}
          onResume={() => void resumeRun()}
          onPause={() => void pauseRun()}
          onRestart={() => void restartRun()}
          onEnqueue={() => void enqueueRun()}
          onStartWaiting={() => void startWaitingRun()}
          onCancelWaiting={() => void cancelWaitingRun()}
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
    <div className={`workflow-node workflow-node-${kind} ${data.configSelect ? "workflow-node-configurable" : ""} ${selected ? "selected" : ""}`}>
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
        <div className="workflow-upload-menu" role="menu">
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
  const menu = useWorkflowUploadMenu();
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
        <div className="workflow-upload-menu workflow-upload-menu-right" role="menu">
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

function useWorkflowUploadMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (event.target instanceof globalThis.Node && ref.current?.contains(event.target)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return {
    open,
    ref,
    close: () => setOpen(false),
    toggle: () => setOpen((current) => !current)
  };
}

function WorkflowRunProgressDock(props: {
  run: WorkflowRun;
  canStartWaiting?: boolean;
  onOpen: () => void;
  onRefresh: () => void;
  onResume: () => void;
  onPause: () => void;
  onRestart: () => void;
  onEnqueue: () => void;
  onStartWaiting: () => void;
  onCancelWaiting: () => void;
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
    <div className="workflow-progress-dock" aria-label="워크플로우 실행 진행상황">
      <div className="workflow-progress-dock-head">
        <div>
          <p className="eyebrow">Run</p>
          <h3>{props.run.workflow_name || "워크플로우"} · {workflowRunHeadline(props.run)} · {percent}%</h3>
        </div>
        <div className="workflow-run-kpis">
          <span><strong>{uploadedCount}</strong> / {props.run.total_count.toLocaleString()} 업로드됨</span>
          {preprocessingCount ? <span><strong>{preprocessingCount}</strong> 전처리 중</span> : null}
          <span><strong>{runningCount}</strong> 실행 중</span>
          <span><strong>{queuedCount}</strong> 대기</span>
          <span><strong>{finishedCount}</strong> 완료/검토/실패</span>
          <span><strong>{formatDurationMs(props.run.upload_duration_ms)}</strong> 업로드</span>
          <span><strong>{formatDurationMs(props.run.inference_duration_ms)}</strong> 추론</span>
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
              <Pause size={15} /> 일시중단
            </button>
          )}
          {workflowRunCanRestart(props.run) && (
            <button type="button" className="secondary" onClick={props.onRestart}>
              <Play size={15} /> 재시작
            </button>
          )}
          {workflowRunCanEnqueue(props.run) && (
            <button type="button" className="secondary" onClick={props.onEnqueue}>
              <Plus size={15} /> 대기열 추가
            </button>
          )}
          {workflowRunCanStartWaiting(props.run) && props.canStartWaiting !== false && (
            <button type="button" className="secondary" onClick={props.onStartWaiting}>
              <Play size={15} /> 바로 실행
            </button>
          )}
          {workflowRunCanCancelWaiting(props.run) && (
            <button type="button" className="secondary danger-outline" onClick={props.onCancelWaiting}>
              <X size={15} /> 대기 취소
            </button>
          )}
          {workflowRunCanDiscard(props.run) && (
            <button type="button" className="secondary danger-outline" onClick={props.onDiscard}>
              <X size={15} /> 중단·정리
            </button>
          )}
          <button type="button" className="secondary" onClick={props.onRefresh}>갱신</button>
        </div>
      </div>
      <progress className="workflow-run-progress" value={props.run.progress} max={1} />
    </div>
  );
}

function WorkflowRunPreparingDock(props: {
  fileCount: number;
  message: string;
  onPause: () => void;
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
          <button type="button" className="secondary" onClick={props.onPause}>
            <Pause size={15} /> 일시중단
          </button>
          <button type="button" className="secondary danger-outline" onClick={props.onDiscard}>
            <X size={15} /> 중단·정리
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
  onOpen: (runId: string) => void;
  onRefresh: () => void;
  onEnqueue: (runId: string) => void;
  onStartWaiting: (runId: string) => void;
  onCancelWaiting: (runId: string) => void;
}) {
  return (
    <section className="workflow-run-history" aria-label="워크플로우 실행 기록">
      <div className="workflow-run-history-head">
        <div>
          <p className="eyebrow">History</p>
          <h3>실행 기록</h3>
        </div>
        <button type="button" className="secondary compact" onClick={props.onRefresh}>
          <Library size={14} /> 새로고침
        </button>
      </div>
      {props.runs.length ? (
        <div className="workflow-run-history-list">
          {props.runs.map((run) => {
            const finishedCount = workflowRunFinishedCount(run);
            const isActive = run.id === props.activeRunId;
            const percent = Math.round(run.progress * 100);
            return (
              <article key={run.id} className={`workflow-run-history-item ${isActive ? "active" : ""}`}>
                <div className="workflow-run-history-main">
                  <span className="workflow-run-history-status">{workflowRunStatusLabel(run)}</span>
                  <strong>{run.workflow_name || "워크플로우"} · {workflowRunHeadline(run)}</strong>
                  <small>
                    {formatWorkflowRunDate(run.created_at)} · {run.id} · {finishedCount.toLocaleString()} / {run.total_count.toLocaleString()} 처리
                    {run.restarted_from_run_id ? ` · 재시작 원본 ${run.restarted_from_run_id}` : ""}
                    {run.queued_from_run_id ? ` · 대기 원본 ${run.queued_from_run_id}` : ""}
                    {run.queue_order ? ` · 대기열 #${run.queue_order}` : ""}
                    {run.failed_count ? ` · ${run.failed_count.toLocaleString()} 실패` : ""}
                    {run.needs_review_count ? ` · ${run.needs_review_count.toLocaleString()} 검토` : ""}
                  </small>
                  <div className="workflow-run-history-progress" aria-label={`${percent}%`}>
                    <div><span style={{ width: `${percent}%` }} /></div>
                    <em>{percent}%</em>
                  </div>
                </div>
                <div className="workflow-run-history-actions">
                  {workflowRunCanEnqueue(run) && (
                    <button type="button" className="secondary" onClick={() => props.onEnqueue(run.id)}>
                      <Plus size={14} /> 대기 추가
                    </button>
                  )}
                  {workflowRunCanStartWaiting(run, props.runs) && (
                    <button type="button" className="secondary" onClick={() => props.onStartWaiting(run.id)}>
                      <Play size={14} /> 바로 실행
                    </button>
                  )}
                  {workflowRunCanCancelWaiting(run) && (
                    <button type="button" className="secondary danger-outline" onClick={() => props.onCancelWaiting(run.id)}>
                      <X size={14} /> 대기 삭제
                    </button>
                  )}
                  <button type="button" className="secondary" onClick={() => props.onOpen(run.id)}>
                    <Maximize2 size={14} /> 결과 보기
                  </button>
                  <a className="link-button secondary" href={`${API_BASE}/api/workflow-runs/${run.id}/export?format=csv`}>
                    <Download size={14} /> CSV
                  </a>
                  <a className="link-button secondary" href={`${API_BASE}/api/workflow-runs/${run.id}/export?format=json`}>
                    <FileJson size={14} /> JSON
                  </a>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="workflow-run-history-empty">
          <History size={18} />
          <span>아직 실행 기록이 없습니다.</span>
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
  onRefresh: () => void;
  onResume?: () => void;
  onPause?: () => void;
  onRestart?: () => void;
  onEnqueue?: () => void;
  onStartWaiting?: () => void;
  onCancelWaiting?: () => void;
  onRetryFailed?: () => void;
  onDiscard?: () => void;
  onClose: () => void;
}) {
  const finishedCount = workflowRunFinishedCount(props.run);
  const [statusFilter, setStatusFilter] = useState<WorkflowResultFilter>("all");
  const [classFilter, setClassFilter] = useState("all");
  const [leftWidth, setLeftWidth] = useState(() => readWorkflowResultPaneWidth(WORKFLOW_RESULT_LEFT_WIDTH_KEY, 280));
  const [rightWidth, setRightWidth] = useState(() => readWorkflowResultPaneWidth(WORKFLOW_RESULT_RIGHT_WIDTH_KEY, 520));
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

  return (
    <section className="workflow-results">
      <div className="workflow-results-header">
        <div>
          <p className="eyebrow">Run</p>
          <h2>{props.run.workflow_name || "워크플로우"} · {workflowRunHeadline(props.run)} · {Math.round(props.run.progress * 100)}%</h2>
        </div>
        <div className="workflow-run-kpis">
          <span><strong>{finishedCount}</strong> 완료/검토/실패</span>
          <span><strong>{props.run.preprocessing_count ?? props.run.items.filter((item) => item.status === "preprocessing").length}</strong> 전처리 중</span>
          <span><strong>{props.run.running_count ?? props.run.items.filter((item) => item.status === "running").length}</strong> 실행 중</span>
          <span><strong>{props.run.queued_count ?? props.run.items.filter((item) => item.status === "queued").length}</strong> 대기</span>
          <span><strong>{formatDurationMs(props.run.upload_duration_ms)}</strong> 업로드</span>
          <span><strong>{formatDurationMs(props.run.inference_duration_ms)}</strong> 추론</span>
        </div>
        <div className="workflow-results-actions">
          <a className="link-button secondary" href={`${API_BASE}/api/workflow-runs/${props.run.id}/export?format=csv`}>
            <Download size={15} /> CSV
          </a>
          <a className="link-button secondary" href={`${API_BASE}/api/workflow-runs/${props.run.id}/export?format=json`}>
            <FileJson size={15} /> JSON
          </a>
          <button type="button" className="secondary" onClick={props.onClose}>
            <X size={15} /> 닫기
          </button>
          {props.onResume && workflowRunCanResume(props.run) && (
            <button type="button" className="secondary" onClick={props.onResume}>
              <Play size={15} /> 이어하기
            </button>
          )}
          {props.onPause && workflowRunCanPause(props.run) && (
            <button type="button" className="secondary" onClick={props.onPause}>
              <Pause size={15} /> 일시중단
            </button>
          )}
          {props.onRestart && workflowRunCanRestart(props.run) && (
            <button type="button" className="secondary" onClick={props.onRestart}>
              <Play size={15} /> 재시작
            </button>
          )}
          {props.onEnqueue && workflowRunCanEnqueue(props.run) && (
            <button type="button" className="secondary" onClick={props.onEnqueue}>
              <Plus size={15} /> 대기열 추가
            </button>
          )}
          {props.onStartWaiting && workflowRunCanStartWaiting(props.run) && (
            <button type="button" className="secondary" onClick={props.onStartWaiting}>
              <Play size={15} /> 바로 실행
            </button>
          )}
          {props.onCancelWaiting && workflowRunCanCancelWaiting(props.run) && (
            <button type="button" className="secondary danger-outline" onClick={props.onCancelWaiting}>
              <X size={15} /> 대기 취소
            </button>
          )}
          {props.onRetryFailed && workflowRunCanRetryFailed(props.run) && (
            <button type="button" className="secondary" onClick={props.onRetryFailed}>
              <RefreshCcw size={15} /> 실패 재시도
            </button>
          )}
          {props.onDiscard && workflowRunCanDiscard(props.run) && (
            <button type="button" className="secondary danger-outline" onClick={props.onDiscard}>
              <X size={15} /> 중단·정리
            </button>
          )}
          <button type="button" className="secondary" onClick={props.onRefresh}>갱신</button>
        </div>
      </div>
      <progress className="workflow-run-progress" value={props.run.progress} max={1} />
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
  return run.completed_count + run.failed_count + run.needs_review_count;
}

const workflowResultFilterOptions: { value: WorkflowResultFilter; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "success", label: "성공" },
  { value: "failed", label: "실패" },
  { value: "waiting", label: "대기" },
  { value: "running", label: "실행" },
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
    { value: "all", label: "전체 class", count: items.length },
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
  return run.status !== "canceled" && run.items.length > 0 && (uploadedCount === run.total_count || run.status === "paused");
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

function workflowRunCanCancelWaiting(run: WorkflowRun) {
  return run.status === "waiting";
}

function workflowRunCanDiscard(run: WorkflowRun) {
  return run.status !== "waiting" && !["completed", "completed_with_errors", "needs_review", "canceled"].includes(run.status);
}

function workflowRunQueueGroup(run: WorkflowRun, runs: WorkflowRun[]) {
  const groupId = run.workflow_run_group_id ?? run.id;
  return runs.filter((item) => (item.workflow_run_group_id ?? item.id) === groupId);
}

function compareWorkflowQueueRuns(a: WorkflowRun, b: WorkflowRun) {
  return compareWorkflowQueuePositions(workflowRunQueuePosition(a), workflowRunQueuePosition(b));
}

function workflowRunQueuePosition(run: WorkflowRun): [number, number, string] {
  return [run.queue_order ?? 0, run.created_at ? Date.parse(run.created_at) || 0 : 0, run.id];
}

function compareWorkflowQueuePositions(a: [number, number, string], b: [number, number, string]) {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2].localeCompare(b[2]);
}

function workflowRunHeadline(run: WorkflowRun) {
  if (run.status === "waiting" || run.progress_phase === "waiting") return "실행 대기";
  if (run.status === "paused" || run.progress_phase === "paused") return "일시중단";
  if (workflowRunCanResumeUpload(run) || run.progress_phase === "uploading") return "문서 업로드 중";
  if (run.progress_phase === "preprocessing") return "문서 전처리 중";
  if (!TERMINAL_RUN_STATUSES.includes(run.status) && run.progress < 1) return "작업 진행 중";
  return "작업 완료";
}

function workflowRunStatusLabel(run: WorkflowRun) {
  if (run.status === "uploading") return "업로드 중";
  if (run.status === "preprocessing") return "전처리 중";
  if (run.status === "paused") return "일시중단";
  if (run.status === "waiting") return "실행 대기";
  if (run.status === "running") return "실행 중";
  if (run.status === "queued") return "대기";
  if (run.status === "failed") return "실패";
  if (run.status === "completed_with_errors") return "일부 실패";
  if (run.status === "needs_review") return "검토 필요";
  if (run.status === "canceled") return "취소";
  return "완료";
}

function formatWorkflowRunDate(value: string | undefined | null) {
  if (!value) return "실행 시간 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "실행 시간 없음";
  return date.toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
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

function confirmWorkflowRestart(run: WorkflowRun | null | undefined) {
  if (!run) return true;
  const inferredCount = run.items.filter((item) =>
    ["completed", "failed", "needs_review", "running", "paused"].includes(item.status) || item.inference_duration_ms !== null && item.inference_duration_ms !== undefined
  ).length;
  return window.confirm(
    `현재 ${inferredCount.toLocaleString()} / ${run.total_count.toLocaleString()}개 문서에 추론 결과나 진행 기록이 있습니다.\n\n재시작하면 업로드된 원본은 재사용하고, 새 실행 기록을 만들어 처음부터 다시 추론합니다. 기존 실행 기록과 export는 HISTORY에 남습니다.\n\n계속할까요?`
  );
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
        <button type="button" onClick={() => props.onPage(Math.max(0, safePage - 1))}>
          <ChevronLeft size={15} />
        </button>
        <span>{safePage + 1} / {document.page_count}</span>
        <button type="button" onClick={() => props.onPage(Math.min(document.page_count - 1, safePage + 1))}>
          <ChevronRight size={15} />
        </button>
        {props.item?.result.current_node_label && <strong>{props.item.result.current_node_label} 진행 중</strong>}
      </div>
      <div className="workflow-preview-stage">
        <div className="workflow-preview-image-wrap">
          {page && <img src={workflowDocumentPageSrc(page)} alt={`${document.filename} ${safePage + 1}페이지`} />}
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
      {item.status === "running" && <div className="workflow-running-skeleton">모듈 실행 결과를 기다리는 중입니다.</div>}
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
  onConfigChange: (nodeId: string, key: string, value: string) => void
): WorkflowNode[] {
  return nodes.map((node) => {
    const configSelect = workflowNodeConfigSelect(node, schemas, classifiers, checklists);
    const connectedBranchKeys = edges
      .filter((edge) => edge.source === node.id && edge.sourceHandle)
      .map((edge) => String(edge.sourceHandle));
    return {
      ...node,
      data: {
        ...node.data,
        connectedBranchKeys: node.data.kind === "branch" ? connectedBranchKeys : undefined,
        configSelect,
        onConfigChange: configSelect ? onConfigChange : undefined
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
      options: classifiers.map((item) => ({ value: item.id, label: `${item.name} · ${item.classes.length} classes` }))
    };
  }
  if (node.data.kind === "kie") {
    return {
      key: "schema_id",
      label: "Schema",
      placeholder: "Schema 선택",
      value: node.data.config?.schema_id ?? "",
      options: schemas.map((item) => ({ value: item.id, label: `${item.display_name || item.name} · ${item.fields.length} fields` }))
    };
  }
  if (node.data.kind === "required-checker") {
    return {
      key: "checklist_id",
      label: "Checklist",
      placeholder: "Checklist 선택",
      value: node.data.config?.checklist_id ?? "",
      options: checklists.map((item) => ({ value: item.id, label: `${item.name} · ${item.items.length} items` }))
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

function syncBranchKeys(nodes: WorkflowNode[], classifierId: string, classifiers: ClassifierSummary[]) {
  const classifier = classifiers.find((item) => item.id === classifierId);
  const branchKeys = [
    ...(classifier?.classes.map((item) => `class:${item.class_name}`) ?? []),
    UNKNOWN_BRANCH_KEY
  ];
  return nodes.map((node) => {
    if (node.data.kind !== "branch") return node;
    return { ...node, data: { ...node.data, branchKeys } };
  });
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
      workflowDescription: typeof parsed.workflowDescription === "string" ? parsed.workflowDescription : "",
      nodes: parsed.nodes.map(normalizeWorkflowNode),
      edges: normalizeWorkflowEdges(parsed.edges as WorkflowEdge[]),
      selectedNodeId: typeof parsed.selectedNodeId === "string" ? parsed.selectedNodeId : parsed.nodes[0]?.id ?? null
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
        }))
      })
    );
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
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

function validateWorkflow(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
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
    if (node.data.kind === "classifier" && !node.data.config?.classifier_id) errors.push("문서 분류 노드에 classifier를 선택하세요.");
    if (node.data.kind === "kie" && !node.data.config?.schema_id) errors.push("KIE 노드에 schema를 선택하세요.");
    if (node.data.kind === "required-checker" && !node.data.config?.checklist_id) errors.push("필수 항목 확인 노드에 checklist를 선택하세요.");
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
  if (key.startsWith("class:")) return key.replace("class:", "class · ");
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
    running: "실행 중",
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
