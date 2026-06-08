from app.workflow_graph import (
    branch_candidate_key,
    build_workflow_graph,
    has_cycle,
    select_branch_edge,
    validate_workflow_branch_shape,
    validate_workflow_graph_shape,
    workflow_summary,
)


def _workflow_definition() -> dict:
    return {
        "nodes": [
            {"id": "input", "type": "input"},
            {"id": "classifier", "type": "classifier"},
            {"id": "branch", "type": "branch"},
            {"id": "kie-a", "type": "kie"},
            {"id": "export", "type": "export"},
        ],
        "edges": [
            {"id": "e1", "source": "input", "target": "classifier"},
            {"id": "e2", "source": "classifier", "target": "branch"},
            {"id": "e3", "source": "branch", "target": "kie-a", "sourceHandle": "class-신청서"},
            {"id": "e4", "source": "branch", "target": "export", "sourceHandle": "unknown"},
            {"id": "e5", "source": "kie-a", "target": "export"},
        ],
    }


def test_workflow_graph_shape_accepts_valid_branch_flow() -> None:
    graph = build_workflow_graph(_workflow_definition())

    assert validate_workflow_graph_shape(graph) == []
    assert validate_workflow_branch_shape(graph) == []


def test_select_branch_edge_prefers_classified_class_key() -> None:
    graph = build_workflow_graph(_workflow_definition())
    node_results = {"classifier": {"classification": {"status": "classified", "class_name": "신청서"}}}

    selected = select_branch_edge(graph, "branch", node_results)

    assert selected is not None
    assert selected["target"] == "kie-a"
    assert branch_candidate_key(node_results) == "class:신청서"


def test_select_branch_edge_falls_back_to_unknown() -> None:
    graph = build_workflow_graph(_workflow_definition())
    node_results = {"classifier": {"classification": {"status": "unknown", "class_name": None}}}

    selected = select_branch_edge(graph, "branch", node_results)

    assert selected is not None
    assert selected["target"] == "export"


def test_has_cycle_detects_cycle() -> None:
    definition = _workflow_definition()
    definition["edges"].append({"id": "cycle", "source": "export", "target": "input"})
    graph = build_workflow_graph(definition)

    assert has_cycle(graph)
    assert "Workflow graph cannot contain a cycle" in validate_workflow_graph_shape(graph)


def test_workflow_summary_collects_module_outputs() -> None:
    node_results = {
        "classifier": {"kind": "classifier", "classification": {"status": "classified", "class_name": "신청서"}},
        "kie": {"kind": "kie", "values": {"고객명": {"value": "홍길동"}}},
        "required": {
            "kind": "required-checker",
            "required_check": {
                "overall_status": "complete",
                "items": [{"item_name": "서명", "status": "present"}],
            },
        },
    }

    summary = workflow_summary(node_results, "class:신청서")

    assert summary["classification"]["class_name"] == "신청서"
    assert summary["kie_values"]["고객명"]["value"] == "홍길동"
    assert summary["required_items"]["서명"]["status"] == "present"
    assert summary["required_overall_status"] == "complete"
