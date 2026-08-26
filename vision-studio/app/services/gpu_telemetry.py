from __future__ import annotations

import json
import math
import os
import re
import subprocess
import threading
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable


PUBLIC_MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,159}$")


class GpuTelemetryError(RuntimeError):
    pass


def _finite_number(value) -> bool:
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


@dataclass(frozen=True, slots=True)
class GpuMemory:
    total_mb: int
    used_mb: int
    free_mb: int
    captured_at: float


@dataclass(frozen=True, slots=True)
class PeakMeasurement:
    samples: int
    total_mb: int
    baseline_used_mb: int
    peak_used_mb: int
    peak_delta_mb: int
    minimum_free_mb: int
    measured_at: float


def query_gpu_memory(
    executable: str = "nvidia-smi",
    *,
    gpu_index: int = 0,
    timeout: float = 5.0,
    runner: Callable = subprocess.run,
    clock: Callable[[], float] = time.time,
) -> GpuMemory:
    """Return one numeric GPU memory snapshot without invoking a shell."""

    if not 0 <= int(gpu_index) <= 64:
        raise GpuTelemetryError("The GPU index is invalid.")
    command = [
        executable,
        f"--id={int(gpu_index)}",
        "--query-gpu=memory.total,memory.used,memory.free",
        "--format=csv,noheader,nounits",
    ]
    try:
        completed = runner(
            command,
            capture_output=True,
            text=True,
            timeout=max(1.0, float(timeout)),
            check=False,
            shell=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
        )
        if int(completed.returncode) != 0:
            raise ValueError("nvidia-smi failed")
        row = next(line.strip() for line in completed.stdout.splitlines() if line.strip())
        values = [int(item.strip()) for item in row.split(",")]
        if len(values) != 3:
            raise ValueError("unexpected field count")
        total, used, free = values
        if total <= 0 or used < 0 or free < 0 or used > total + 256 or free > total + 256:
            raise ValueError("invalid memory values")
        return GpuMemory(total, used, free, float(clock()))
    except (OSError, subprocess.SubprocessError, StopIteration, ValueError, TypeError) as exc:
        raise GpuTelemetryError("GPU memory telemetry is unavailable.") from exc


class PeakMemoryPoller:
    """Observe global VRAM while a serialized local-GPU queue lease is held."""

    def __init__(
        self,
        sample: Callable[[], GpuMemory] = query_gpu_memory,
        interval: float = 0.25,
        *,
        clock: Callable[[], float] = time.time,
    ):
        self.sample = sample
        self.interval = max(0.05, float(interval))
        self.clock = clock
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._samples = 0
        self._total_mb = 0
        self._baseline_used_mb = 0
        self._peak_used_mb = 0
        self._minimum_free_mb = 0
        self._final: PeakMeasurement | None = None

    def observe(self, memory: GpuMemory) -> None:
        with self._lock:
            if self._samples == 0:
                self._total_mb = memory.total_mb
                self._baseline_used_mb = memory.used_mb
                self._peak_used_mb = memory.used_mb
                self._minimum_free_mb = memory.free_mb
            else:
                self._total_mb = max(self._total_mb, memory.total_mb)
                self._peak_used_mb = max(self._peak_used_mb, memory.used_mb)
                self._minimum_free_mb = min(self._minimum_free_mb, memory.free_mb)
            self._samples += 1

    def _sample_once(self) -> None:
        try:
            self.observe(self.sample())
        except GpuTelemetryError:
            pass

    def _poll(self) -> None:
        while not self._stop.wait(self.interval):
            self._sample_once()

    def start(self):
        if self._thread is not None:
            return self
        self._sample_once()
        self._thread = threading.Thread(target=self._poll, name="gpu-peak-poller", daemon=True)
        self._thread.start()
        return self

    def measurement(self) -> PeakMeasurement:
        with self._lock:
            return PeakMeasurement(
                samples=self._samples,
                total_mb=self._total_mb,
                baseline_used_mb=self._baseline_used_mb,
                peak_used_mb=self._peak_used_mb,
                peak_delta_mb=max(0, self._peak_used_mb - self._baseline_used_mb),
                minimum_free_mb=self._minimum_free_mb,
                measured_at=float(self.clock()),
            )

    def stop(self) -> PeakMeasurement:
        if self._final is not None:
            return self._final
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=max(1.0, self.interval * 4))
        self._sample_once()
        self._final = self.measurement()
        return self._final

    def __enter__(self):
        return self.start()

    def __exit__(self, *_):
        self.stop()


