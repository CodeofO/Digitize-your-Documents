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
  Library,
  Loader2,
  Maximize2,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  Save,
  Sparkles,
  Unlink2,
  UploadCloud,
  X
} from "lucide-react";
import { ChangeEvent, useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "./apiClient";
import { API_BASE } from "./apiConfig";

const WORKFLOW_FILE_ACCEPT = ".pdf,.png,.jpg,.jpeg,.docx,.pptx";

type WorkflowNodeKind = "input" | "classifier" | "branch" | "kie" | "required-checker" | "merge" | "export";

type WorkflowNodeData = {
  kind: WorkflowNodeKind;
  label: string;
  config?: Record<string, string>;
  branchKeys?: string[];
  connectedBranchKeys?: string[];
};

type WorkflowNode = Node<WorkflowNodeData>;
type WorkflowEdge = Edge;

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
  status: string;
  error_message: string | null;
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
  status: string;
  total_count: number;
  completed_count: number;
  failed_count: number;
  needs_review_count: number;
  progress: number;
  error_message: string | null;
  items: WorkflowRunItem[];
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
  settingsCollapsed?: boolean;
};

const WORKFLOW_DRAFT_KEY = "digitize_workflow_builder_draft_v1";
const TERMINAL_RUN_STATUSES = ["completed", "completed_with_errors", "needs_review", "failed", "canceled"];
const UNKNOWN_BRANCH_KEY = "unknown";

