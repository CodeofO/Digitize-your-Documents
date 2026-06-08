from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app.schemas import SystemStatusRead, VlmSettingsRead, VlmSettingsUpdate
from app.services.vlm_settings import VlmSettingsService
from app.workspace import require_workspace_settings_admin

router = APIRouter()


def _vlm_settings_service() -> VlmSettingsService:
    return VlmSettingsService()


@router.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/api/system/status", response_model=SystemStatusRead)
def system_status(service: VlmSettingsService = Depends(_vlm_settings_service)) -> SystemStatusRead:
    return service.read_system_status()


@router.get("/api/settings/vlm", response_model=VlmSettingsRead)
def get_vlm_settings(service: VlmSettingsService = Depends(_vlm_settings_service)) -> VlmSettingsRead:
    return service.read_vlm_settings()


@router.put("/api/settings/vlm", response_model=VlmSettingsRead)
def update_vlm_settings(
    payload: VlmSettingsUpdate,
    request: Request,
    db: Session = Depends(get_db),
    service: VlmSettingsService = Depends(_vlm_settings_service),
) -> VlmSettingsRead:
    require_workspace_settings_admin(request, db)
    return service.update_vlm_settings(payload)
