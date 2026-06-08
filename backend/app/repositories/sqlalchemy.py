from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session

from app.models import Document, ExtractionJob, Schema, WorkflowRun


@dataclass
class SqlAlchemyRepository:
    db: Session
    model: type[Any]

    def get(self, entity_id: str) -> Any | None:
        return self.db.get(self.model, entity_id)

    def add(self, entity: Any) -> None:
        self.db.add(entity)

    def delete(self, entity: Any) -> None:
        self.db.delete(entity)

    def refresh(self, entity: Any) -> None:
        self.db.refresh(entity)


class SqlAlchemyDocumentRepository(SqlAlchemyRepository):
    def __init__(self, db: Session) -> None:
        super().__init__(db, Document)


class SqlAlchemySchemaRepository(SqlAlchemyRepository):
    def __init__(self, db: Session) -> None:
        super().__init__(db, Schema)


class SqlAlchemyExtractionJobRepository(SqlAlchemyRepository):
    def __init__(self, db: Session) -> None:
        super().__init__(db, ExtractionJob)


class SqlAlchemyWorkflowRunRepository(SqlAlchemyRepository):
    def __init__(self, db: Session) -> None:
        super().__init__(db, WorkflowRun)

    def list_recent(self, *, limit: int, workspace_id: str | None) -> list[WorkflowRun]:
        query = self.db.query(WorkflowRun)
        if workspace_id is not None:
            query = query.filter(WorkflowRun.workspace_id == workspace_id)
        return query.order_by(WorkflowRun.created_at.desc(), WorkflowRun.id.desc()).limit(limit).all()