const nodePalette: { kind: WorkflowNodeKind; label: string; description: string }[] = [
  { kind: "input", label: "문서 입력", description: "단일/배치 문서를 자동 판단합니다." },
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

export function WorkflowBuilder({ onCreateSchema, onCreateClassifier, onCreateChecklist }: WorkflowBuilderProps) {
  const [initialDraft] = useState<WorkflowDraft | null>(() => readWorkflowDraft());
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [activeWorkflowId, setActiveWorkflowId] = useState(initialDraft?.activeWorkflowId ?? "");
  const [workflowName, setWorkflowName] = useState(initialDraft?.workflowName ?? "문서 자동화 워크플로우");
  const [workflowDescription, setWorkflowDescription] = useState(initialDraft?.workflowDescription ?? "");
  const [nodes, setNodes] = useState<WorkflowNode[]>(() => initialDraft?.nodes ?? defaultNodes);
  const [edges, setEdges] = useState<WorkflowEdge[]>(() => normalizeWorkflowEdges(initialDraft?.edges ?? defaultEdges));
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(initialDraft?.selectedNodeId ?? defaultNodes[1]?.id ?? null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [settingsCollapsed, setSettingsCollapsed] = useState(Boolean(initialDraft?.settingsCollapsed));
  const [schemas, setSchemas] = useState<SchemaSummary[]>([]);
  const [classifiers, setClassifiers] = useState<ClassifierSummary[]>([]);
  const [checklists, setChecklists] = useState<ChecklistSummary[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [activeRunId, setActiveRunId] = useState("");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isStartingRun, setIsStartingRun] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(initialDraft ? "복원됨" : null);
  const [selectedDocument, setSelectedDocument] = useState<WorkflowDocument | null>(null);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [activeDocumentPage, setActiveDocumentPage] = useState(0);
  const [resultsOverlayOpen, setResultsOverlayOpen] = useState(false);

  const activeWorkflow = workflows.find((workflow) => workflow.id === activeWorkflowId) ?? null;
  const activeRun = runs.find((run) => run.id === activeRunId) ?? runs[0] ?? null;
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const canvasNodes = useMemo(() => buildCanvasNodes(nodes, edges), [nodes, edges]);
  const selectedRunItem =
    activeRun?.items.find((item) => item.id === selectedItemId) ?? activeRun?.items[0] ?? null;
  const validation = useMemo(() => validateWorkflow(nodes, edges), [nodes, edges]);
  const uploadMode = files.length > 1 ? "배치 실행" : files.length === 1 ? "단일 실행" : "파일 없음";
  const isRunningRun = Boolean(activeRun && !TERMINAL_RUN_STATUSES.includes(activeRun.status));
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
        selectedNodeId,
        settingsCollapsed
      });
      setDraftSavedAt(new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [activeWorkflowId, workflowName, workflowDescription, nodes, edges, selectedNodeId, settingsCollapsed]);

  useEffect(() => {
    let canceled = false;
    setActiveDocumentPage(0);
    setSelectedDocument(null);
    if (!selectedRunItem?.document_id) return;
    setDocumentLoading(true);
    api<WorkflowDocument>(`/api/documents/${selectedRunItem.document_id}`)
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
  }, [selectedRunItem?.document_id]);

  useEffect(() => {
    if (!resultsOverlayOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setResultsOverlayOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [resultsOverlayOpen]);

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
    const confirmationMessage = sharedTargetConfirmation(connection, nodes, edges);
    if (confirmationMessage && !window.confirm(confirmationMessage)) {
      setMessage("연결을 취소했습니다.");
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
        api<WorkflowRun[]>("/api/workflow-runs?limit=12")
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
        setSelectedItemId(loadedRuns[0].items[0]?.id ?? null);
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
    const runFiles = [...files];
    if (!runFiles.length) {
      setError("실행할 문서를 업로드하세요.");
      return;
    }
    if (validation.errors.length) {
      setError(`워크플로우를 실행할 수 없습니다. ${validation.errors[0]}`);
      return;
    }
    setIsStartingRun(true);
    setIsSaving(true);
    setError(null);
    try {
      const saved = await persistWorkflow();
      const form = new FormData();
      runFiles.forEach((file) => form.append("files", file));
      const run = await api<WorkflowRun>(`/api/workflows/${saved.id}/runs`, {
        method: "POST",
        body: form
      });
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)].slice(0, 12));
      setActiveRunId(run.id);
      setSelectedItemId(run.items[0]?.id ?? null);
      setSelectedDocument(null);
      setActiveDocumentPage(0);
      setResultsOverlayOpen(false);
      setMessage(`${uploadMode}을 시작했습니다. 실행 전에 워크플로우를 저장했습니다.`);
      void refreshRun(run.id);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "워크플로우 실행에 실패했습니다.");
    } finally {
      setIsStartingRun(false);
      setIsSaving(false);
    }
  }

  async function refreshRun(runId: string) {
    try {
      const run = await api<WorkflowRun>(`/api/workflow-runs/${runId}`);
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)].slice(0, 12));
      setActiveRunId(run.id);
      setSelectedItemId((current) => current ?? run.items[0]?.id ?? null);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "워크플로우 실행 상태를 갱신하지 못했습니다.");
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
    const nextFiles = Array.from(event.target.files ?? []);
    nextFiles.sort((a, b) => a.name.localeCompare(b.name));
    setFiles(nextFiles);
    event.currentTarget.value = "";
  }

  return (
    <ReactFlowProvider>
      <main className={`workflow-builder ${settingsCollapsed ? "settings-collapsed" : ""}`}>
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
            {activeRun && (
              <button type="button" className="secondary" onClick={() => setResultsOverlayOpen((current) => !current)}>
                {resultsOverlayOpen ? <X size={16} /> : <Maximize2 size={16} />}
                {resultsOverlayOpen ? "결과 닫기" : "결과 상세보기"}
              </button>
            )}
            <span className="workflow-autosave">
              자동 저장 {draftSavedAt ?? "대기"}
            </span>
          </div>

          <div className={`workflow-canvas ${resultsOverlayOpen && activeRun ? "results-overlay-open" : ""}`}>
            <ReactFlow
              nodes={canvasNodes}
              edges={edges}
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

            {activeRun && (
              <WorkflowRunProgressDock
                run={activeRun}
                onOpen={() => setResultsOverlayOpen(true)}
                onRefresh={() => void refreshRun(activeRun.id)}
              />
            )}

          </div>

          <div className="workflow-run-bar">
            <label className={`workflow-upload ${isStartingRun || isRunningRun ? "disabled" : ""}`}>
              <UploadCloud size={17} />
              <span>{files.length ? `${files.length}개 파일 선택됨 · ${uploadMode}` : "문서 업로드"}</span>
              <input type="file" multiple accept={WORKFLOW_FILE_ACCEPT} onChange={onFileInput} disabled={isStartingRun || isRunningRun} />
            </label>
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

          {(error || message || validation.errors.length > 0 || validation.warnings.length > 0 || activeWorkflow?.validation_warnings.length) && (
            <div className="workflow-validation">
              {error && <span className="danger"><AlertTriangle size={14} /> {error}</span>}
              {message && <span><CheckCircle2 size={14} /> {message}</span>}
              {validation.errors.map((item) => <span key={item} className="danger"><AlertTriangle size={14} /> {item}</span>)}
              {validation.warnings.map((item) => <span key={item}><AlertTriangle size={14} /> {item}</span>)}
              {activeWorkflow?.validation_warnings.map((item) => <span key={item}><AlertTriangle size={14} /> {item}</span>)}
            </div>
          )}

        </section>

        <button
          type="button"
          className="secondary icon-only workflow-settings-toggle"
          aria-label={settingsCollapsed ? "노드 설정 패널 펼치기" : "노드 설정 패널 접기"}
          title={settingsCollapsed ? "노드 설정 패널 펼치기" : "노드 설정 패널 접기"}
          onClick={() => setSettingsCollapsed((current) => !current)}
        >
          {settingsCollapsed ? <PanelRightOpen size={18} /> : <PanelRightClose size={18} />}
        </button>

        {!settingsCollapsed && (
          <aside className="workflow-settings" aria-label="노드 설정">
            <NodeSettings
              node={selectedNode}
              schemas={schemas}
              classifiers={classifiers}
              checklists={checklists}
              onConfig={updateNodeConfig}
              onCreateSchema={onCreateSchema}
              onCreateClassifier={onCreateClassifier}
              onCreateChecklist={onCreateChecklist}
            />
          </aside>
        )}

        {activeRun && resultsOverlayOpen && (
          <div className="workflow-results-overlay" role="dialog" aria-modal="true" aria-label="워크플로우 실행 결과 상세">
            <button
              type="button"
              className="workflow-results-backdrop"
              aria-label="결과 상세 닫기"
              onClick={() => setResultsOverlayOpen(false)}
            />
            <div className="workflow-results-modal">
              <WorkflowRunResults
                run={activeRun}
                selectedItem={selectedRunItem}
                document={selectedDocument}
                documentLoading={documentLoading}
                activePage={activeDocumentPage}
                onSelectItem={(itemId) => setSelectedItemId(itemId)}
                onPage={setActiveDocumentPage}
                onRefresh={() => void refreshRun(activeRun.id)}
                onClose={() => setResultsOverlayOpen(false)}
              />
            </div>
          </div>
        )}
      </main>
    </ReactFlowProvider>
  );
}

