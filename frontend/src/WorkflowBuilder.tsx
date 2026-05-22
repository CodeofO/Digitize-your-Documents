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
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  Save,
  Sparkles,
  Unlink2,
  UploadCloud
} from "lucide-react";
import { ChangeEvent, useCallback, useEffect, useMemo, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";
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
  required_items?: Record<string, { status?: string; evidence?: string | null }>;
  node_results?: Record<string, unknown>;
  error_message?: string | null;
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
};

const WORKFLOW_DRAFT_KEY = "digitize_workflow_builder_draft_v1";
const TERMINAL_RUN_STATUSES = ["completed", "completed_with_errors", "needs_review", "failed", "canceled"];

const nodePalette: { kind: WorkflowNodeKind; label: string; description: string }[] = [
  { kind: "input", label: "문서 입력", description: "단일/배치 문서를 자동 판단합니다." },
  { kind: "classifier", label: "문서 분류", description: "저장된 classifier를 실행합니다." },
  { kind: "branch", label: "분기", description: "분류 class별 경로를 나눕니다." },
  { kind: "kie", label: "핵심 정보 추출", description: "저장된 schema로 값을 추출합니다." },
  { kind: "required-checker", label: "필수 항목 확인", description: "저장된 checklist를 확인합니다." },
  { kind: "merge", label: "결과 병합", description: "실행된 branch 결과를 합칩니다." },
  { kind: "export", label: "Export", description: "통합 CSV/JSON 결과를 만듭니다." }
];

const defaultNodes: WorkflowNode[] = [
  workflowNode("input", "문서 입력", 0, 150, {}, undefined, "input"),
  workflowNode("classifier", "문서 분류", 230, 150, {}, undefined, "classifier"),
  workflowNode("branch", "분기", 470, 150, {}, ["default", "unknown", "needs_review"], "branch"),
  workflowNode("kie", "핵심 정보 추출", 730, 70, {}, undefined, "kie_contract"),
  workflowNode("required-checker", "필수 항목 확인", 970, 70, {}, undefined, "required_contract"),
  workflowNode("merge", "결과 병합", 1210, 150, {}, undefined, "merge"),
  workflowNode("export", "Export", 1450, 150, {}, undefined, "export")
];

