from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Mapping


REASONING_OFF_VALUES = {"", "default", "none", "off", "false", "0", "disabled", "disable"}


DEFAULT_VLM_INFERENCE_PARAMS = {
    "reasoning_effort": "off",
    "thinking": "off",
    "temperature": "0",
    "verbosity": "",
    "max_completion_tokens": "",
    "top_p": "",
    "service_tier": "",
}


class VlmInferenceParamError(ValueError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


@dataclass(frozen=True)
class VlmInferenceParams:
    reasoning_effort: str = "off"
    thinking: str = "off"
    temperature: str = "0"
    verbosity: str = ""
    max_completion_tokens: str = ""
    top_p: str = ""
    service_tier: str = ""

    @classmethod
    def from_mapping(cls, values: Mapping[str, Any] | None) -> "VlmInferenceParams":
        params = dict(DEFAULT_VLM_INFERENCE_PARAMS)
        if values:
            params.update({key: _stringify(value) for key, value in values.items() if key in params})
        params["reasoning_effort"] = normalize_reasoning_mode(params.get("reasoning_effort"))
        params["thinking"] = normalize_reasoning_mode(params.get("thinking") or params["reasoning_effort"])
        return cls(**params)

    @classmethod
    def from_raw_env(
        cls,
        raw_json: str | None,
        *,
        legacy_values: Mapping[str, Any] | None = None,
        legacy_temperature: float | None = None,
    ) -> "VlmInferenceParams":
        parsed = parse_vlm_inference_params(raw_json)
        values = dict(DEFAULT_VLM_INFERENCE_PARAMS)
        values.update(parsed)
        if not parsed:
            if legacy_values:
                values.update({key: _stringify(value) for key, value in legacy_values.items() if key in values and value is not None})
            if legacy_temperature is not None:
                values["temperature"] = str(legacy_temperature)
        return cls.from_mapping(values)

    def as_dict(self) -> dict[str, str]:
        return {
            "reasoning_effort": self.reasoning_effort,
            "thinking": self.thinking,
            "temperature": self.temperature,
            "verbosity": self.verbosity,
            "max_completion_tokens": self.max_completion_tokens,
            "top_p": self.top_p,
            "service_tier": self.service_tier,
        }

    def to_env_json(self) -> str:
        return json.dumps(self.as_dict(), ensure_ascii=False, separators=(",", ":"))

    def temperature_value(self, fallback: float) -> float:
        value = _clean_optional_text(self.temperature)
        if value is None:
            return fallback
        return _optional_float_value(value)

    def openai_compatible_kwargs(self) -> dict[str, Any]:
        kwargs: dict[str, Any] = {}
        reasoning_effort = _clean_optional_text(self.reasoning_effort)
        if reasoning_effort and not is_reasoning_off(reasoning_effort):
            kwargs["reasoning_effort"] = reasoning_effort

        verbosity = _clean_optional_text(self.verbosity)
        if verbosity:
            kwargs["verbosity"] = verbosity

        max_completion_tokens = _optional_int(self.max_completion_tokens)
        if max_completion_tokens is not None:
            kwargs["max_completion_tokens"] = max_completion_tokens

        top_p = _optional_float(self.top_p)
        if top_p is not None:
            kwargs["top_p"] = top_p

        service_tier = _clean_optional_text(self.service_tier)
        if service_tier:
            kwargs["service_tier"] = service_tier

        return kwargs

    def google_generation_overrides(self) -> dict[str, Any]:
        config: dict[str, Any] = {}
        max_output_tokens = _optional_int(self.max_completion_tokens)
        if max_output_tokens is not None:
            config["max_output_tokens"] = max_output_tokens

        top_p = _optional_float(self.top_p)
        if top_p is not None:
            config["top_p"] = top_p

        thinking_config = google_thinking_config(self.thinking or self.reasoning_effort)
        if thinking_config:
            config["thinking_config"] = thinking_config

        return config


def default_vlm_inference_params_json() -> str:
    return VlmInferenceParams.from_mapping(None).to_env_json()


def normalize_vlm_inference_params(values: Mapping[str, Any] | None) -> dict[str, str]:
    return VlmInferenceParams.from_mapping(values).as_dict()


def parse_vlm_inference_params(raw: str | None) -> dict[str, str]:
    if raw is None or not raw.strip():
        return {}
    try:
        loaded = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(loaded, dict):
        return {}
    return {key: _stringify(value) for key, value in loaded.items() if key in DEFAULT_VLM_INFERENCE_PARAMS}


def normalize_reasoning_mode(value: Any) -> str:
    normalized = _stringify(value).lower()
    if normalized in REASONING_OFF_VALUES:
        return "off"
    return normalized


def is_reasoning_off(value: str) -> bool:
    return value.strip().lower() in REASONING_OFF_VALUES


def google_thinking_config(reasoning_effort: str | None) -> dict[str, Any] | None:
    effort = _clean_optional_text(reasoning_effort)
    if not effort:
        return None
    normalized = effort.lower()
    if is_reasoning_off(normalized) or normalized == "instant":
        return {"thinking_budget": 0}
    if normalized in {"minimal", "low", "medium", "high"}:
        return {"thinking_level": normalized}
    return {"thinking_level": normalized}


def _stringify(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _clean_optional_text(value: Any) -> str | None:
    cleaned = _stringify(value)
    return cleaned or None


def _optional_int(value: str | None) -> int | None:
    cleaned = _clean_optional_text(value)
    if cleaned is None:
        return None
    try:
        return int(cleaned)
    except ValueError as exc:
        raise VlmInferenceParamError("VLM_SETTING_INVALID_INTEGER", f"Invalid integer VLM setting: {cleaned}") from exc


def _optional_float(value: str | None) -> float | None:
    cleaned = _clean_optional_text(value)
    if cleaned is None:
        return None
    return _optional_float_value(cleaned)


def _optional_float_value(value: str) -> float:
    try:
        return float(value)
    except ValueError as exc:
        raise VlmInferenceParamError("VLM_SETTING_INVALID_NUMERIC", f"Invalid numeric VLM setting: {value}") from exc