function WorkflowCanvasNode({ data, selected }: NodeProps<WorkflowNode>) {
  const kind = data.kind;
  const branchKeys = normalizeBranchKeys(data.branchKeys);
  const connectedBranchKeys = new Set(data.connectedBranchKeys ?? []);
  return (
    <div className={`workflow-node workflow-node-${kind} ${selected ? "selected" : ""}`}>
      {kind !== "input" && <Handle className="workflow-handle workflow-handle-target" type="target" position={Position.Left} />}
      <div className="workflow-node-title">
        <NodeIcon kind={kind} />
        <strong>{data.label}</strong>
      </div>
      <span>{nodeKindDescription(kind)}</span>
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

function NodeSettings(props: {
  node: WorkflowNode | null;
  schemas: SchemaSummary[];
  classifiers: ClassifierSummary[];
  checklists: ChecklistSummary[];
  onConfig: (nodeId: string, key: string, value: string) => void;
  onCreateSchema: () => void;
  onCreateClassifier: () => void;
  onCreateChecklist: () => void;
}) {
  if (!props.node) {
    return (
      <div className="workflow-panel-empty">
        <p className="eyebrow">Settings</p>
        <h2>노드를 선택하세요</h2>
      </div>
    );
  }
  const kind = props.node.data.kind;
  return (
    <div className="workflow-node-settings">
      <p className="eyebrow">Node</p>
      <h2>{props.node.data.label}</h2>
      <p>{nodeKindDescription(kind)}</p>
      {kind === "classifier" && (
        <ConfigSelect
          label="분류기"
          value={props.node.data.config?.classifier_id ?? ""}
          options={props.classifiers.map((item) => ({ value: item.id, label: `${item.name} · ${item.classes.length} classes` }))}
          onChange={(value) => props.onConfig(props.node!.id, "classifier_id", value)}
          onCreate={props.onCreateClassifier}
        />
      )}
      {kind === "kie" && (
        <ConfigSelect
          label="Schema"
          value={props.node.data.config?.schema_id ?? ""}
          options={props.schemas.map((item) => ({ value: item.id, label: `${item.display_name || item.name} · ${item.fields.length} fields` }))}
          onChange={(value) => props.onConfig(props.node!.id, "schema_id", value)}
          onCreate={props.onCreateSchema}
        />
      )}
      {kind === "required-checker" && (
        <ConfigSelect
          label="체크리스트"
          value={props.node.data.config?.checklist_id ?? ""}
          options={props.checklists.map((item) => ({ value: item.id, label: `${item.name} · ${item.items.length} items` }))}
          onChange={(value) => props.onConfig(props.node!.id, "checklist_id", value)}
          onCreate={props.onCreateChecklist}
        />
      )}
      {kind === "branch" && (
        <div className="branch-rule-panel">
          <strong>Branch handles</strong>
          {normalizeBranchKeys(props.node.data.branchKeys).map((key) => (
            <span key={key}>{branchKeyLabel(key)}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function ConfigSelect(props: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  onCreate: () => void;
}) {
  return (
    <label className="workflow-config-select">
      <span>{props.label}</span>
      <select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        <option value="">저장된 라이브러리에서 선택</option>
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <button type="button" className="secondary" onClick={props.onCreate}>
        <Plus size={15} /> 새로 만들기
      </button>
    </label>
  );
}

function WorkflowRunProgressDock(props: {
  run: WorkflowRun;
  onOpen: () => void;
  onRefresh: () => void;
}) {
  const finishedCount = workflowRunFinishedCount(props.run);
  const runningCount = props.run.items.filter((item) => item.status === "running").length;
  const queuedCount = props.run.items.filter((item) => item.status === "queued").length;
  const percent = Math.round(props.run.progress * 100);
  return (
    <div className="workflow-progress-dock" aria-label="워크플로우 실행 진행상황">
      <div className="workflow-progress-dock-head">
        <div>
          <p className="eyebrow">Run</p>
          <h3>{workflowRunHeadline(props.run)} · {percent}%</h3>
        </div>
        <div className="workflow-run-kpis">
          <span><strong>{finishedCount}</strong> 완료/검토/실패</span>
          <span><strong>{runningCount}</strong> 실행 중</span>
          <span><strong>{queuedCount}</strong> 대기</span>
        </div>
        <div className="workflow-progress-dock-actions">
          <button type="button" className="secondary" onClick={props.onOpen}>
            <Maximize2 size={15} /> 결과 상세보기
          </button>
          <button type="button" className="secondary" onClick={props.onRefresh}>갱신</button>
        </div>
      </div>
      <progress className="workflow-run-progress" value={props.run.progress} max={1} />
    </div>
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
  onClose: () => void;
}) {
  const finishedCount = workflowRunFinishedCount(props.run);
  return (
    <section className="workflow-results">
      <div className="workflow-results-header">
        <div>
          <p className="eyebrow">Run</p>
          <h2>{workflowRunHeadline(props.run)} · {Math.round(props.run.progress * 100)}%</h2>
        </div>
        <div className="workflow-run-kpis">
          <span><strong>{finishedCount}</strong> 완료/검토/실패</span>
          <span><strong>{props.run.items.filter((item) => item.status === "running").length}</strong> 실행 중</span>
          <span><strong>{props.run.items.filter((item) => item.status === "queued").length}</strong> 대기</span>
        </div>
        <div className="workflow-results-actions">
          <button type="button" className="secondary" onClick={props.onClose}>
            <X size={15} /> 닫기
          </button>
          <button type="button" className="secondary" onClick={props.onRefresh}>갱신</button>
        </div>
      </div>
      <progress className="workflow-run-progress" value={props.run.progress} max={1} />
      <div className="workflow-run-workbench">
        <WorkflowRunRail run={props.run} selectedItem={props.selectedItem} onSelectItem={props.onSelectItem} />
        <WorkflowDocumentPreview document={props.document} loading={props.documentLoading} activePage={props.activePage} onPage={props.onPage} item={props.selectedItem} />
        <WorkflowItemInspector item={props.selectedItem} />
      </div>
    </section>
  );
}

function workflowRunFinishedCount(run: WorkflowRun) {
  return run.completed_count + run.failed_count + run.needs_review_count;
}

function workflowRunHeadline(run: WorkflowRun) {
  if (!TERMINAL_RUN_STATUSES.includes(run.status) && run.progress < 1) return "작업 진행 중";
  return "작업 완료";
}

function WorkflowRunRail(props: { run: WorkflowRun; selectedItem: WorkflowRunItem | null; onSelectItem: (itemId: string) => void }) {
  return (
    <aside className="workflow-run-rail">
      <div className="workflow-run-rail-head">
        <span>{props.run.items.length}개 문서</span>
        <small>{workflowStatusLabel(props.run.status)}</small>
      </div>
      <div className="workflow-run-list">
        {props.run.items.map((item) => {
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
  const { connectedBranchKeys: _connectedBranchKeys, ...data } = node.data;
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

function buildCanvasNodes(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  return nodes.map((node) => {
    if (node.data.kind !== "branch") return node;
    const connectedBranchKeys = edges
      .filter((edge) => edge.source === node.id && edge.sourceHandle)
      .map((edge) => String(edge.sourceHandle));
    return {
      ...node,
      data: {
        ...node.data,
        connectedBranchKeys
      }
    };
  });
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
      selectedNodeId: typeof parsed.selectedNodeId === "string" ? parsed.selectedNodeId : parsed.nodes[0]?.id ?? null,
      settingsCollapsed: Boolean(parsed.settingsCollapsed)
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

function sharedTargetConfirmation(connection: Connection, nodes: WorkflowNode[], edges: WorkflowEdge[]) {
  if (!connection.source || !connection.target) return null;
  const source = nodes.find((node) => node.id === connection.source);
  const target = nodes.find((node) => node.id === connection.target);
  if (!source || !target || source.data.kind !== "branch") return null;
  const existingIncoming = edges.filter((edge) => edge.target === connection.target);
  if (!existingIncoming.length) return null;
  const incomingLabels = existingIncoming.map((edge) => edgeLabel(edge, nodes)).join(", ");
  return `${target.data.label} 노드에는 이미 ${incomingLabels} 연결이 있습니다. 이 branch route도 같은 후속 노드로 연결할까요?`;
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
    queued: "대기 중",
    running: "실행 중",
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

function formatWorkflowValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, options);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (typeof body.detail === "string") message = body.detail;
      if (body.detail?.errors) message = body.detail.errors.join(", ");
    } catch {
      // Keep HTTP status.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}
