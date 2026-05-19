import base64
import io
import os

import fitz

from app.config import get_settings
from tests.conftest import get_client


ONE_BY_ONE_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)


def test_health() -> None:
    with get_client() as client:
        response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_system_status_mock_mode() -> None:
    try:
        os.environ["VLM_PROVIDER"] = "mock"
        get_settings.cache_clear()
        with get_client() as client:
            response = client.get("/api/system/status")
        assert response.status_code == 200
        payload = response.json()
        assert payload["vlm_provider"] == "mock"
        assert payload["is_mock"] is True
        assert "vlm_api_key" not in payload
    finally:
        os.environ["VLM_PROVIDER"] = "openai"
        get_settings.cache_clear()


def test_schema_validation_and_creation() -> None:
    with get_client() as client:
        invalid = client.post(
            "/api/schemas",
            json={
                "name": "bad_schema",
                "fields": [
                    {"key_name": "total", "description": "Total amount", "output_format": "float"},
                    {"key_name": "total", "description": "Duplicate total", "output_format": "float"},
                ],
            },
        )
        assert invalid.status_code == 422

        unsupported_format = client.post(
            "/api/schemas",
            json={
                "name": "bad_format",
                "fields": [
                    {"key_name": "count", "description": "Unsupported integer field", "output_format": "int"},
                ],
            },
        )
        assert unsupported_format.status_code == 422

        valid = create_schema(client)
        assert valid["name"] == "invoice_basic"
        assert valid["fields"][0]["key_name"] == "invoice_number"

        korean_with_space = client.post(
            "/api/schemas",
            json={
                "name": "korean_schema",
                "fields": [
                    {"key_name": "법정 대리인 성", "description": "우측 하단의 법정 대리인 성명", "output_format": "string"},
                ],
            },
        )
        assert korean_with_space.status_code == 200
        assert korean_with_space.json()["fields"][0]["key_name"] == "법정 대리인 성"

        screenshot_payload = client.post(
            "/api/schemas",
            json={
                "name": "document_schema",
                "fields": [
                    {"key_name": "개정일", "description": "좌측 하단의 개정일자", "output_format": "date"},
                    {"key_name": "본인 성명", "description": "우측 하단의 본인 성명", "output_format": "string"},
                ],
            },
        )
        assert screenshot_payload.status_code == 200, screenshot_payload.text
        assert screenshot_payload.json()["fields"][1]["key_name"] == "본인 성명"


def test_image_upload() -> None:
    with get_client() as client:
        document = upload_png(client)
        assert document["page_count"] == 1
        assert document["created_at"]
        image = client.get(document["pages"][0]["image_url"])
        assert image.status_code == 200
        assert image.headers["content-type"] == "image/png"

        documents = client.get("/api/documents").json()
        assert any(item["document_id"] == document["document_id"] for item in documents)


def test_pdf_upload() -> None:
    with get_client() as client:
        pdf_bytes = make_pdf_bytes()
        response = client.post(
            "/api/documents",
            files={"file": ("invoice.pdf", pdf_bytes, "application/pdf")},
        )
        assert response.status_code == 200
        document = response.json()
        assert document["page_count"] == 1
        assert document["pages"][0]["width"] > 0
        assert document["pages"][0]["height"] > 0


def test_extraction_fails_without_vlm_credentials() -> None:
    with get_client() as client:
        document = upload_png(client)
        schema = create_schema(client)
        job_response = client.post(
            "/api/extraction-jobs",
            json={"document_id": document["document_id"], "schema_id": schema["id"]},
        )
        assert job_response.status_code == 200
        job_id = job_response.json()["job_id"]

        job = client.get(f"/api/extraction-jobs/{job_id}").json()
        assert job["status"] == "failed"
        assert job["result_id"] is None
        assert "VLM API key and model name are required" in job["error_message"]


def test_schema_update_creates_new_version() -> None:
    with get_client() as client:
        schema = create_schema(client)
        updated = client.patch(
            f"/api/schemas/{schema['id']}",
            json={
                "display_name": "Updated Invoice Basic",
                "fields": [
                    {
                        "key_name": "invoice_number",
                        "description": "Invoice number near the top.",
                        "output_format": "string",
                    },
                    {
                        "key_name": "invoice_date",
                        "description": "Invoice issue date.",
                        "output_format": "date",
                    },
                ],
            },
        )
        assert updated.status_code == 200, updated.text
        payload = updated.json()
        assert payload["current_version"] == schema["current_version"] + 1
        assert payload["display_name"] == "Updated Invoice Basic"
        assert payload["fields"][1]["key_name"] == "invoice_date"

        templated = client.patch(
            f"/api/schemas/{schema['id']}",
            json={"is_template": True, "template_category": "finance", "pinned": True},
        )
        assert templated.status_code == 200, templated.text
        templated_payload = templated.json()
        assert templated_payload["is_template"] is True
        assert templated_payload["template_category"] == "finance"
        assert templated_payload["pinned"] is True

        templates = client.get("/api/schemas?templates=true").json()
        assert any(item["id"] == schema["id"] for item in templates)