class MeasuredPeakStore:
    """Bounded, atomic, path-free history keyed only by public model ID."""

    def __init__(self, path: str | Path, max_entries: int = 32):
        self.path = Path(path)
        self.max_entries = min(256, max(1, int(max_entries)))
        self._lock = threading.Lock()

    @staticmethod
    def _model_id(value: str) -> str:
        candidate = str(value)
        if not PUBLIC_MODEL_ID.fullmatch(candidate):
            raise GpuTelemetryError("The public model ID is invalid.")
        return candidate

    def _load(self) -> dict[str, dict]:
        try:
            if not self.path.exists() or self.path.stat().st_size > 1_000_000:
                return {}
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            return {}
        models = payload.get("models", {}) if isinstance(payload, dict) else {}
        if not isinstance(models, dict):
            return {}
        clean: dict[str, dict] = {}
        for model_id, record in models.items():
            if not isinstance(model_id, str) or not PUBLIC_MODEL_ID.fullmatch(model_id):
                continue
            if not isinstance(record, dict):
                continue
            numeric = {
                key: record.get(key)
                for key in (
                    "samples",
                    "total_mb",
                    "baseline_used_mb",
                    "peak_used_mb",
                    "peak_delta_mb",
                    "minimum_free_mb",
                    "measured_at",
                )
            }
            # Version-1 records were all collected with the original 8192
            # context cap. Keep those measurements useful while preventing a
            # peak from a different runtime context from blocking admission.
            numeric["context_length"] = record.get("context_length", 8192)
            if all(_finite_number(value) for value in numeric.values()):
                clean[model_id] = numeric
        return clean

    def _write(self, models: dict[str, dict]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f"{self.path.name}.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("w", encoding="utf-8", newline="\n") as handle:
                json.dump({"version": 2, "models": models}, handle, ensure_ascii=False, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        except OSError as exc:
            try:
                temporary.unlink()
            except OSError:
                pass
            raise GpuTelemetryError("Measured-peak telemetry could not be persisted.") from exc

    def record(
        self,
        model_id: str,
        measurement: PeakMeasurement,
        *,
        context_length: int = 8192,
    ) -> dict:
        public_id = self._model_id(model_id)
        record = asdict(measurement)
        record["context_length"] = max(512, int(context_length))
        if not all(_finite_number(value) for value in record.values()):
            raise GpuTelemetryError("The measured-peak telemetry is invalid.")
        nonnegative = (
            "samples",
            "total_mb",
            "baseline_used_mb",
            "peak_used_mb",
            "peak_delta_mb",
            "minimum_free_mb",
            "measured_at",
            "context_length",
        )
        if any(record[key] < 0 for key in nonnegative):
            raise GpuTelemetryError("The measured-peak telemetry is invalid.")
        with self._lock:
            models = self._load()
            models[public_id] = record
            ordered = sorted(models.items(), key=lambda item: float(item[1]["measured_at"]), reverse=True)
            bounded = dict(ordered[: self.max_entries])
            self._write(bounded)
        return dict(record)

    def get(self, model_id: str, *, context_length: int | None = None) -> dict | None:
        public_id = self._model_id(model_id)
        with self._lock:
            record = self._load().get(public_id)
        if (
            record is not None
            and context_length is not None
            and int(record.get("context_length") or 8192) != max(512, int(context_length))
        ):
            return None
        return dict(record) if record is not None else None

    def snapshot(self) -> dict[str, dict]:
        with self._lock:
            return {key: dict(value) for key, value in self._load().items()}
