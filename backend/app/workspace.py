from typing import Any

from fastapi import HTTPException, Request
from sqlalchemy.orm import Session


def current_workspace_id(request: Request) -> str | None:
    return None


def scope_query(query, model, workspace_id: str | None):
    if workspace_id is None:
        return query
    return query.filter(model.workspace_id == workspace_id)


def ensure_workspace_scope(row: Any, workspace_id: str | None, detail: str) -> None:
    if not row:
        raise HTTPException(status_code=404, detail=detail)
    row_workspace_id = getattr(row, "workspace_id", None)
    if workspace_id is not None and row_workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail=detail)


def require_workspace_admin_mode() -> None:
    return None


def require_workspace_settings_admin(request: Request, db: Session) -> None:
    return None
