from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent


class WorkerReadinessContractTests(unittest.TestCase):
    def test_worker_reads_ephemeral_event_stream_instead_of_dev_null(self) -> None:
        source = (ROOT / "worker.py").read_text(encoding="utf-8")
        self.assertIn(
            'os.environ.get("KREA2_EVENT_LOG", "/tmp/krea2-worker-events.log")',
            source,
        )
        self.assertNotIn('model_log_file="/dev/null"', source)

    def test_launcher_emits_ready_and_error_markers_to_event_stream(self) -> None:
        source = (ROOT / "start-worker.sh").read_text(encoding="utf-8")
        self.assertIn('export KREA2_EVENT_LOG=', source)
        self.assertIn(': > "$KREA2_EVENT_LOG"', source)
        self.assertIn('emit_event "KREA2_MODEL_READY"', source)
        self.assertIn('emit_event "KREA2_MODEL_ERROR', source)
        self.assertIn('printf \'%s\\n\' "$*" >> "$KREA2_EVENT_LOG"', source)


if __name__ == "__main__":
    unittest.main()
