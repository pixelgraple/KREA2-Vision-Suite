from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient

import app as gateway_module
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
        self.assertEqual(license["discord_user_id"], "123456789012345678")
        self.assertEqual(license["discord_username"], "verified-tester")
        revoke = self.client.post(f"/v1/admin/licenses/{license['license_id']}/revoke", headers={"X-Krea2-Admin-Key":"a" * 32}, json={"reason":"test"})
        self.assertEqual(revoke.status_code, 200)
        response = self.client.post("/v1/chat/completions", headers=self.headers(license, "a" * 64), json={"model":"gemma4-26b-a4b-heretic-q3-k-l","messages":[{"role":"user","content":"x"}],"temperature":0,"max_tokens":32})
        self.assertEqual(response.status_code, 403)

    def test_audit_is_idempotent_and_never_posts_image_bytes(self):
        license = self.enroll()
        request_id = "b" * 64
        gateway = self.app.state.gateway
        with gateway.connection() as db:
            db.execute("INSERT INTO remote_jobs(request_id,license_id,model_id,discord_user_id,discord_username,started_at,calls,source_url,prompt_variants_json,credit_state) VALUES(?,?,?,?,?,?,1,NULL,NULL,'none')", (request_id, license["license_id"], PUBLIC_MODEL_ID, "123456789012345678", "tester", 1))
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

    def test_welcome_credits_are_reserved_once_and_refunded_after_a_failed_image(self):
        license = self.enroll()
        gateway = self.app.state.gateway
        row = gateway.authenticate_license(self.headers(license, "unused" * 11)["Authorization"])
        self.assertEqual(gateway.credit_status(row)["available_credits"], 120)
        now = __import__("time").time_ns() // 1_000_000_000
        with gateway.connection() as db:
            gateway._reserve_image_credits(db, row, "d" * 64, "e" * 64, now)
            with self.assertRaisesRegex(Exception, "already in progress or completed"):
                gateway._reserve_image_credits(db, row, "d" * 64, "e" * 64, now + 1)
        self.assertEqual(gateway.credit_status(row)["available_credits"], 117)
        gateway.fail_audit(row, "d" * 64)
        self.assertEqual(gateway.credit_status(row)["available_credits"], 120)
        with gateway.connection() as db:
            entries = db.execute("SELECT entry_kind,delta_credits FROM credit_ledger WHERE discord_user_id=? ORDER BY entry_id", (row["discord_user_id"],)).fetchall()
        self.assertEqual([(item["entry_kind"], item["delta_credits"]) for item in entries], [("welcome", 120), ("image_reservation", -3), ("image_refund", 3)])

    def test_credit_balance_includes_secret_free_wait_and_refund_preflight(self):
        license = self.enroll()
        gateway = self.app.state.gateway

        async def remote_readiness():
            return {
                "ready_workers": 0,
                "inactive_workers": 1,
                "starting_workers": 0,
                "worker_count": 1,
                "cold_start_eligible": True,
                "reason": "Remote GPU cold worker is prepared and inactive.",
            }

        gateway.remote_readiness = remote_readiness
        response = self.client.get(
            "/v1/credits/balance",
            headers={"Authorization": self.headers(license, "unused" * 11)["Authorization"]},
        )
        self.assertEqual(response.status_code, 200)
        status = response.json()
        self.assertEqual(status["worker_state"], "cold-standby")
        self.assertEqual(status["credits_per_image"], 3)
        self.assertTrue(status["credits_charged_on_success"])
        self.assertTrue(status["failed_or_cancelled_refunded"])
        self.assertGreaterEqual(status["estimated_wait_seconds_max"], status["estimated_wait_seconds_min"])
        self.assertNotIn("vast_api_key", status)

    def test_sleeping_attached_worker_group_accepts_one_cold_start_request(self):
        license = self.enroll()
        gateway = self.app.state.gateway
        gateway.config = Config(
            gateway.config.database, "endpoint", "v" * 24, "", gateway.config.admin_key, 1200,
            12 * 1024 * 1024, 30, gateway.config.discord_client_id, gateway.config.discord_client_secret,
            gateway.config.discord_redirect_uri, gateway.config.license_signing_key,
        )

        sleeping = {
            "workergroup_attached": True, "controller_verified": True,
            "unhealthy_workers": 0, "disallowed_workers": 0,
            "ready_workers": 0, "controller_ready_workers": 0,
            "inactive_workers": 1, "starting_workers": 0,
            "worker_count": 1, "cold_start_eligible": True,
        }
        routed = {
            **sleeping, "ready_workers": 1, "controller_ready_workers": 1,
            "inactive_workers": 0, "worker_count": 1,
            "cold_start_eligible": False,
        }
        readiness_calls = 0

        async def remote_readiness():
            nonlocal readiness_calls
            readiness_calls += 1
            return routed if readiness_calls >= 3 else sleeping

        async def routed_request(_client, _endpoint, _payload, _deadline, *, before_send, **_kwargs):
            await before_send()
            return {"ok": True, "response": {"choices": [{"message": {"content": "cold-start-ok"}}]}}

        class EmptyEndpoint:
            id = 123
            async def get_workers(self): return []

        class EmptyClient:
            async def __aenter__(self): return self
            async def __aexit__(self, *args): return False
            async def get_endpoint(self, _name): return EmptyEndpoint()
            async def find_workergroup_for_endpoint(self, _endpoint_id): return 456

        original = gateway_module.CoroutineServerless
        gateway_module.CoroutineServerless = lambda **_kwargs: EmptyClient()
        gateway.remote_readiness = remote_readiness
        gateway._prepared_activation_machine_ids = lambda: {123}
        gateway._set_activation_floor_async = AsyncMock()
        gateway._restore_activation_floor = AsyncMock()
        gateway._fast_routed_request = routed_request
        try:
            response = self.client.post(
                "/v1/chat/completions", headers=self.headers(license, "f" * 64),
                json={"model":"gemma4-26b-a4b-heretic-q3-k-l","messages":[{"role":"user","content":"x"}],"temperature":0,"max_tokens":32},
            )
        finally:
            gateway_module.CoroutineServerless = original
        self.assertEqual(response.status_code, 200)
        self.assertGreaterEqual(readiness_calls, 3)
        gateway._set_activation_floor_async.assert_awaited_once_with(1.0)
        gateway._restore_activation_floor.assert_awaited_once()
        self.assertEqual(gateway.credit_status(gateway.authenticate_license(self.headers(license, "f" * 64)["Authorization"]))["available_credits"], 117)

    def test_signed_settlement_webhook_credits_once(self):
        license = self.enroll()
        gateway = self.app.state.gateway
        gateway.config = Config(
            gateway.config.database, "", "", "", gateway.config.admin_key, 1200, 12 * 1024 * 1024, 30,
            gateway.config.discord_client_id, gateway.config.discord_client_secret, gateway.config.discord_redirect_uri,
            gateway.config.license_signing_key, "https://bitcoin.example", "store-123", "p" * 24, "w" * 32,
        )
        with gateway.connection() as db:
            db.execute("INSERT INTO credit_invoices(invoice_id,purchase_reference,discord_user_id,license_id,credits,amount,currency,checkout_url,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", ("invoice-1", "purchase-1", "123456789012345678", license["license_id"], 1200, "20", "USD", "https://bitcoin.example/i/invoice-1", "new", 1))
        body = b'{"deliveryId":"delivery-1","type":"InvoiceSettled","invoiceId":"invoice-1","storeId":"store-123"}'
        signature = "sha256=" + __import__("hmac").new(b"w" * 32, body, __import__("hashlib").sha256).hexdigest()
        gateway.accept_btcpay_webhook(body, signature)
        gateway.accept_btcpay_webhook(body, signature)
        row = gateway.authenticate_license(self.headers(license, "unused" * 11)["Authorization"])
        self.assertEqual(gateway.credit_status(row)["available_credits"], 1320)


if __name__ == "__main__": unittest.main()
