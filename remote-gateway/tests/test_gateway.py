from pathlib import Path
import tempfile
import unittest

from fastapi.testclient import TestClient

from app import Config, PUBLIC_MODEL_ID, create_app, token_hash


class RecordingHttp:
    def __init__(self): self.calls = []
    def post(self, url, *args, **kwargs):
        self.calls.append(((url, *args), kwargs))
        if url == "https://discord.com/api/oauth2/token": return _Response(200, {"access_token":"discord-access"})
        return _Response(204, {})
    def get(self, url, *args, **kwargs):
        self.calls.append(((url, *args), kwargs))
        if url == "https://discord.com/api/v10/users/@me": return _Response(200, {"id":"123456789012345678","username":"verified-tester"})
        return _Response(404, {})


class _Response:
    def __init__(self, status_code, body): self.status_code, self.body = status_code, body
    def json(self): return self.body


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.http = RecordingHttp()
        config = Config(
            Path(self.temp.name) / "gateway.sqlite3", "", "", "https://example.invalid/webhook", "a" * 32,
            1200, 12 * 1024 * 1024, 30, "123456789012345678", "s" * 32,
            "https://gateway.example/v1/oauth/callback", "k" * 32,
        )
        self.app = create_app(config, http=self.http)
        self.client = TestClient(self.app)

    def tearDown(self): self.temp.cleanup()

    def enroll(self):
        self.enrollment_id = "enr_" + "e" * 43
        self.enrollment_secret = "s" * 48
        response = self.client.post("/v1/oauth/start", json={"enrollment_id":self.enrollment_id,"enrollment_secret":self.enrollment_secret,"installation_id":"i" * 32})
        self.assertEqual(response.status_code, 200)
        self.assertIn("https://discord.com/oauth2/authorize?", response.json()["authorize_url"])
        gateway = self.app.state.gateway
        with gateway.connection() as db:
            state = db.execute("SELECT state FROM oauth_enrollments WHERE enrollment_id=?", (self.enrollment_id,)).fetchone()["state"]
        callback = self.client.get("/v1/oauth/callback", params={"state":state,"code":"discord-code"})
        self.assertEqual(callback.status_code, 200)
        status = self.client.get(f"/v1/oauth/status/{self.enrollment_id}", headers={"X-Krea2-Enrollment-Secret":self.enrollment_secret})
        self.assertEqual(status.status_code, 200)
        return status.json()

    def headers(self, license, request_id):
        return {"Authorization":f"Krea2License {license['license_id']}.{license['license_token']}","X-Krea2-Request-Id":request_id}

    def test_discord_oauth_enrollment_issues_verified_license_and_revocation_blocks_requests(self):
        license = self.enroll()
        self.assertTrue(license["license_id"].startswith("lic_"))
        self.assertGreaterEqual(len(license["license_token"]), 43)
        revoke = self.client.post(f"/v1/admin/licenses/{license['license_id']}/revoke", headers={"X-Krea2-Admin-Key":"a" * 32}, json={"reason":"test"})
        self.assertEqual(revoke.status_code, 200)
        response = self.client.post("/v1/chat/completions", headers=self.headers(license, "a" * 64), json={"model":"gemma4-26b-a4b-heretic-q3-k-l","messages":[{"role":"user","content":"x"}],"temperature":0,"max_tokens":32})
        self.assertEqual(response.status_code, 403)

    def test_audit_is_idempotent_and_never_posts_image_bytes(self):
        license = self.enroll()
        request_id = "b" * 64
        gateway = self.app.state.gateway
        with gateway.connection() as db:
            db.execute("INSERT INTO remote_jobs VALUES(?,?,?,?,?,?,NULL,1,NULL,NULL)", (request_id, license["license_id"], PUBLIC_MODEL_ID, "123456789012345678", "tester", 1))
        body = {"model_id":PUBLIC_MODEL_ID,"prompt_variants":["x " * 700,"y " * 700,"z " * 700],"source_url":""}
        self.assertEqual(self.client.post("/v1/audit/complete", headers=self.headers(license, request_id), json=body).status_code, 200)
        self.assertEqual(self.client.post("/v1/audit/complete", headers=self.headers(license, request_id), json=body).status_code, 200)
        webhook_calls = [call for call in self.http.calls if call[0][0] == "https://example.invalid/webhook"]
        self.assertEqual(len(webhook_calls), 1)
        sent = webhook_calls[0][1]["json"]["content"]
        self.assertIn("KREA2 remote Vision completed", sent)
        self.assertNotIn("data:image", sent)

    def test_oauth_token_is_delivered_once_and_legacy_claims_cannot_authenticate(self):
        license = self.enroll()
        delivered = self.client.get(f"/v1/oauth/status/{self.enrollment_id}", headers={"X-Krea2-Enrollment-Secret":self.enrollment_secret})
        self.assertEqual(delivered.json()["status"], "delivered")
        with self.app.state.gateway.connection() as db:
            db.execute("INSERT INTO licenses(license_id,discord_user_id,discord_username,installation_digest,token_salt,token_digest,auth_method,status,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?)", ("lic_" + "l" * 18, "123456789012345678", "legacy", "x", "salt", token_hash("salt", "t" * 48), "legacy_claim", "active", 1, 1))
        response = self.client.post("/v1/chat/completions", headers={"Authorization":f"Krea2License lic_{'l' * 18}.{'t' * 48}","X-Krea2-Request-Id":"c" * 64}, json={"model":"gemma4-26b-a4b-heretic-q3-k-l","messages":[{"role":"user","content":"x"}],"temperature":0,"max_tokens":32})
        self.assertEqual(response.status_code, 403)


if __name__ == "__main__": unittest.main()
