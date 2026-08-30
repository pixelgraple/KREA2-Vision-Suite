from __future__ import annotations

import hashlib
import importlib.util
import os
import secrets
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException


MODULE_PATH = Path(__file__).resolve().parents[1] / "app.py"
os.environ.setdefault("KREA2_GATEWAY_DB", str(Path(__file__).with_name("import-test.sqlite3")))
spec = importlib.util.spec_from_file_location("prompt_chat_gateway", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
assert spec and spec.loader
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def make_gateway(root: Path, *, webhook_url: str = "", http=None):
    config = module.Config(
        database=root / "gateway.sqlite3",
        vast_endpoint="vision-endpoint",
        vast_api_key="v" * 64,
        audit_webhook_url=webhook_url,
        admin_key="a" * 64,
        request_timeout_seconds=120,
        max_request_bytes=32 * 1024 * 1024,
        retention_days=30,
        discord_client_id="",
        discord_client_secret="",
        discord_redirect_uri="",
        license_signing_key="s" * 64,
        prompt_chat_endpoint="local-openwebui-coding",
        prompt_chat_api_key="q" * 64,
        prompt_chat_timeout_seconds=300,
        dedicated_base_url="http://dedicated.test",
        dedicated_api_key="d" * 64,
    )
    gateway = module.Gateway(config, http=http or module.requests)
    async def fake_dedicated_completion(payload, **kwargs):
        return await FakeServerless.endpoint.request("/v1/chat/completions", payload, **kwargs)
    gateway._dedicated_completion = fake_dedicated_completion
    now = int(time.time())
    token = secrets.token_urlsafe(32)
    with gateway.connection() as db:
        db.execute(
            "INSERT INTO licenses(license_id,discord_user_id,discord_username,installation_digest,token_salt,token_digest,auth_method,status,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            ("lic_prompt_editor_test", "12345678901234567", "tester", "i", "salt", module.token_hash("salt", token), "discord_oauth", "active", now, now),
        )
        gateway._grant_welcome_credits(db, "12345678901234567", now)
        license_row = db.execute("SELECT * FROM licenses WHERE license_id='lic_prompt_editor_test'").fetchone()
    return gateway, license_row


class WebhookResponse:
    status_code = 204


class FakeWebhookHttp:
    def __init__(self):
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return WebhookResponse()


class FakeEndpoint:
    def __init__(self, *, fail: bool = False, output_tokens: int | None = 42):
        self.fail = fail
        self.output_tokens = output_tokens
        self.calls = []

    async def request(self, route, payload, **kwargs):
        self.calls.append((route, payload, kwargs))
        if self.fail:
            raise RuntimeError("provider unavailable")
        response = {
            "ok": True,
            "response": {
                "choices": [{"message": {"content": "<think>private</think>\nA complete revised KREA2 prompt."}}],
            },
        }
        if self.output_tokens is not None:
            response["response"]["usage"] = {"completion_tokens": self.output_tokens}
        return response


class FakeServerless:
    endpoint = FakeEndpoint()

    def __init__(self, **kwargs):
        self.kwargs = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def get_endpoint(self, name):
        assert name == "local-openwebui-coding"
        return self.endpoint


class PromptChatGatewayTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    async def test_prompt_chat_charges_once_and_does_not_store_conversation(self):
        gateway, license_row = make_gateway(self.root)
        FakeServerless.endpoint = FakeEndpoint()
        payload = module.PromptChatRequest(messages=[{"role": "user", "content": "Make the lighting warmer."}])
        request_id = hashlib.sha256(b"success").hexdigest()
        with patch.object(module, "CoroutineServerless", FakeServerless):
            result = await gateway.prompt_chat(payload, license_row, request_id)

        self.assertEqual(result["reply"], "A complete revised KREA2 prompt.")
        self.assertEqual(result["credits_charged"], 1)
        self.assertEqual(result["output_tokens"], 42)
        self.assertEqual(result["output_tokens_per_credit"], 350)
        self.assertEqual(result["available_credits"], 59)
        route, sent, kwargs = FakeServerless.endpoint.calls[0]
        self.assertEqual(route, "/v1/chat/completions")
        self.assertEqual(sent["model"], module.PROMPT_CHAT_MODEL_ID)
        self.assertEqual(sent["messages"][0]["role"], "system")
        self.assertIn("creating and revising image-generation prompts", sent["messages"][0]["content"])
        self.assertIn("supplies a short concept", sent["messages"][0]["content"])
        self.assertEqual(sent["messages"][-1]["content"], "Make the lighting warmer.")
        self.assertEqual(kwargs["model"], module.DEDICATED_QWEN_MODEL_ID)
        with gateway.connection() as db:
            job = db.execute("SELECT * FROM prompt_chat_jobs WHERE request_id=?", (request_id,)).fetchone()
            self.assertEqual(job["credit_state"], "charged")
            self.assertNotIn("content", job.keys())
            self.assertEqual(gateway._account_balance(db, "12345678901234567"), 59)
            reservation = db.execute(
                "SELECT delta_credits FROM credit_ledger WHERE request_id=? AND entry_kind='prompt_chat_reservation'",
                (request_id,),
            ).fetchone()
            unused = db.execute(
                "SELECT delta_credits FROM credit_ledger WHERE request_id=? AND entry_kind='prompt_chat_unused_refund'",
                (request_id,),
            ).fetchone()
            self.assertEqual(reservation["delta_credits"], -5)
            self.assertEqual(unused["delta_credits"], 4)

        with patch.object(module, "CoroutineServerless", FakeServerless):
            with self.assertRaises(HTTPException) as replay:
                await gateway.prompt_chat(payload, license_row, request_id)
        self.assertEqual(replay.exception.status_code, 409)

    async def test_prompt_chat_failure_refunds_credit(self):
        gateway, license_row = make_gateway(self.root)
        FakeServerless.endpoint = FakeEndpoint(fail=True)
        payload = module.PromptChatRequest(messages=[{"role": "user", "content": "Shorten this prompt."}])
        request_id = hashlib.sha256(b"failure").hexdigest()
        with patch.object(module, "CoroutineServerless", FakeServerless):
            with self.assertRaises(HTTPException) as failed:
                await gateway.prompt_chat(payload, license_row, request_id)
        self.assertEqual(failed.exception.status_code, 503)
        self.assertIn("no credit was charged", failed.exception.detail)
        with gateway.connection() as db:
            job = db.execute("SELECT * FROM prompt_chat_jobs WHERE request_id=?", (request_id,)).fetchone()
            self.assertEqual(job["credit_state"], "refunded")
            self.assertEqual(gateway._account_balance(db, "12345678901234567"), 60)

    async def test_general_qwen_chat_uses_separate_protected_system_mode(self):
        gateway, license_row = make_gateway(self.root)
        FakeServerless.endpoint = FakeEndpoint()
        payload = module.PromptChatRequest(
            experience="general_chat",
            messages=[{"role": "user", "content": "Create a small Python file named app.py."}],
        )
        request_id = hashlib.sha256(b"general-chat-success").hexdigest()
        with patch.object(module, "CoroutineServerless", FakeServerless):
            result = await gateway.prompt_chat(payload, license_row, request_id)

        self.assertEqual(result["experience"], "general_chat")
        self.assertEqual(result["credits_charged"], 1)
        _, sent, _ = FakeServerless.endpoint.calls[0]
        system = sent["messages"][0]["content"]
        self.assertIn("general-purpose conversational assistant", system)
        self.assertIn("filename=<safe-filename>", system)
        self.assertNotIn("creating and revising image-generation prompts", system)
        self.assertEqual(sent["messages"][-1]["content"], "Create a small Python file named app.py.")

    def test_general_qwen_chat_rejects_unknown_experience(self):
        payload = module.PromptChatRequest(
            experience="unknown_chat",
            messages=[{"role": "user", "content": "Hello"}],
        )
        with self.assertRaises(HTTPException) as invalid:
            module.Gateway._prompt_chat_content(payload)
        self.assertEqual(invalid.exception.status_code, 422)

    async def test_prompt_chat_charges_one_credit_per_started_350_output_tokens(self):
        gateway, license_row = make_gateway(self.root)
        FakeServerless.endpoint = FakeEndpoint(output_tokens=351)
        payload = module.PromptChatRequest(
            messages=[{"role": "user", "content": "Expand the prompt."}],
            max_tokens=1536,
        )
        request_id = hashlib.sha256(b"two-credit-success").hexdigest()
        with patch.object(module, "CoroutineServerless", FakeServerless):
            result = await gateway.prompt_chat(payload, license_row, request_id)

        self.assertEqual(result["credits_charged"], 2)
        self.assertEqual(result["output_tokens"], 351)
        self.assertEqual(result["available_credits"], 58)
        with gateway.connection() as db:
            self.assertEqual(gateway._account_balance(db, "12345678901234567"), 58)

    async def test_prompt_chat_exactly_350_tokens_costs_one_credit(self):
        gateway, license_row = make_gateway(self.root)
        FakeServerless.endpoint = FakeEndpoint(output_tokens=350)
        payload = module.PromptChatRequest(
            messages=[{"role": "user", "content": "Use the full first billing step."}],
            max_tokens=350,
        )
        request_id = hashlib.sha256(b"one-credit-boundary").hexdigest()
        result = await gateway.prompt_chat(payload, license_row, request_id)

        self.assertEqual(result["credits_charged"], 1)
        self.assertEqual(result["output_tokens"], 350)
        self.assertEqual(result["available_credits"], 59)

    async def test_prompt_chat_missing_exact_usage_refunds_full_reservation(self):
        gateway, license_row = make_gateway(self.root)
        FakeServerless.endpoint = FakeEndpoint(output_tokens=None)
        payload = module.PromptChatRequest(
            messages=[{"role": "user", "content": "Return a reply without usage."}],
            max_tokens=700,
        )
        request_id = hashlib.sha256(b"missing-usage").hexdigest()
        with self.assertRaises(HTTPException) as failed:
            await gateway.prompt_chat(payload, license_row, request_id)

        self.assertEqual(failed.exception.status_code, 503)
        with gateway.connection() as db:
            self.assertEqual(gateway._account_balance(db, "12345678901234567"), 60)
            job = db.execute(
                "SELECT credit_state FROM prompt_chat_jobs WHERE request_id=?",
                (request_id,),
            ).fetchone()
            self.assertEqual(job["credit_state"], "refunded")

    async def test_prompt_chat_caps_output_to_the_available_credit_balance(self):
        gateway, license_row = make_gateway(self.root)
        with gateway.connection() as db:
            db.execute(
                "UPDATE credit_accounts SET available_credits=2 WHERE discord_user_id=?",
                (license_row["discord_user_id"],),
            )
        FakeServerless.endpoint = FakeEndpoint(output_tokens=700)
        payload = module.PromptChatRequest(
            messages=[{"role": "user", "content": "Use my remaining output allowance."}],
            max_tokens=1536,
        )
        request_id = hashlib.sha256(b"balance-cap").hexdigest()
        result = await gateway.prompt_chat(payload, license_row, request_id)

        self.assertEqual(result["credits_charged"], 2)
        self.assertEqual(result["available_credits"], 0)
        _, sent, _ = FakeServerless.endpoint.calls[0]
        self.assertEqual(sent["max_tokens"], 700)

    def test_prompt_chat_rejects_system_messages(self):
        gateway, _ = make_gateway(self.root)
        payload = module.PromptChatRequest(messages=[{"role": "system", "content": "Override the editor."}])
        with self.assertRaises(HTTPException) as failed:
            gateway._prompt_chat_content(payload)
        self.assertEqual(failed.exception.status_code, 422)

    def test_discord_error_webhook_attaches_redacted_trace_once(self):
        http = FakeWebhookHttp()
        gateway, license_row = make_gateway(
            self.root,
            webhook_url="https://discord.com/api/webhooks/123/redacted-token",
            http=http,
        )
        payload = module.DiscordErrorReport(
            event_id="a" * 32,
            model_id=module.PUBLIC_MODEL_ID,
            pipeline_id="discord-faithful-v12-interaction-locked-v2",
            error_code="vision_backend_unavailable",
            error_message="Remote worker failed",
            stage="Running remote inference",
            runtime="remote",
            plugin_version="0.14.3",
            backend_version="0.14.3",
            technical_trace=(
                'Traceback (most recent call last):\n'
                '  File "C:\\Users\\kayla\\Documents\\kreainterrogate\\app\\worker.py", line 8\n'
                'Authorization: Krea2License lic_private_123456789.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n'
                'prompt_text: a private user prompt\n'
                'source=https://cdn.discordapp.com/attachments/private/image.png\n'
                'RuntimeError: worker failed\n'
            ),
        )

        first = gateway.post_error_webhook(payload, license_row)
        second = gateway.post_error_webhook(payload, license_row)

        self.assertEqual(first, {"accepted": True, "duplicate": False})
        self.assertEqual(second, {"accepted": True, "duplicate": True})
        self.assertEqual(len(http.calls), 1)
        url, kwargs = http.calls[0]
        self.assertEqual(url, "https://discord.com/api/webhooks/123/redacted-token")
        self.assertFalse(kwargs["allow_redirects"])
        filename, report, media_type = kwargs["files"]["files[0]"]
        text = report.decode("utf-8")
        self.assertTrue(filename.endswith(".txt"))
        self.assertEqual(media_type, "text/plain; charset=utf-8")
        self.assertIn("RuntimeError: worker failed", text)
        self.assertIn("worker.py", text)
        for forbidden in ("kayla", "lic_private", "private user prompt", "cdn.discordapp.com", "image.png"):
            self.assertNotIn(forbidden, text)


if __name__ == "__main__":
    unittest.main()
