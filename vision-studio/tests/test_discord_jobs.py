from __future__ import annotations

import json
import os
import tempfile
import time
import unittest
from pathlib import Path

from app.services.discord_jobs import DiscordVisionJobStore
from app.services.shared_queue import SharedGenerationQueue


HASH = "a" * 64
PROMPT = " ".join(["visible"] * 400)
PROMPT_VARIANTS = [PROMPT, " ".join(["subject"] * 400), " ".join(["scene"] * 400)]


class DiscordVisionJobStoreTests(unittest.TestCase):
    def test_completed_jobs_accept_one_or_three_prompts_but_never_two(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = DiscordVisionJobStore(Path(temporary), terminal_limit=20)
            single_id = store.create(HASH, "single.png", model="v2")
            store.complete(
                single_id,
                prompt=PROMPT,
                prompt_variants=[PROMPT],
                model="v2",
                prompt_words=400,
            )
            self.assertEqual(store.get(single_id)["prompt_count"], 1)

            rejected_id = store.create("b" * 64, "two.png", model="v2")
            with self.assertRaisesRegex(ValueError, "one prompt or exactly three"):
                store.complete(
                    rejected_id,
                    prompt=PROMPT,
                    prompt_variants=PROMPT_VARIANTS[:2],
                    model="v2",
                    prompt_words=400,
                )
            store.close()

    def test_wrapped_model_transport_is_cleaned_on_save_and_legacy_read(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = DiscordVisionJobStore(Path(temporary), terminal_limit=20)
            job_id = store.create(HASH, "wrapped.png", model="test")
            wrapped = (
                "<|channel>thought <channel|>```json\n"
                + json.dumps({"prompt": PROMPT})
                + "\n```"
            )
            store.complete(job_id, prompt=wrapped, model="test", prompt_words=404)
            with store.session() as db:
                saved = db.execute(
                    "SELECT prompt,prompt_words FROM discord_vision_jobs WHERE id=?",
                    (job_id,),
                ).fetchone()
                self.assertEqual(saved["prompt"], PROMPT)
                self.assertEqual(saved["prompt_words"], 400)
                db.execute(
                    "UPDATE discord_vision_jobs SET prompt=?,prompt_words=404 WHERE id=?",
                    (wrapped, job_id),
                )

            listing = store.list()
            detail = store.get(job_id)
            self.assertEqual(detail["prompt"], PROMPT)
            self.assertEqual(detail["prompt_words"], 400)
            self.assertNotIn("channel", listing[0]["prompt_preview"])
            self.assertNotIn("```", listing[0]["prompt_preview"])
            store.close()

    def test_lifecycle_persists_only_safe_local_job_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = DiscordVisionJobStore(Path(temporary), terminal_limit=20)
            job_id = store.create(
                HASH,
                r"C:\private\folder\image.png",
                model="llamacpp::heretic-8b-q8_0",
            )
            self.assertEqual(store.get(job_id)["model"], "llamacpp::heretic-8b-q8_0")
            store.update(job_id, status="queued", stage="Waiting for shared GPU queue", queue_ahead=2)
            store.update(job_id, status="running", stage="Pass 1 of 3")
            store.complete(
                job_id,
                prompt=PROMPT,
                prompt_variants=PROMPT_VARIANTS,
                model="vision -> composer",
                prompt_words=400,
            )
            store.set_reproducibility(job_id, {
                "schema_version": 1,
                "model_id": "llamacpp::heretic-8b-q8_0",
                "model_sha256": "b" * 64,
            })

            summary = store.summary()
            listing = store.list()
            detail = store.get(job_id)

            self.assertEqual(summary["completed_24h"], 1)
            self.assertEqual(listing[0]["status"], "completed")
            self.assertNotIn("prompt", listing[0])
            self.assertNotIn("prompt_variants", listing[0])
            self.assertEqual(listing[0]["prompt_count"],3)
            self.assertEqual(detail["prompt"], PROMPT)
            self.assertEqual(detail["prompt_variants"],PROMPT_VARIANTS)
            self.assertEqual(detail["filename"], "image.png")
            self.assertGreaterEqual(detail["duration_seconds"], 0)
            self.assertTrue(detail["has_reproducibility"])
            self.assertEqual(detail["reproducibility"]["model_sha256"], "b" * 64)
            serialized = json.dumps({"list": listing, "detail": detail})
            for forbidden in (
                "C:\\private",
                "X-Krea2-Vision-Token",
                "handoff_nonce",
                "ticket_name",
                "base64",
                "raw_subject",
                "thread_id",
            ):
                self.assertNotIn(forbidden, serialized)
            self.assertEqual(
                store.path,
                Path(temporary) / "data" / "history" / "discord_vision_jobs.sqlite3",
            )
            self.assertTrue(store.path.is_file())
            store.close()

    def test_terminal_history_survives_restart_until_clear_and_active_work_is_bounded(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = DiscordVisionJobStore(root, terminal_limit=10, max_active=2)
            for index in range(13):
                job_id = store.create(f"{index:064x}", f"{index}.png")
                store.complete(job_id, prompt=PROMPT, model="test", prompt_words=400)
            self.assertEqual(len(store.list(100)), 13)

            first = store.create("d" * 64, "first.png")
            second = store.create("e" * 64, "second.png")
            store.update(second, status="running", stage="Composer")
            with self.assertRaisesRegex(RuntimeError, "active-job limit"):
                store.create("f" * 64, "third.png")

            restarted = DiscordVisionJobStore(root, terminal_limit=20, max_active=2)
            self.assertEqual(restarted.get(first)["status"], "queued")
            self.assertEqual(restarted.get(second)["status"], "running")
            self.assertEqual(restarted.recover_active_after_restart(), 2)
            self.assertEqual(restarted.get(first)["status"], "error")
            self.assertEqual(restarted.get(second)["status"], "error")
            self.assertIn("restarted", restarted.get(first)["public_error"].lower())
            self.assertEqual(restarted.summary()["queued"], 0)
            self.assertEqual(restarted.summary()["total"], 15)
            self.assertTrue(restarted.path.is_file())
            store.close()
            restarted.close()

    def test_paginated_history_filters_and_searches_all_saved_jobs(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = DiscordVisionJobStore(Path(temporary), max_active=4)
            for index in range(27):
                job_id = store.create(
                    f"{index:064x}",
                    f"winter-{index}.png" if index == 3 else f"image-{index}.png",
                    model="model-a" if index % 2 else "model-b",
                    created=1_000 + index,
                )
                if index % 5 == 0:
                    store.update(job_id, status="error", public_error="test failure")
                else:
                    store.complete(job_id, prompt=PROMPT, model="model-a" if index % 2 else "model-b", prompt_words=400)

            first = store.list_page(page=1, page_size=10)
            third = store.list_page(page=3, page_size=10)
            errors = store.list_page(page=1, page_size=10, view="errors")
            searched = store.list_page(page=1, page_size=10, query="winter-3")
            model_a = store.list_page(page=1, page_size=100, model="model-a")

            self.assertEqual(first["pagination"]["total_items"], 27)
            self.assertEqual(first["pagination"]["total_pages"], 3)
            self.assertTrue(first["pagination"]["has_next"])
            self.assertEqual(len(third["jobs"]), 7)
            self.assertEqual(errors["pagination"]["total_items"], 6)
            self.assertEqual(searched["pagination"]["total_items"], 1)
            self.assertEqual(searched["jobs"][0]["filename"], "winter-3.png")
            self.assertEqual(model_a["pagination"]["total_items"], 13)
            store.close()

    def test_client_job_ids_cooperative_cancel_and_clear_terminal(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = DiscordVisionJobStore(Path(temporary), terminal_limit=20)
            job_id = "1" * 32
            self.assertEqual(
                store.create(HASH, "queued.png", model="model-a", job_id=job_id),
                job_id,
            )
            self.assertEqual(store.get(job_id)["requested_model"], "model-a")
            self.assertTrue(store.request_cancel(job_id))
            self.assertTrue(store.is_cancel_requested(job_id))
            self.assertTrue(store.cancel(job_id))
            self.assertEqual(store.get(job_id)["status"], "cancelled")
            store.complete(job_id, prompt=PROMPT, model="should-not-win", prompt_words=400)
            self.assertEqual(store.get(job_id)["status"], "cancelled")
            self.assertEqual(store.summary()["cancelled"], 1)
            self.assertEqual(store.clear_terminal(), 1)
            self.assertIsNone(store.get(job_id))

            with self.assertRaisesRegex(ValueError, "32 lowercase hexadecimal"):
                store.create(HASH, "bad.png", job_id="not-a-job-id")
            store.close()


class SharedQueueDashboardTests(unittest.TestCase):
    def test_status_is_read_only_and_never_exposes_ticket_secrets(self):
        with tempfile.TemporaryDirectory() as temporary:
            queue_dir = Path(temporary)
            created = time.time() - 4
            payloads = [
                ("babegen-prompt-assistant-krea2-vision-7870", "secret-one"),
                ("kreaforge-7862", "secret-two"),
            ]
            original = {}
            for index, (instance, nonce) in enumerate(payloads):
                ticket = queue_dir / f"{index:02d}_{os.getpid()}_1_x_{instance}.ticket"
                content = json.dumps({
                    "instance": instance,
                    "pid": os.getpid(),
                    "thread": 12345,
                    "created": created + index,
                    "handoff_nonce": nonce,
                })
                ticket.write_text(content, encoding="utf-8")
                original[ticket] = content

            queue = SharedGenerationQueue("dashboard", True, str(queue_dir), 0.05, 21600)
            status = queue.status()

            self.assertEqual(status["count"], 2)
            self.assertEqual(status["entries"][0]["worker"], "Discord KREA2 Vision")
            self.assertEqual(status["entries"][1]["worker"], "Krea Forge 7862")
            serialized = json.dumps(status)
            self.assertNotIn("secret-one", serialized)
            self.assertNotIn("secret-two", serialized)
            self.assertNotIn(str(os.getpid()), serialized)
            self.assertNotIn("thread", serialized)
            for ticket, content in original.items():
                self.assertEqual(ticket.read_text(encoding="utf-8"), content)

    def test_cancel_check_removes_own_waiting_ticket_without_reordering_others(self):
        with tempfile.TemporaryDirectory() as temporary:
            queue_dir = Path(temporary)
            blocker = queue_dir / f"00_{os.getpid()}_1_x_kreaforge-7861.ticket"
            blocker.write_text(json.dumps({
                "instance": "kreaforge-7861",
                "pid": os.getpid(),
                "created": time.time(),
            }), encoding="utf-8")
            queue = SharedGenerationQueue("discord", True, str(queue_dir), 0.05, 21600)
            checks = 0

            def cancelled():
                nonlocal checks
                checks += 1
                if checks > 1:
                    raise RuntimeError("cancelled")

            with self.assertRaisesRegex(RuntimeError, "cancelled"):
                with queue.slot(cancel_check=cancelled):
                    self.fail("cancelled waiter must not acquire the shared FIFO")
            self.assertEqual([item.name for item in queue_dir.glob("*.ticket")], [blocker.name])


class DashboardAssetTests(unittest.TestCase):
    def test_hidden_detail_states_cannot_be_overridden_by_component_layout(self):
        css = (
            Path(__file__).resolve().parents[1]
            / "app"
            / "static"
            / "discord_jobs.css"
        ).read_text(encoding="utf-8")
        self.assertIn("[hidden] { display: none !important; }", css)


if __name__ == "__main__":
    unittest.main()
