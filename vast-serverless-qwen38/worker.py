from __future__ import annotations

import os
from typing import Any

from vastai import BenchmarkConfig, HandlerConfig, LogActionConfig, Worker, WorkerConfig


MODEL_ALIAS = "qwen38-27b-heretic-q4-k-m"


def benchmark_payload() -> dict[str, Any]:
    return {
        "model": MODEL_ALIAS,
        "messages": [
            {"role": "system", "content": "Return concise valid JSON."},
            {"role": "user", "content": 'Return exactly {"ready":true}.'},
        ],
        "chat_template_kwargs": {"enable_thinking": False},
        "temperature": 0.0,
        "max_tokens": 32,
        "stream": False,
        "response_format": {"type": "json_object"},
    }


def workload(payload: dict[str, Any]) -> float:
    """Estimate prompt plus requested output tokens for Vast queue accounting."""
    try:
        prompt_chars = 0
        for message in payload.get("messages", []):
            content = message.get("content", "") if isinstance(message, dict) else ""
            if isinstance(content, str):
                prompt_chars += len(content)
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and isinstance(part.get("text"), str):
                        prompt_chars += len(part["text"])
        output_tokens = max(0.0, float(payload.get("max_tokens", 100)))
        return max(1.0, min(262144.0, (prompt_chars / 4.0) + output_tokens))
    except (TypeError, ValueError):
        return 100.0


config = WorkerConfig(
    model_server_url="http://127.0.0.1",
    model_server_port=18000,
    model_log_file=os.environ.get("QWEN38_EVENT_LOG", "/tmp/qwen38-worker-events.log"),
    model_healthcheck_url="/health",
    handlers=[
        HandlerConfig(
            route="/v1/chat/completions",
            allow_parallel_requests=False,
            max_queue_time=30.0,
            workload_calculator=workload,
            benchmark_config=BenchmarkConfig(
                generator=benchmark_payload,
                runs=1,
                concurrency=1,
                do_warmup=False,
            ),
        )
    ],
    log_action_config=LogActionConfig(
        on_load=["QWEN38_MODEL_READY"],
        on_error=["QWEN38_MODEL_ERROR"],
        on_info=["QWEN38_MODEL_DOWNLOAD"],
    ),
    max_sessions=1,
)


if __name__ == "__main__":
    Worker(config).run()

