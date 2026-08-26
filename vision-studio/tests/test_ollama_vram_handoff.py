from __future__ import annotations

import unittest
from unittest.mock import Mock

import requests

from app.services.ollama_vram_handoff import OllamaHandoffError, OllamaVramHandoff
from app.services.shared_queue import QueueLease


class OllamaVramHandoffTests(unittest.TestCase):
    def test_unloads_each_resident_runner_without_deleting_models(self):
        http = Mock()
        listing = Mock()
        listing.raise_for_status.return_value = None
        listing.json.return_value = {
            "models": [{"name": "qwen3-vl:8b"}, {"model": "composer:latest"}]
        }
        unloaded = Mock()
        unloaded.raise_for_status.return_value = None
        http.get.return_value = listing
        http.post.return_value = unloaded
        handoff = OllamaVramHandoff("http://127.0.0.1:11434", http=http)
        result = handoff.unload_models(QueueLease("vision.ticket", "n" * 43))
        self.assertEqual(result["unloaded"], ["qwen3-vl:8b", "composer:latest"])
        self.assertEqual(http.post.call_count, 2)
        for call in http.post.call_args_list:
            self.assertEqual(call.kwargs["json"]["keep_alive"], 0)
            self.assertEqual(call.kwargs["json"]["prompt"], "")
            self.assertNotIn("delete", call.args[0])

    def test_requires_queue_lease_and_literal_loopback(self):
        with self.assertRaisesRegex(OllamaHandoffError, "literal loopback"):
            OllamaVramHandoff("http://localhost:11434")
        with self.assertRaisesRegex(OllamaHandoffError, "queue lease"):
            OllamaVramHandoff("http://127.0.0.1:11434", http=Mock()).unload_models(None)

    def test_exact_loopback_connection_refused_is_treated_as_offline(self):
        http = Mock()
        http.get.side_effect = requests.ConnectionError(
            OSError(10061, "No connection could be made because the target machine refused it")
        )
        result = OllamaVramHandoff("http://127.0.0.1:11434", http=http).unload_models(
            QueueLease("vision.ticket", "n" * 43)
        )
        self.assertTrue(result["offline"])


if __name__ == "__main__":
    unittest.main()