const defaultEdges: WorkflowEdge[] = [
  workflowEdge("input", "classifier"),
  workflowEdge("classifier", "branch"),
  workflowEdge("branch", "kie_contract", "default"),
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
  const [edges, setEdges] = useState<WorkflowEdge[]>(() => initialDraft?.edges ?? defaultEdges.map(normalizeWorkflowEdge));
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(initialDraft?.selectedNodeId ?? defaultNodes[1]?.id ?? null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [settingsCollapsed, setSettingsCollapsed] = useState(false);
  const [schemas, setSchemas] = useState<SchemaSummary[]>([]);
  const [classifiers, setClassifiers] = useState<ClassifierSummary[]>([]);
  const [checklists, setChecklists] = useState<ChecklistSummary[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [activeRunId, setActiveRunId] = useState("");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(initialDraft ? "복원됨" : null);

  const activeWorkflow = workflows.find((workflow) => workflow.id === activeWorkflowId) ?? null;
  const activeRun = runs.find((run) => run.id === activeRunId) ?? runs[0] ?? null;
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const canvasNodes = useMemo(() => buildCanvasNodes(nodes, edges), [nodes, edges]);
  const selectedRunItem =
    activeRun?.items.find((item) => item.id === selectedItemId) ?? activeRun?.items[0] ?? null;
  const validation = useMemo(() => validateWorkflow(nodes, edges), [nodes, edges]);
  const uploadMode = files.length > 1 ? "배치 실행" : files.length === 1 ? "단일 실행" : "파일 없음";

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
    setEdges((current) => applyEdgeChanges(changes, current).map(normalizeWorkflowEdge));
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
    setEdges((workflow.definition.edges?.length ? workflow.definition.edges : defaultEdges).map(normalizeWorkflowEdge));
    setSelectedNodeId(workflow.definition.nodes?.[0]?.id ?? defaultNodes[0].id);
    setMessage(`불러온 워크플로우: ${workflow.name}`);
  }

  function resetWorkflowDraft() {
    setActiveWorkflowId("");
    setWorkflowName("문서 자동화 워크플로우");
    setWorkflowDescription("");
    setNodes(defaultNodes.map(normalizeWorkflowNode));
    setEdges(defaultEdges.map(normalizeWorkflowEdge));
    setSelectedNodeId(defaultNodes[1]?.id ?? defaultNodes[0]?.id ?? null);
    setMessage("새 워크플로우를 시작합니다.");
  }

  async function saveWorkflow() {
    if (validation.errors.length) {
      setError(validation.errors[0]);
      return;
    }
    setBusy("워크플로우 저장 중");
    setError(null);
    try {
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
      setMessage("워크플로우를 저장했습니다.");
      setDraftSavedAt("저장됨");
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "워크플로우 저장에 실패했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function runWorkflow() {
    if (!activeWorkflowId) {
      setError("먼저 워크플로우를 저장하세요.");
      return;
    }
    if (!files.length) {
      setError("실행할 문서를 업로드하세요.");
      return;
    }
    setBusy("워크플로우 실행 중");
    setError(null);
    try {
      const form = new FormData();
      files.forEach((file) => form.append("files", file));
      const run = await api<WorkflowRun>(`/api/workflows/${activeWorkflowId}/runs`, {
        method: "POST",
        body: form
      });
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)].slice(0, 12));
      setActiveRunId(run.id);
      setSelectedItemId(run.items[0]?.id ?? null);
      setMessage(`${uploadMode}을 시작했습니다.`);
      void refreshRun(run.id);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "워크플로우 실행에 실패했습니다.");
    } finally {
      setBusy(null);
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
            <button type="button" onClick={() => void saveWorkflow()} disabled={Boolean(busy) || validation.errors.length > 0}>
              <Save size={16} /> 저장
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
            <button
              type="button"
              className="secondary icon-only workflow-panel-toggle"
              aria-label={settingsCollapsed ? "노드 설정 패널 펼치기" : "노드 설정 패널 접기"}
              title={settingsCollapsed ? "노드 설정 패널 펼치기" : "노드 설정 패널 접기"}
              onClick={() => setSettingsCollapsed((current) => !current)}
            >
              {settingsCollapsed ? <PanelRightOpen size={17} /> : <PanelRightClose size={17} />}
            </button>
          </div>

          <div className="workflow-canvas">
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
          </div>

          <div className="workflow-run-bar">
            <label className="workflow-upload">
              <UploadCloud size={17} />
              <span>{files.length ? `${files.length}개 파일 선택됨 · ${uploadMode}` : "문서 업로드"}</span>
              <input type="file" multiple accept={WORKFLOW_FILE_ACCEPT} onChange={onFileInput} />
            </label>
            <button type="button" onClick={() => void runWorkflow()} disabled={Boolean(busy) || !activeWorkflowId || !files.length}>
              {busy ? <Loader2 size={16} className="spin" /> : <Play size={16} />}
              실행
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

          {activeRun && (
            <WorkflowRunResults
              run={activeRun}
              selectedItem={selectedRunItem}
              onSelectItem={(itemId) => setSelectedItemId(itemId)}
              onRefresh={() => void refreshRun(activeRun.id)}
            />
          )}
        </section>

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
      </main>
    </ReactFlowProvider>
  );
}

