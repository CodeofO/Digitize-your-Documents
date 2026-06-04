"""workspace scope columns

Revision ID: 0003_workspace_scope_columns
Revises: 0002_export_jobs_and_summary_indexes
Create Date: 2026-05-30 00:00:00
"""

from alembic import op
import sqlalchemy as sa


revision = "0003_workspace_scope_columns"
down_revision = "0002_export_jobs_and_summary_indexes"
branch_labels = None
depends_on = None


SCOPED_TABLES = [
    "documents",
    "document_library_folders",
    "schemas",
    "extraction_jobs",
    "raw_extractions",
    "document_classifiers",
    "classification_jobs",
    "classification_batches",
    "required_field_checklists",
    "required_field_check_jobs",
    "required_field_check_batches",
    "batches",
    "export_presets",
    "export_jobs",
    "workflow_definitions",
    "workflow_runs",
    "audit_events",
]


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    for table_name in SCOPED_TABLES:
        if table_name not in tables:
            continue
        columns = {column["name"] for column in inspector.get_columns(table_name)}
        if "workspace_id" not in columns:
            op.add_column(table_name, _scope_column())

    _ensure_index(
        inspector,
        tables,
        "document_library_folders",
        "ix_document_library_folders_workspace_path",
        ["workspace_id", "path"],
        unique=True,
    )

    for table_name in SCOPED_TABLES:
        if table_name in tables:
            _ensure_index(inspector, tables, table_name, f"ix_{table_name}_workspace_id", ["workspace_id"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    for table_name in reversed(SCOPED_TABLES):
        if table_name not in tables:
            continue
        existing_indexes = {index["name"] for index in inspector.get_indexes(table_name)}
        index_name = f"ix_{table_name}_workspace_id"
        if index_name in existing_indexes:
            op.drop_index(index_name, table_name=table_name)
        if table_name == "document_library_folders" and "ix_document_library_folders_workspace_path" in existing_indexes:
            op.drop_index("ix_document_library_folders_workspace_path", table_name=table_name)
        columns = {column["name"] for column in inspector.get_columns(table_name)}
        if "workspace_id" in columns:
            op.drop_column(table_name, "workspace_id")


def _ensure_index(
    inspector,
    tables: set[str],
    table_name: str,
    index_name: str,
    columns: list[str],
    *,
    unique: bool = False,
) -> None:
    if table_name not in tables:
        return
    existing_indexes = {index["name"] for index in inspector.get_indexes(table_name)}
    if index_name not in existing_indexes:
        op.create_index(index_name, table_name, columns, unique=unique)


def _scope_column() -> sa.Column:
    return sa.Column("workspace_id", sa.String(), nullable=True)
