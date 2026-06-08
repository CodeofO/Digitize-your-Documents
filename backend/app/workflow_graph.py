from __future__ import annotations

from dataclasses import dataclass
from typing import Any


WORKFLOW_NODE_KINDS = {"input", "classifier", "branch", "kie", "required-checker", "merge", "export"}


@dataclass(frozen=True)
class WorkflowGraph:
    definition: dict[str, Any]
    nodes: dict[str, dict[str, Any]]
    edges: list[dict[str, Any]]
    outgoing: dict[str, list[dict[str, Any]]]
    incoming: dict[str, list[dict[str, Any]]]
    warnings: list[str]

    def with_warnings(self, warnings: list[str]) -> "WorkflowGraph":
        return WorkflowGraph(
            definition=self.definition,
            nodes=self.nodes,
            edges=self.edges,
            outgoing=self.outgoing,
            incoming=self.incoming,
            warnings=warnings,
        )


def build_workflow_graph(definition: dict[str, Any]) -> WorkflowGraph:
    nodes_raw = definition.get("nodes") if isinstance(definition.get("nodes"), list) else []
    edges_raw = definition.get("edges") if isinstance(definition.get("edges"), list) else []
    nodes = {str(node.get("id")): node for node in nodes_raw if isinstance(node, dict) and node.get("id")}
    edges = [
        {"id": str(edge.get("id") or f"{edge.get('source')}->{edge.get('target')}"), **edge}
        for edge in edges_raw
        if isinstance(edge, dict) and edge.get("source") and edge.get("target")
    ]
    outgoing: dict[str, list[dict[str, Any]]] = {node_id: [] for node_id in nodes}
    incoming: dict[str, list[dict[str, Any]]] = {node_id: [] for node_id in nodes}
    for edge in edges:
        source = str(edge["source"])
        target = str(edge["target"])
        outgoing.setdefault(source, []).append(edge)
        incoming.setdefault(target, []).append(edge)
    return WorkflowGraph(definition=definition, nodes=nodes, edges=edges, outgoing=outgoing, incoming=incoming, warnings=[])


def validate_workflow_graph_shape(graph: WorkflowGraph) -> list[str]:
    errors: list[str] = []
    if not graph.nodes:
        return ["Workflow must include at least one node"]
    invalid = [node_id for node_id, node in graph.nodes.items() if node_kind(node) not in WORKFLOW_NODE_KINDS]
    if invalid:
        errors.append(f"Unsupported workflow node kind: {', '.join(invalid)}")
    input_nodes = [node_id for node_id, node in graph.nodes.items() if node_kind(node) == "input"]
    export_nodes = [node_id for node_id, node in graph.nodes.items() if node_kind(node) == "export"]
    if len(input_nodes) != 1:
        errors.append("Workflow must have exactly one Input node")
    if not export_nodes:
        errors.append("Workflow must include an Export node")
    for edge in graph.edges:
        if edge["source"] not in graph.nodes or edge["target"] not in graph.nodes:
            errors.append(f"Edge {edge['id']} references a missing node")
    if has_cycle(graph):
        errors.append("Workflow graph cannot contain a cycle")
    for node_id, node in graph.nodes.items():
        kind = node_kind(node)
        if kind not in {"branch", "export"} and len(graph.outgoing.get(node_id, [])) > 1:
            errors.append(f"Node {node_id} can only have one outgoing edge in v1")
        if kind == "export" and graph.outgoing.get(node_id):
            errors.append(f"Export node {node_id} cannot have outgoing edges")
    return errors


def validate_workflow_branch_shape(graph: WorkflowGraph) -> list[str]:
    errors: list[str] = []
    for node_id, node in graph.nodes.items():
        if node_kind(node) != "branch":
            continue
        incoming = graph.incoming.get(node_id, [])
        if len(incoming) != 1:
            errors.append(f"Branch node {node_id} must have one incoming classifier edge")
            continue
        source_node = graph.nodes.get(incoming[0]["source"])
        if not source_node or node_kind(source_node) != "classifier":
            errors.append(f"Branch node {node_id} must be connected directly after a classifier")
    return errors


def reachable_node_ids(graph: WorkflowGraph, start_id: str) -> set[str]:
    visited: set[str] = set()
    stack = [start_id]
    while stack:
        node_id = stack.pop()
        if node_id in visited:
            continue
        visited.add(node_id)
        stack.extend(str(edge["target"]) for edge in graph.outgoing.get(node_id, []))
    return visited