def test_schema_recommendation_mock_mode() -> None:
    try:
        os.environ["VLM_PROVIDER"] = "mock"
        get_settings.cache_clear()
        with get_client() as client:
            document = upload_png(client)
            response = client.post("/api/schemas/recommendations", json={"document_id": document["document_id"]})
            assert response.status_code == 200, response.text
            payload = response.json()
            assert payload["name"] == "ai_recommended_schema"
            assert payload["document_type"] == "demo_document"
            assert payload["language"] == "ko"
            assert payload["reasoning"]
            assert len(payload["fields"]) >= 3
            assert "문서번호" in {field["key_name"] for field in payload["fields"]}
            assert {field["output_format"] for field in payload["fields"]} <= {"string", "float", "date", "bool"}

            loaded_document = client.get(f"/api/documents/{document['document_id']}").json()
            assert loaded_document["document_type"] == "demo_document"
            assert loaded_document["language"] == "ko"

            audit_events = client.get(
                f"/api/audit-events?entity_type=document&entity_id={document['document_id']}"
            ).json()
            assert any(event["action"] == "schema_recommended" for event in audit_events)
    finally:
        os.environ["VLM_PROVIDER"] = "openai"
        get_settings.cache_clear()


def test_extraction_mock_mode_returns_evidence_and_normalized_values() -> None:
    try:
        os.environ["VLM_PROVIDER"] = "mock"
        get_settings.cache_clear()
        with get_client() as client:
            document = upload_png(client)
            schema = create_schema(client)
            job_response = client.post(
                "/api/extraction-jobs",
                json={"document_id": document["document_id"], "schema_id": schema["id"]},
            )
            assert job_response.status_code == 200, job_response.text
            job_id = job_response.json()["job_id"]

            job = client.get(f"/api/extraction-jobs/{job_id}").json()
            assert job["status"] == "completed"
            values = job["result"]["validated_output"]["values"]
            assert values["invoice_number"]["page"] == 1
            assert values["invoice_number"]["evidence"]
            assert values["total_amount"]["normalized_value"] == 1234.5

            jobs = client.get(f"/api/extraction-jobs?document_id={document['document_id']}").json()
            assert any(item["job_id"] == job_id for item in jobs)

            csv_export = client.get(f"/api/extraction-results/{job['result_id']}/export?format=csv")
            assert csv_export.status_code == 200
            assert "evidence" in csv_export.text.splitlines()[0]

            patch = client.patch(
                f"/api/extraction-results/{job['result_id']}",
                json={"reviewed_fields": ["invoice_number"]},
            )
            assert patch.status_code == 200, patch.text
            assert patch.json()["reviewed_fields"] == ["invoice_number"]
    finally:
        os.environ["VLM_PROVIDER"] = "openai"
        get_settings.cache_clear()


def test_export_preset_archive_batch_and_audit() -> None:
    try:
        os.environ["VLM_PROVIDER"] = "mock"
        get_settings.cache_clear()
        with get_client() as client:
            schema = create_schema(client)
            preset_response = client.post(
                "/api/export-presets",
                json={
                    "schema_id": schema["id"],
                    "name": "Finance CSV",
                    "fields": [
                        {"key_name": "invoice_number", "column_name": "Invoice No.", "include": True},
                        {"key_name": "total_amount", "column_name": "Total", "include": True},
                    ],
                },
            )
            assert preset_response.status_code == 200, preset_response.text
            preset = preset_response.json()
            assert preset["fields"][0]["column_name"] == "Invoice No."

            batch_response = client.post(
                "/api/batches",
                data={"schema_id": schema["id"]},
                files=[
                    ("files", ("invoice_a.png", ONE_BY_ONE_PNG, "image/png")),
                    ("files", ("invoice_b.png", ONE_BY_ONE_PNG, "image/png")),
                ],
            )
            assert batch_response.status_code == 200, batch_response.text
            batch_id = batch_response.json()["id"]
            batch = client.get(f"/api/batches/{batch_id}").json()
            assert batch["total_count"] == 2
            assert len(batch["items"]) == 2
            assert batch["completed_count"] + batch["failed_count"] == 2

            first_result_id = next(item["result_id"] for item in batch["items"] if item["result_id"])
            csv_export = client.get(
                f"/api/extraction-results/{first_result_id}/export?format=csv&preset_id={preset['id']}"
            )
            assert csv_export.status_code == 200
            assert "Invoice No." in csv_export.text

            archive = client.get("/api/archive/search?q=invoice_a").json()
            assert any(item["filename"] == "invoice_a.png" for item in archive)

            batch_events = client.get(f"/api/audit-events?entity_type=batch&entity_id={batch_id}").json()
            assert any(event["action"] == "created" for event in batch_events)
    finally:
        os.environ["VLM_PROVIDER"] = "openai"
        get_settings.cache_clear()


def upload_png(client):
    response = client.post(
        "/api/documents",
        files={"file": ("invoice.png", ONE_BY_ONE_PNG, "image/png")},
    )
    assert response.status_code == 200, response.text
    return response.json()


def create_schema(client):
    response = client.post(
        "/api/schemas",
        json={
            "name": "invoice_basic",
            "display_name": "Invoice Basic",
            "fields": [
                {
                    "key_name": "invoice_number",
                    "description": "Invoice number near the top of the document. Return null if missing.",
                    "output_format": "string",
                },
                {
                    "key_name": "total_amount",
                    "description": "Final total amount including tax.",
                    "output_format": "float",
                },
            ],
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def make_pdf_bytes() -> bytes:
    document = fitz.open()
    page = document.new_page(width=240, height=120)
    page.insert_text((24, 60), "Invoice No. INV-2026-001")
    buffer = io.BytesIO()
    document.save(buffer)
    document.close()
    return buffer.getvalue()
