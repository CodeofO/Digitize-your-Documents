"""export jobs and summary indexes

Revision ID: 0002_export_jobs_and_summary_indexes
Revises: 0001_initial
Create Date: 2026-05-29 00:00:00
"""

from alembic import op
import sqlalchemy as sa


revision = "0002_export_jobs_and_summary_indexes"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


INDEX_SPECS = [
    ("ix_workflow_runs_created_at_id", "workflow_runs", ["created_at", "id"]),
    ("ix_workflow_runs_queue_group_status_order", "workflow_runs", ["workflow_run_group_id", "status", "queue_order", "created_at"]),
    ("ix_workflow_run_items_run_status", "workflow_run_items", ["run_id", "status"]),
    ("ix_workflow_run_items_run_upload_index", "workflow_run_items", ["run_id", "upload_index"]),
    ("ix_batches_created_at_id", "batches", ["created_at", "id"]),
    ("ix_batch_items_batch_job", "batch_items", ["batch_id", "job_id"]),
    ("ix_batch_items_batch_upload_index", "batch_items", ["batch_id", "upload_index"]),
    ("ix_classification_batches_created_at_id", "classification_batches", ["created_at", "id"]),
    ("ix_classification_batch_items_batch_job", "classification_batch_items", ["batch_id", "job_id"]),
    ("ix_classification_batch_items_batch_upload_index", "classification_batch_items", ["batch_id", "upload_index"]),
    ("ix_required_field_check_batches_created_at_id", "required_field_check_batches", ["created_at", "id"]),
    ("ix_required_field_check_batch_items_batch_job", "required_field_check_batch_items", ["batch_id", "job_id"]),
    ("ix_required_field_check_batch_items_batch_upload_index", "required_field_check_batch_items", ["batch_id", "upload_index"]),
    ("ix_export_jobs_owner_created_at", "export_jobs", ["owner_type", "owner_id", "created_at"]),
    ("ix_export_jobs_status_created_at", "export_jobs", ["status", "created_at"]),
]


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "export_jobs" not in tables:
        op.create_table(
            "export_jobs",
            sa.Column("id", sa.String(), primary_key=True, nullable=False),
            sa.Column("owner_type", sa.String(), nullable=False),
            sa.Column("owner_id", sa.String(), nullable=False),
            sa.Column("format", sa.String(), nullable=False),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("filename", sa.String(), nullable=True),
            sa.Column("storage_path", sa.String(), nullable=True),
            sa.Column("content_type", sa.String(), nullable=True),
            sa.Column("size_bytes", sa.Integer(), server_default="0", nullable=False),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
            sa.Column("started_at", sa.DateTime(), nullable=True),
            sa.Column("completed_at", sa.DateTime(), nullable=True),
        )
        tables.add("export_jobs")

    for index_name, table_name, columns in INDEX_SPECS:
        if table_name not in tables:
            continue
        existing_indexes = {index["name"] for index in inspector.get_indexes(table_name)}
        if index_name not in existing_indexes:
            op.create_index(index_name, table_name, columns)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    for index_name, table_name, _columns in reversed(INDEX_SPECS):
        if table_name not in tables:
            continue
        existing_indexes = {index["name"] for index in inspector.get_indexes(table_name)}
        if index_name in existing_indexes:
            op.drop_index(index_name, table_name=table_name)

    if "export_jobs" in tables:
        op.drop_table("export_jobs")
