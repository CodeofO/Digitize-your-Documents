import pytest

from app.domain.schema_definition import (
    ClassCandidateValue,
    FieldDefinitionValue,
    FieldRegionValue,
    RequiredFieldItemValue,
    SchemaRegionValue,
)
from app.schemas import ClassCandidate, FieldDefinition, RequiredFieldItem, SchemaRegion


def test_field_definition_value_normalizes_schema_dto() -> None:
    dto = FieldDefinition(
        key_name=" 고객명 ",
        description=" 고객 이름 ",
        output_format="string",
        region_id=" sig ",
        judgement_enabled=True,
    )

    value = FieldDefinitionValue.from_dto(dto)

    assert value.key_name == "고객명"
    assert value.description == "고객 이름"
    assert value.region_id == "sig"
    assert value.judgement_enabled is True


def test_field_region_value_rejects_out_of_bounds_region() -> None:
    with pytest.raises(ValueError, match="x \\+ width"):
        FieldRegionValue(page=1, x=0.8, y=0.1, width=0.3, height=0.2)


def test_schema_region_value_keeps_region_identity() -> None:
    dto = SchemaRegion(id="sign", name="서명 영역", page=1, x=0.1, y=0.2, width=0.3, height=0.4)

    value = SchemaRegionValue.from_dto(dto)

    assert value.id == "sign"
    assert value.name == "서명 영역"
    assert value.page == 1


def test_class_candidate_and_required_item_values_from_dtos() -> None:
    class_value = ClassCandidateValue.from_dto(ClassCandidate(class_name="신청서", description="신청 문서"))
    item_value = RequiredFieldItemValue.from_dto(
        RequiredFieldItem(
            item_name="서명",
            description="고객 서명",
            evidence_type="text_or_handwriting",
            required=True,
        )
    )

    assert class_value.class_name == "신청서"
    assert item_value.item_name == "서명"
    assert item_value.required is True
