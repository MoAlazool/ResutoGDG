import os
import sys
from pathlib import Path

os.environ["AI_SERVICE_SKIP_IMPORT_APP"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import create_app  # noqa: E402

TOKEN = "test-token-0123456789abcdef"


@pytest.fixture(scope="session")
def client():
    return TestClient(create_app(token=TOKEN))


@pytest.fixture(scope="session")
def auth():
    return {"Authorization": f"Bearer {TOKEN}"}
