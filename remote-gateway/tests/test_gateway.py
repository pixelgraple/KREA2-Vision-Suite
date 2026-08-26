from pathlib import Path
import tempfile
import unittest

from fastapi.testclient import TestClient

from app import Config, PUBLIC_MODEL_ID, create_app


class RecordingHttp:
    def __init__(self): self.calls = []
    def post(self, *args, **kwargs): self.calls.append((args, kwargs)); return object()


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.http = RecordingHttp()
        config = Config(Path(self.temp.name) / "gateway.sqlite3", "", "", "https://example.invalid/webhook", "a" * 32, 1200, 12 * 1024 * 1024, 30)
        self.app = create_app(config, http=self.http)
        self.client = TestClient(self.app)

    def tearDown(self): self.temp.cleanup()

    def claim(self):
        response = self.client.post("/v1/licenses/claim", json={"discord_user_id":"123456789012345678","discord_username":"tester","installation_id":"i" * 32})
        self.assertEqual(response.status_code, 200)
        return response.json()

    def headers(self, license, request_id):
        return {"Authorization":f"Krea2License {license['license_id']}.{license['license_token']}","X-Krea2-Discord-User":"123456789012345678","X-Krea2-Request-Id":request_id}

    def test_claim_is_random_and_revocation_blocks_requests(self):
        license = self.claim()
        self.assertTrue(license["license_id"].startswith("lic_"))
        self.assertGreaterEqual(len(license["license_token"]), 43)
        revoke = self.client.post(f"/v1/admin/licenses/{license['license_id']}/revoke", headers={"X-Krea2-Admin-Key":"a" * 32}, json={"reason":"test"})
        self.assertEqual(revoke.status_code, 200)
        response = self.client.post("/v1/chat/completions", headers=self.headers(license, "a" * 64), json={"model":"gemma4-26b-a4b-heretic-q3-k-l","messages":[{"role":"user","content":"x"}],"temperature":0,"max_tokens":32})
        self.assertEqual(response.status_code, 403)

    def test_audit_is_idempotent_and_never_posts_image_bytes(self):
        license = self.claim()
        request_id = "b" * 64
        gateway = self.app.state.gateway
        with gateway.connection() as db:
            db.execute("INSERT INTO remote_jobs VALUES(?,?,?,?,?,?,NULL,1,NULL,NULL)", (request_id, license["license_id"], PUBLIC_MODEL_ID, "123456789012345678", "tester", 1))
        body = {"model_id":PUBLIC_MODEL_ID,"prompt_variants":["x " * 700,"y " * 700,"z " * 700],"source_url":""}
        self.assertEqual(self.client.post("/v1/audit/complete", headers=self.headers(license, request_id), json=body).status_code, 200)
        self.assertEqual(self.client.post("/v1/audit/complete", headers=self.headers(license, request_id), json=body).status_code, 200)
        self.assertEqual(len(self.http.calls), 1)
        sent = self.http.calls[0][1]["json"]["content"]
        self.assertIn("KREA2 remote Vision completed", sent)
        self.assertNotIn("data:image", sent)


if __name__ == "__main__": unittest.main()
