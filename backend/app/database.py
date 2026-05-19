from collections.abc import Generator

from sqlalchemy import create_engine, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings


class Base(DeclarativeBase):
    pass


settings = get_settings()
connect_args = {"check_same_thread": False} if settings.resolved_database_url.startswith("sqlite") else {}
engine = create_engine(settings.resolved_database_url, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def init_db() -> None:
    import app.models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _run_lightweight_migrations()


def _run_lightweight_migrations() -> None:
    if not settings.resolved_database_url.startswith("sqlite"):
        return

    column_specs = {
        "documents": [
            ("document_type", "VARCHAR"),
            ("language", "VARCHAR"),
            ("ai_summary", "TEXT"),
            ("recommendation_reasoning", "TEXT"),
        ],
        "schemas": [
            ("is_template", "INTEGER NOT NULL DEFAULT 0"),
            ("template_category", "VARCHAR"),
            ("pinned", "INTEGER NOT NULL DEFAULT 0"),
        ],
        "extraction_results": [
            ("reviewed_fields", "TEXT NOT NULL DEFAULT '[]'"),
        ],
    }

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


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
