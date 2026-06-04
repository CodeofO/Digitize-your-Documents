import os
import sqlite3
import subprocess
import sys
from pathlib import Path


def test_workspace_scope_migration_upgrades_legacy_sqlite_database(tmp_path: Path) -> None:
    db_path = tmp_path / "legacy.db"
    connection = sqlite3.connect(db_path)
    connection.executescript(
        """
        CREATE TABLE documents (
            id VARCHAR PRIMARY KEY,
            filename VARCHAR NOT NULL
        );
        CREATE TABLE schemas (
            id VARCHAR PRIMARY KEY,
            name VARCHAR NOT NULL
        );
        CREATE TABLE batches (
            id VARCHAR PRIMARY KEY,
            status VARCHAR NOT NULL
        );
        CREATE TABLE alembic_version (
            version_num VARCHAR(32) NOT NULL
        );
        INSERT INTO alembic_version (version_num) VALUES ('0002_export_jobs_and_summary_indexes');
        """
    )
    connection.commit()
    connection.close()

    backend_dir = Path(__file__).resolve().parents[1]
    env = {
        **os.environ,
        "DATABASE_URL": f"sqlite:///{db_path}",
        "DOCUMENT_STORAGE_DIR": str(tmp_path / "storage"),
        "RAW_STORAGE_DIR": str(tmp_path / "raw"),
    }
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=backend_dir,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert result.returncode == 0, result.stderr or result.stdout

    connection = sqlite3.connect(db_path)
    try:
        for table_name in ["documents", "schemas", "batches"]:
            columns = {row[1] for row in connection.execute(f'PRAGMA table_info("{table_name}")')}
            assert "workspace_id" in columns
        version = connection.execute("SELECT version_num FROM alembic_version").fetchone()
        assert version == ("0003_workspace_scope_columns",)
    finally:
        connection.close()
