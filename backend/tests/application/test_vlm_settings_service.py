from app.schemas import VlmSettingsUpdate
from app.services.vlm_settings import inference_params_from_settings_payload


def test_inference_params_payload_uses_structured_values_as_source_of_truth() -> None:
    payload = VlmSettingsUpdate(
        model_name="local-model",
        provider="openai_compatible",
        inference_params={"reasoning_effort": "off", "thinking": "off", "temperature": "0.2"},
        reasoning_effort="high",
    )

    values = inference_params_from_settings_payload(payload, {"reasoning_effort": "medium", "temperature": "0"})

    assert values["reasoning_effort"] == "off"
    assert values["thinking"] == "off"
    assert values["temperature"] == "0.2"


def test_inference_params_payload_keeps_legacy_fields_when_structured_params_absent() -> None:
    payload = VlmSettingsUpdate(
        model_name="local-model",
        provider="openai_compatible",
        reasoning_effort="off",
        temperature="0",
        max_completion_tokens="2048",
    )

    values = inference_params_from_settings_payload(payload, {"verbosity": "low"})

    assert values["reasoning_effort"] == "off"
    assert values["thinking"] == "off"
    assert values["temperature"] == "0"
    assert values["max_completion_tokens"] == "2048"
    assert values["verbosity"] == "low"
