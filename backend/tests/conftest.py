import os
import tempfile
from pathlib import Path

TEST_DIR = Path(tempfile.mkdtemp(prefix="kie_backend_tests_"))
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DIR / 'kie_test.db'}"
os.environ["DOCUMENT_STORAGE_DIR"] = str(TEST_DIR / "storage")
os.environ["RAW_STORAGE_DIR"] = str(TEST_DIR / "raw_storage")
os.environ["VLM_PROVIDER"] = "openai"
os.environ["VLM_API_KEY"] = ""
os.environ["VLM_MODEL_NAME"] = ""
os.environ["OPENAI_API_KEY"] = ""
os.environ["OPENAI_MODEL_NAME"] = ""

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


def get_client() -> TestClient:
    return TestClient(app)