def has_cycle(graph: WorkflowGraph) -> bool:
    visited: set[str] = set()
    active: set[str] = set()

    def visit(node_id: str) -> bool:
        if node_id in active:
            return True
        if node_id in visited:
            return False
        active.add(node_id)
        for edge in graph.outgoing.get(node_id, []):
            if visit(str(edge["target"])):
                return True
        active.remove(node_id)
        visited.add(node_id)
        return False

    return any(visit(node_id) for node_id in graph.nodes)


def node_kind(node: dict[str, Any]) -> str:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    kind = node.get("kind") or data.get("kind") or node.get("type") or ""
    aliases = {
        "document-classifier": "classifier",
        "classification": "classifier",
        "key-info": "kie",
        "required": "required-checker",
        "required_field_checker": "required-checker",
    }
    return aliases.get(str(kind), str(kind))


def node_label(node: dict[str, Any]) -> str:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    label = data.get("label") or node.get("label") or node_kind(node)
    return str(label)


def node_config_value(node: dict[str, Any], key: str) -> str | None:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    config = data.get("config") if isinstance(data.get("config"), dict) else {}
    value = config.get(key) or data.get(key) or node.get(key)
    return str(value).strip() if value else None


def single_node_id(graph: WorkflowGraph, kind: str) -> str:
    matches = [node_id for node_id, node in graph.nodes.items() if node_kind(node) == kind]
    if len(matches) != 1:
        raise RuntimeError(f"Workflow must have exactly one {kind} node")
    return matches[0]


def single_next_node_id(graph: WorkflowGraph, node_id: str) -> str | None:
    outgoing = graph.outgoing.get(node_id, [])
    if not outgoing:
        return None
    if len(outgoing) > 1:
        raise RuntimeError(f"Node {node_id} has multiple outgoing edges")
    return str(outgoing[0]["target"])


def select_branch_edge(graph: WorkflowGraph, branch_node_id: str, node_results: dict[str, Any]) -> dict[str, Any] | None:
    candidates = branch_candidate_keys(node_results)
    by_key = {branch_edge_key(edge): edge for edge in graph.outgoing.get(branch_node_id, [])}
    for key in candidates:
        if key in by_key:
            return by_key[key]
    return None


def branch_candidate_key(node_results: dict[str, Any]) -> str:
    return branch_candidate_keys(node_results)[0]


def branch_candidate_keys(node_results: dict[str, Any]) -> list[str]:
    classification = latest_classification(node_results)
    status = classification.get("status")
    class_name = classification.get("class_name")
    candidates: list[str] = []
    if status == "classified" and class_name:
        candidates.append(f"class:{class_name}")
    else:
        candidates.append("unknown")
    return candidates


def branch_edge_key(edge: dict[str, Any]) -> str:
    data = edge.get("data") if isinstance(edge.get("data"), dict) else {}
    raw = data.get("branchKey") or data.get("branch_key") or edge.get("sourceHandle") or edge.get("branch_key") or "default"
    key = str(raw).strip()
    if key.startswith("class-"):
        return f"class:{key.removeprefix('class-')}"
    if key.startswith("class:"):
        return key
    if key in {"unknown", "needs_review", "default"}:
        return key
    return f"class:{key}" if key else "default"


def latest_classification(node_results: dict[str, Any]) -> dict[str, Any]:
    for result in reversed(list(node_results.values())):
        classification = result.get("classification") if isinstance(result, dict) else None
        if isinstance(classification, dict):
            return classification
    return {}


def workflow_summary(node_results: dict[str, Any], branch_path: str | None) -> dict[str, Any]:
    classification = latest_classification(node_results)
    kie_values: dict[str, Any] = {}
    required_items: dict[str, Any] = {}
    required_overall: str | None = None
    for result in node_results.values():
        if not isinstance(result, dict):
            continue
        if result.get("kind") == "kie" and isinstance(result.get("values"), dict):
            for key, value in result["values"].items():
                kie_values[key] = value
        if result.get("kind") == "required-checker" and isinstance(result.get("required_check"), dict):
            required_overall = result["required_check"].get("overall_status")
            for item in result["required_check"].get("items", []):
                if isinstance(item, dict) and item.get("item_name"):
                    required_items[item["item_name"]] = item
    return {
        "classification": classification,
        "branch_path": branch_path,
        "kie_values": kie_values,
        "required_overall_status": required_overall,
        "required_items": required_items,
    }