function WorkflowCanvasNode({ data, selected }: NodeProps<WorkflowNode>) {
  const kind = data.kind;
  const branchKeys = data.branchKeys?.length ? data.branchKeys : ["default", "unknown", "needs_review"];
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
          {(props.node.data.branchKeys ?? ["default", "unknown", "needs_review"]).map((key) => (
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

function WorkflowRunResults(props: {
  run: WorkflowRun;
  selectedItem: WorkflowRunItem | null;
  onSelectItem: (itemId: string) => void;
  onRefresh: () => void;
}) {
  return (
    <section className="workflow-results">
      <div className="workflow-results-header">
        <div>
          <p className="eyebrow">Run</p>
          <h2>{props.run.status} · {Math.round(props.run.progress * 100)}%</h2>
        </div>
        <button type="button" className="secondary" onClick={props.onRefresh}>갱신</button>
      </div>
      <div className="workflow-result-grid">
        <div className="workflow-result-table-wrap">
          <table className="data-table workflow-result-table">
            <thead>
              <tr>
                <th>파일명</th>
                <th>분류</th>
                <th>Branch</th>
                <th>KIE</th>
                <th>필수항목</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {props.run.items.map((item) => {
                const result = item.result ?? {};
                const kieCount = Object.keys(result.kie_values ?? {}).length;
                const requiredCount = Object.keys(result.required_items ?? {}).length;
                return (
                  <tr key={item.id} className={props.selectedItem?.id === item.id ? "selected-row" : ""} onClick={() => props.onSelectItem(item.id)}>
                    <td>{item.filename}</td>
                    <td>{result.classification?.class_name || result.classification?.status || "-"}</td>
                    <td>{result.branch_path || "-"}</td>
                    <td>{kieCount ? `${kieCount} fields` : "-"}</td>
                    <td>{result.required_overall_status || (requiredCount ? `${requiredCount} items` : "-")}</td>
                    <td>{item.status}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <WorkflowItemDetail item={props.selectedItem} />
      </div>
    </section>
  );
}

function WorkflowItemDetail({ item }: { item: WorkflowRunItem | null }) {
  if (!item) {
    return <aside className="workflow-item-detail">결과 문서를 선택하세요.</aside>;
  }
  const result = item.result ?? {};
  return (
    <aside className="workflow-item-detail">
      <p className="eyebrow">Document</p>
      <h3>{item.filename}</h3>
      <div className="detail-stack">
        <DetailRow label="상태" value={item.status} />
        <DetailRow label="분류" value={result.classification?.class_name || result.classification?.status || "-"} />
        <DetailRow label="Branch" value={result.branch_path || "-"} />
        <DetailRow label="필수항목" value={result.required_overall_status || "-"} />
        {item.error_message && <DetailRow label="오류" value={item.error_message} />}
      </div>
      <h4>KIE 결과</h4>
      <div className="mini-result-list">
        {Object.entries(result.kie_values ?? {}).map(([key, value]) => (
          <span key={key}>
            <strong>{key}</strong>
            {typeof value === "object" && value !== null && "value" in value ? String(value.value ?? "") : String(value ?? "")}
          </span>
        ))}
      </div>
      <h4>필수 항목</h4>
      <div className="mini-result-list">
        {Object.entries(result.required_items ?? {}).map(([key, value]) => (
          <span key={key}>
            <strong>{key}</strong>
            {value.status || "-"}
          </span>
        ))}
      </div>
    </aside>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <strong>{label}</strong>
      {value}
    </span>
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
  const sourceHandle = typeof edge.sourceHandle === "string" ? edge.sourceHandle : undefined;
  return {
    ...edge,
    id: edge.id || `${edge.source}-${sourceHandle || "out"}-${edge.target}`,
    sourceHandle,
    animated: false,
    label: sourceHandle ? branchKeyLabel(sourceHandle) : edge.label
  };
}

function normalizeWorkflowNode(node: WorkflowNode): WorkflowNode {
  const { connectedBranchKeys: _connectedBranchKeys, ...data } = node.data;
  return {
    ...node,
    type: "workflow",
    data: {
      ...data,
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
    "unknown",
    "needs_review",
    "default"
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
      edges: parsed.edges.map(normalizeWorkflowEdge),
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
  if (source.data.kind === "branch" && !connection.sourceHandle) return "Branch는 default/unknown/class handle에서 연결하세요.";
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
      const sourceHandles = edges.filter((edge) => edge.source === node.id).map((edge) => edge.sourceHandle || "default");
      const branchKeys = node.data.branchKeys?.length ? node.data.branchKeys : ["default", "unknown", "needs_review"];
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
  if (key === "needs_review") return "needs review";
  return key;
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { cache: "no-store", ...options });
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
