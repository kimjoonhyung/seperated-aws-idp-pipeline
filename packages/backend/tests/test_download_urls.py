"""다운로드 URL 발급 엔드포인트 테스트."""

from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
HEADERS = {"x-user-id": "user-1"}


class TestArtifactDownloadUrl:
    @patch("app.routers.artifacts.generate_presigned_url", return_value="https://signed.example/art")
    @patch("app.routers.artifacts.get_artifact_item")
    def test_owner_gets_url(self, mock_get, _mock_presign):
        mock_get.return_value = SimpleNamespace(
            data=SimpleNamespace(user_id="user-1", s3_bucket="b", s3_key="k/file.pdf", filename="file.pdf")
        )
        resp = client.get("/artifacts/art-1/download-url", headers=HEADERS)
        assert resp.status_code == 200
        assert resp.json()["url"] == "https://signed.example/art"
        assert resp.json()["filename"] == "file.pdf"

    @patch("app.routers.artifacts.get_artifact_item")
    def test_non_owner_forbidden(self, mock_get):
        mock_get.return_value = SimpleNamespace(
            data=SimpleNamespace(user_id="someone-else", s3_bucket="b", s3_key="k", filename="f")
        )
        resp = client.get("/artifacts/art-1/download-url", headers=HEADERS)
        assert resp.status_code == 403

    @patch("app.routers.artifacts.get_artifact_item", return_value=None)
    def test_missing_artifact(self, _mock_get):
        resp = client.get("/artifacts/art-1/download-url", headers=HEADERS)
        assert resp.status_code == 404


class TestDocumentDownloadUrl:
    @patch("app.routers.documents.generate_presigned_url", return_value="https://signed.example/doc")
    @patch("app.routers.documents.get_document_item")
    def test_success(self, mock_get, _mock_presign):
        mock_get.return_value = SimpleNamespace(data=SimpleNamespace(s3_key="k/doc.pdf", name="doc.pdf"))
        resp = client.get("/projects/p-1/documents/d-1/download-url", headers=HEADERS)
        assert resp.status_code == 200
        assert resp.json()["url"] == "https://signed.example/doc"

    @patch("app.routers.documents.get_document_item", return_value=None)
    def test_missing_document(self, _mock_get):
        resp = client.get("/projects/p-1/documents/d-1/download-url", headers=HEADERS)
        assert resp.status_code == 404
