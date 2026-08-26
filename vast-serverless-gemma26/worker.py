from __future__ import annotations

import os

from vastai import BenchmarkConfig, HandlerConfig, LogActionConfig, Worker, WorkerConfig


MODEL_ALIAS = "gemma4-26b-a4b-heretic-q3-k-l"


def benchmark_payload() -> dict:
    return {
        "model": MODEL_ALIAS,
        "messages": [
            {"role": "system", "content": "Return concise valid JSON."},
            {"role": "user", "content": "Return exactly {\"ready\":true}."},
        ],
        "temperature": 0.0,
        "max_tokens": 32,
        "stream": False,
        "response_format": {"type": "json_object"},
    }


def workload(payload: dict) -> float:
    try:
        return max(1.0, min(16384.0, float(payload.get("max_tokens", 100))))
    except (TypeError, ValueError):
        return 100.0


config = WorkerConfig(
    model_server_url="http://127.0.0.1",
    model_server_port=18000,
    # Read only the tiny ephemeral lifecycle-event stream. The llama.cpp log is
    # intentionally not used here because it may contain request-adjacent
    # diagnostics and because /dev/null can never deliver the READY marker.
    model_log_file=os.environ.get("KREA2_EVENT_LOG", "/tmp/krea2-worker-events.log"),
    model_healthcheck_url="/health",
    handlers=[
        HandlerConfig(
            route="/v1/chat/completions",
            allow_parallel_requests=False,
            max_queue_time=300.0,
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
        on_load=["KREA2_MODEL_READY"],
        on_error=["KREA2_MODEL_ERROR"],
        on_info=["KREA2_MODEL_DOWNLOAD"],
    ),
    max_sessions=1,
)


if __name__ == "__main__":
    Worker(config).run()
