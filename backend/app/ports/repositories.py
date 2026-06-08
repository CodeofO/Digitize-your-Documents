from typing import Any, Protocol, TypeVar

T = TypeVar("T")


class Repository(Protocol[T]):
    def get(self, entity_id: str) -> T | None:
        ...

    def add(self, entity: T) -> None:
        ...

    def delete(self, entity: T) -> None:
        ...

    def refresh(self, entity: T) -> None:
        ...


class DocumentRepository(Repository[Any], Protocol):
    pass


class SchemaRepository(Repository[Any], Protocol):
    pass


class ExtractionJobRepository(Repository[Any], Protocol):
    pass


class WorkflowRunRepository(Repository[Any], Protocol):
    def list_recent(self, *, limit: int, workspace_id: str | None) -> list[Any]:
        ...
