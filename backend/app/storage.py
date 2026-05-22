import shutil
from pathlib import Path
from uuid import uuid4

from app.config import get_settings


def is_s3_ref(ref: str | Path) -> bool:
    return str(ref).startswith("s3://")


def storage_ref_name(ref: str | Path) -> str:
    return Path(str(ref).split("/", 3)[-1]).name if is_s3_ref(ref) else Path(ref).name


def read_storage_bytes(ref: str | Path) -> bytes:
    if is_s3_ref(ref):
        return _s3_client().get_object(Bucket=_s3_bucket_from_ref(str(ref)), Key=_s3_key_from_ref(str(ref)))["Body"].read()
    return Path(ref).read_bytes()


def materialize_storage_ref(ref: str | Path, suffix: str | None = None) -> Path:
    if not is_s3_ref(ref):
        return Path(ref)
    name = storage_ref_name(ref)
    target_suffix = suffix if suffix is not None else Path(name).suffix
    target_dir = get_settings().resolved_processing_tmp_dir / "materialized" / uuid4().hex
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"file{target_suffix or '.bin'}"
    target.write_bytes(read_storage_bytes(ref))
    return target


def scratch_dir_for_ref(ref: str | Path, *parts: str) -> Path:
    base = get_settings().resolved_processing_tmp_dir / "scratch"
    if is_s3_ref(ref):
        key = _s3_key_from_ref(str(ref)).replace("/", "_")
        path = base / key
    else:
        path = Path(ref).parent
    for part in parts:
        path = path / part
    path.mkdir(parents=True, exist_ok=True)
    return path


def persist_artifact(path: Path, key: str, content_type: str | None = None) -> str:
    settings = get_settings()
    if settings.storage_backend.strip().lower() != "s3":
        return str(path)
    bucket = _configured_bucket()
    final_key = _object_key(key)
    extra_args = {"ContentType": content_type} if content_type else None
    if extra_args:
        _s3_client().upload_file(str(path), bucket, final_key, ExtraArgs=extra_args)
    else:
        _s3_client().upload_file(str(path), bucket, final_key)
    return f"s3://{bucket}/{final_key}"


def delete_storage_ref(ref: str | Path) -> None:
    if is_s3_ref(ref):
        _s3_client().delete_object(Bucket=_s3_bucket_from_ref(str(ref)), Key=_s3_key_from_ref(str(ref)))
        return
    path = Path(ref)
    if path.is_dir():
        shutil.rmtree(path, ignore_errors=True)
    elif path.exists():
        path.unlink()


def delete_local_tree(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def _object_key(key: str) -> str:
    prefix = (get_settings().object_storage_prefix or "").strip().strip("/")
    clean_key = key.strip().lstrip("/")
    return f"{prefix}/{clean_key}" if prefix else clean_key


def _configured_bucket() -> str:
    bucket = (get_settings().object_storage_bucket or "").strip()
    if not bucket:
        raise RuntimeError("OBJECT_STORAGE_BUCKET is required when STORAGE_BACKEND=s3")
    return bucket


def _s3_bucket_from_ref(ref: str) -> str:
    without_scheme = ref.removeprefix("s3://")
    return without_scheme.split("/", 1)[0]


def _s3_key_from_ref(ref: str) -> str:
    without_scheme = ref.removeprefix("s3://")
    return without_scheme.split("/", 1)[1]


def _s3_client():
    try:
        import boto3
        from botocore.config import Config
    except ImportError as exc:  # pragma: no cover - optional hosting dependency
        raise RuntimeError("boto3 is required when STORAGE_BACKEND=s3") from exc

    settings = get_settings()
    config = Config(s3={"addressing_style": "path" if settings.object_storage_force_path_style else "auto"})
    return boto3.client(
        "s3",
        endpoint_url=settings.object_storage_endpoint_url or None,
        region_name=settings.object_storage_region or None,
        aws_access_key_id=settings.object_storage_access_key_id or None,
        aws_secret_access_key=settings.object_storage_secret_access_key or None,
        config=config,
    )
