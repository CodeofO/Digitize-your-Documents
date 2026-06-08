import pytest

from app.config import get_settings
from app.vlm import OpenAiCompatibleVlmClient, VlmRuntimeError, _json_object_from_text


def test_local_vlm_json_parser_accepts_markdown_wrapped_json() -> None:
    assert _json_object_from_text('```json\n{"ok": true}\n```') == {"ok": True}


def test_local_vlm_json_parser_accepts_json_embedded_in_text() -> None:
    assert _json_object_from_text('result:\n{"ok": true}\nfinished') == {"ok": True}


def test_local_vlm_json_parser_repairs_missing_trailing_braces_after_whitespace_loop() -> None:
    text = '{"본인 성명":{"value":"최예솔","page":1,"evidence":"본인 성명: 최예솔 (서명)"' + (" " * 4096)

    parsed = _json_object_from_text(text)

    assert parsed == {"본인 성명": {"value": "최예솔", "page": 1, "evidence": "본인 성명: 최예솔 (서명)"}}


def test_local_vlm_json_parser_rejects_unparseable_text() -> None:
    with pytest.raises(VlmRuntimeError) as exc_info:
        _json_object_from_text("no json here")

    assert exc_info.value.code == "VLM_RESPONSE_INVALID_JSON"


def test_openai_compatible_client_uses_raw_json_mode_for_base_url(monkeypatch) -> None:
    from app import vlm as vlm_module

    try:
        monkeypatch.setenv("VLM_PROVIDER", "openai_compatible")
        monkeypatch.setenv("VLM_BASE_URL", "http://127.0.0.1:1234/v1")
        get_settings.cache_clear()

        monkeypatch.setattr(vlm_module, "_invoke_openai_compatible_raw_json", lambda *args, **kwargs: {"ok": True})
        monkeypatch.setattr(
            vlm_module,
            "_invoke_openai_compatible",
            lambda *args, **kwargs: pytest.fail("structured json_schema path should not be used for local base_url"),
        )

        assert OpenAiCompatibleVlmClient().invoke("system", "prompt", [], {}) == {"ok": True}
    finally:
        get_settings.cache_clear()
