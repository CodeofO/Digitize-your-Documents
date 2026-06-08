from __future__ import annotations

from dataclasses import dataclass
from typing import Any


OUTPUT_FORMATS = {"string", "float", "bool", "date"}


@dataclass(frozen=True)
class FieldRegionValue:
    page: int
    x: float
    y: float
    width: float
    height: float

    def __post_init__(self) -> None:
        if self.page < 1:
            raise ValueError("region page must be greater than or equal to 1")
        if not 0 <= self.x <= 1:
            raise ValueError("region x must be between 0 and 1")
        if not 0 <= self.y <= 1:
            raise ValueError("region y must be between 0 and 1")
        if not 0 < self.width <= 1:
            raise ValueError("region width must be greater than 0 and less than or equal to 1")
        if not 0 < self.height <= 1:
            raise ValueError("region height must be greater than 0 and less than or equal to 1")
        if self.x + self.width > 1:
            raise ValueError("region x + width must be less than or equal to 1")
        if self.y + self.height > 1:
            raise ValueError("region y + height must be less than or equal to 1")

    @classmethod
    def from_dto(cls, dto: Any) -> "FieldRegionValue":
        return cls(
            page=int(dto.page),
            x=float(dto.x),
            y=float(dto.y),
            width=float(dto.width),
            height=float(dto.height),
        )


@dataclass(frozen=True)
class SchemaRegionValue(FieldRegionValue):
    id: str
    name: str

    def __post_init__(self) -> None:
        super().__post_init__()
        if not self.id.strip():
            raise ValueError("schema region id is required")
        if not self.name.strip():
            raise ValueError("schema region name is required")

    @classmethod
    def from_dto(cls, dto: Any) -> "SchemaRegionValue":
        return cls(
            id=str(dto.id).strip(),
            name=str(dto.name).strip(),
            page=int(dto.page),
            x=float(dto.x),
            y=float(dto.y),
            width=float(dto.width),
            height=float(dto.height),
        )


@dataclass(frozen=True)
class FieldDefinitionValue:
    key_name: str
    description: str
    output_format: str
    region_id: str | None = None
    judgement_enabled: bool = False

    def __post_init__(self) -> None:
        if not self.key_name.strip():
            raise ValueError("field key_name is required")
        if not self.description.strip():
            raise ValueError("field description is required")
        if self.output_format not in OUTPUT_FORMATS:
            raise ValueError(f"unsupported output_format: {self.output_format}")

    @classmethod
    def from_dto(cls, dto: Any) -> "FieldDefinitionValue":
        region_id = getattr(dto, "region_id", None)
        return cls(
            key_name=str(dto.key_name).strip(),
            description=str(dto.description).strip(),
            output_format=str(dto.output_format),
            region_id=str(region_id).strip() if region_id else None,
            judgement_enabled=bool(getattr(dto, "judgement_enabled", False)),
        )


@dataclass(frozen=True)
class ClassCandidateValue:
    class_name: str
    description: str

    def __post_init__(self) -> None:
        if not self.class_name.strip():
            raise ValueError("class_name is required")
        if not self.description.strip():
            raise ValueError("class description is required")

    @classmethod
    def from_dto(cls, dto: Any) -> "ClassCandidateValue":
        return cls(class_name=str(dto.class_name).strip(), description=str(dto.description).strip())


@dataclass(frozen=True)
class RequiredFieldItemValue:
    item_name: str
    description: str
    evidence_type: str
    required: bool
    region_id: str | None = None

    def __post_init__(self) -> None:
        if not self.item_name.strip():
            raise ValueError("required item_name is required")
        if not self.description.strip():
            raise ValueError("required item description is required")
        if not self.evidence_type.strip():
            raise ValueError("required item evidence_type is required")

    @classmethod
    def from_dto(cls, dto: Any) -> "RequiredFieldItemValue":
        region_id = getattr(dto, "region_id", None)
        return cls(
            item_name=str(dto.item_name).strip(),
            description=str(dto.description).strip(),
            evidence_type=str(dto.evidence_type).strip(),
            required=bool(dto.required),
            region_id=str(region_id).strip() if region_id else None,
        )
