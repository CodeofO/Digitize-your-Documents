from collections.abc import Generator

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings


class Base(DeclarativeBase):
    pass


settings = get_settings()
is_sqlite = settings.resolved_database_url.startswith("sqlite")
connect_args = {"check_same_thread": False, "timeout": 30} if is_sqlite else {}
pool_args = {
    "pool_size": settings.database_pool_size,
    "max_overflow": settings.database_max_overflow,
    "pool_timeout": settings.database_pool_timeout_seconds,
}
engine = create_engine(settings.resolved_database_url, connect_args=connect_args, pool_pre_ping=True, **pool_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


if is_sqlite:
    @event.listens_for(engine, "connect")
    def _configure_sqlite_connection(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.close()


def init_db() -> None:
    import app.models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _run_lightweight_migrations()


def _run_lightweight_migrations() -> None:
    if not is_sqlite:
        return

    column_specs = {
        "documents": [
            ("library_path", "VARCHAR"),
            ("error_message", "TEXT"),
            ("document_type", "VARCHAR"),
            ("language", "VARCHAR"),
            ("ai_summary", "TEXT"),
            ("recommendation_reasoning", "TEXT"),
            ("deleted_at", "DATETIME"),
        ],
        "schemas": [
            ("schema_json", "TEXT"),
            ("is_template", "INTEGER NOT NULL DEFAULT 0"),
            ("template_category", "VARCHAR"),
            ("pinned", "INTEGER NOT NULL DEFAULT 0"),
            ("ephemeral", "INTEGER NOT NULL DEFAULT 0"),
            ("archived", "INTEGER NOT NULL DEFAULT 0"),
        ],
        "extraction_results": [
            ("reviewed_fields", "TEXT NOT NULL DEFAULT '[]'"),
        ],
        "batch_items": [
            ("client_file_id", "VARCHAR"),
            ("upload_index", "INTEGER"),
        ],
        "classification_batch_items": [
            ("client_file_id", "VARCHAR"),
            ("upload_index", "INTEGER"),
        ],
        "required_field_check_batch_items": [
            ("client_file_id", "VARCHAR"),
            ("upload_index", "INTEGER"),
        ],
        "workflow_runs": [
            ("workflow_name", "VARCHAR"),
            ("workflow_definition_json", "TEXT"),
            ("restarted_from_run_id", "VARCHAR"),
            ("workflow_run_group_id", "VARCHAR"),
            ("queued_from_run_id", "VARCHAR"),
            ("queue_order", "INTEGER"),
            ("upload_duration_ms", "INTEGER"),
            ("inference_duration_ms", "INTEGER"),
            ("started_at", "DATETIME"),
            ("inference_started_at", "DATETIME"),
            ("execution_generation", "INTEGER NOT NULL DEFAULT 0"),
        ],
        "workflow_run_items": [
            ("client_file_id", "VARCHAR"),
            ("upload_index", "INTEGER"),
            ("upload_duration_ms", "INTEGER"),
            ("inference_duration_ms", "INTEGER"),
            ("execution_generation", "INTEGER NOT NULL DEFAULT 0"),
        ],
    }
    scoped_tables = [
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
    for table_name in scoped_tables:
        column_specs.setdefault(table_name, []).insert(0, ("workspace_id", "VARCHAR"))

    index_specs = [
        (
            "ix_workflow_runs_created_at_id",
            "workflow_runs",
            '"created_at", "id"',
        ),
        (
            "ix_workflow_runs_queue_group_status_order",
            "workflow_runs",
            '"workflow_run_group_id", "status", "queue_order", "created_at"',
        ),
        (
            "ix_workflow_run_items_run_status",
            "workflow_run_items",
            '"run_id", "status"',
        ),
        (
            "ix_workflow_run_items_run_upload_index",
            "workflow_run_items",
            '"run_id", "upload_index"',
        ),
        (
            "ix_batches_created_at_id",
            "batches",
            '"created_at", "id"',
        ),
        (
            "ix_batch_items_batch_job",
            "batch_items",
            '"batch_id", "job_id"',
        ),
        (
            "ix_batch_items_batch_upload_index",
            "batch_items",
            '"batch_id", "upload_index"',
        ),
        (
            "ix_classification_batches_created_at_id",
            "classification_batches",
            '"created_at", "id"',
        ),
        (
            "ix_classification_batch_items_batch_job",
            "classification_batch_items",
            '"batch_id", "job_id"',
        ),
        (
            "ix_classification_batch_items_batch_upload_index",
            "classification_batch_items",
            '"batch_id", "upload_index"',
        ),
        (
            "ix_required_field_check_batches_created_at_id",
            "required_field_check_batches",
            '"created_at", "id"',
        ),
        (
            "ix_required_field_check_batch_items_batch_job",
            "required_field_check_batch_items",
            '"batch_id", "job_id"',
        ),
        (
            "ix_required_field_check_batch_items_batch_upload_index",
            "required_field_check_batch_items",
            '"batch_id", "upload_index"',
        ),
        (
            "ix_export_jobs_owner_created_at",
            "export_jobs",
            '"owner_type", "owner_id", "created_at"',
        ),
        (
            "ix_export_jobs_status_created_at",
            "export_jobs",
            '"status", "created_at"',
        ),
    ]
    index_specs.extend(
        (f"ix_{table_name}_workspace_id", table_name, '"workspace_id"')
        for table_name in scoped_tables
    )

    with engine.begin() as connection:
        tables = {
            row[0]
            for row in connection.execute(text("SELECT name FROM sqlite_master WHERE type='table'")).all()
        }
        for table_name, specs in column_specs.items():
            if table_name not in tables:
                continue
            existing = {
                row[1]
                for row in connection.execute(text(f'PRAGMA table_info("{table_name}")')).all()
            }
            for column_name, sql_type in specs:
                if column_name not in existing:
                    connection.execute(text(f'ALTER TABLE "{table_name}" ADD COLUMN "{column_name}" {sql_type}'))

        for index_name, table_name, columns_sql in index_specs:
            if table_name in tables:
                connection.execute(text(f'CREATE INDEX IF NOT EXISTS "{index_name}" ON "{table_name}" ({columns_sql})'))

        if "schemas" in tables:
            schema_columns = {
                row[1]
                for row in connection.execute(text('PRAGMA table_info("schemas")')).all()
            }
            if "schema_json" in schema_columns and "current_version" in schema_columns and "schema_versions" in tables:
                connection.execute(
                    text(
                        """
                        UPDATE schemas
                        SET schema_json = (
                            SELECT schema_versions.schema_json
                            FROM schema_versions
                            WHERE schema_versions.schema_id = schemas.id
                              AND schema_versions.version = schemas.current_version
                            LIMIT 1
                        )
                        WHERE (schema_json IS NULL OR schema_json = '' OR schema_json = '{}')
                          AND EXISTS (
                            SELECT 1
                            FROM schema_versions
                            WHERE schema_versions.schema_id = schemas.id
                              AND schema_versions.version = schemas.current_version
                          )
                        """
                    )
                )


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
