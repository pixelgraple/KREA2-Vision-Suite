#!/usr/bin/env bash
set -euo pipefail

export WORKER_PORT="${WORKER_PORT:-3000}"
export WORKER_HTTP_PORT="${WORKER_HTTP_PORT:-3001}"
export USE_SSL="${USE_SSL:-false}"

MODEL_DIR="${QWEN38_MODEL_DIR:-/workspace/qwen38-models/rvn-q4-k-m-multilingual}"
LOG_DIR="/var/log/qwen38"
export QWEN38_EVENT_LOG="${QWEN38_EVENT_LOG:-/tmp/qwen38-worker-events.log}"

MODEL_NAME="RVN-Q4_K_M-multilingual.gguf"
MMPROJ_NAME="mmproj-Qwen3.8-27B-Q8_0.gguf"
MODEL_PATH="$MODEL_DIR/$MODEL_NAME"
MMPROJ_PATH="$MODEL_DIR/$MMPROJ_NAME"

HF_REPO="0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF"
HF_REVISION="20b94f0613b632b4848bbe3b1e05d9ee0c2b1608"
MODEL_URL="https://huggingface.co/${HF_REPO}/resolve/${HF_REVISION}/${MODEL_NAME}?download=true"
MMPROJ_URL="https://huggingface.co/${HF_REPO}/resolve/${HF_REVISION}/${MMPROJ_NAME}?download=true"

MODEL_BYTES=16547400224
MMPROJ_BYTES=629247008
MODEL_SHA256="9ed40ccc8b8432f38b9a85d0ca67928167f5719e8c10bd299e56d34facaf6e61"
MMPROJ_SHA256="2e968a6af97ce35d8971890b257b9b7edabf20ad91450501fa53162a19ee33eb"
DOWNLOAD_RESERVE_BYTES=8589934592
MODEL_ALIAS="qwen38-27b-heretic-q4-k-m"

mkdir -p "$MODEL_DIR" "$LOG_DIR"
: > "$LOG_DIR/llama-server.log"
: > "$QWEN38_EVENT_LOG"

emit_event() {
  printf '%s\n' "$*" >> "$QWEN38_EVENT_LOG"
  printf '%s\n' "$*" >> "$LOG_DIR/llama-server.log"
}

tail -n 0 -F "$LOG_DIR/llama-server.log" &
LOG_TAIL_PID=$!
LLAMA_PID=""
PYWORKER_PID=""

terminate() {
  if [[ -n "$PYWORKER_PID" ]]; then
    kill "$PYWORKER_PID" 2>/dev/null || true
    wait "$PYWORKER_PID" 2>/dev/null || true
  fi
  if [[ -n "$LLAMA_PID" ]]; then
    kill "$LLAMA_PID" 2>/dev/null || true
    wait "$LLAMA_PID" 2>/dev/null || true
  fi
  kill "$LOG_TAIL_PID" 2>/dev/null || true
  wait "$LOG_TAIL_PID" 2>/dev/null || true
}
trap terminate EXIT INT TERM

verify_file() {
  local path="$1" expected_bytes="$2" expected_sha="$3"
  [[ -f "$path" ]] || return 1
  [[ "$(stat -c %s "$path")" == "$expected_bytes" ]] || return 1
  [[ "$(sha256sum "$path" | awk '{print $1}')" == "$expected_sha" ]]
}

require_download_space() {
  local expected_bytes="$1" free_kib free_bytes required_bytes
  free_kib="$(df -Pk "$MODEL_DIR" | awk 'NR == 2 {print $4}')"
  [[ "$free_kib" =~ ^[0-9]+$ ]] || {
    emit_event "QWEN38_MODEL_ERROR unable to determine free model-cache space"
    exit 1
  }
  free_bytes=$((free_kib * 1024))
  required_bytes=$((expected_bytes + DOWNLOAD_RESERVE_BYTES))
  if (( free_bytes < required_bytes )); then
    emit_event "QWEN38_MODEL_ERROR insufficient disk: ${free_bytes} bytes free; ${required_bytes} required"
    exit 1
  fi
}

download_verified() {
  local path="$1" url="$2" expected_bytes="$3" expected_sha="$4"
  local partial_bytes remaining_bytes download_timeout_seconds
  if verify_file "$path" "$expected_bytes" "$expected_sha"; then
    return 0
  fi
  rm -f -- "$path"
  partial_bytes=0
  if [[ -f "$path.part" ]]; then
    partial_bytes="$(stat -c %s "$path.part")"
    if [[ ! "$partial_bytes" =~ ^[0-9]+$ ]] || (( partial_bytes > expected_bytes )); then
      rm -f -- "$path.part"
      partial_bytes=0
    fi
  fi
  remaining_bytes=$((expected_bytes - partial_bytes))
  require_download_space "$remaining_bytes"
  emit_event "QWEN38_MODEL_DOWNLOAD $(basename "$path")"
  download_timeout_seconds="${QWEN38_DOWNLOAD_TIMEOUT_SECONDS:-1800}"
  [[ "$download_timeout_seconds" =~ ^[1-9][0-9]*$ ]] || {
    emit_event "QWEN38_MODEL_ERROR invalid download timeout"
    exit 1
  }
  if ! timeout --signal=TERM "$download_timeout_seconds" aria2c \
      --allow-overwrite=true \
      --auto-file-renaming=false \
      --continue=true \
      --connect-timeout=30 \
      --file-allocation=none \
      --lowest-speed-limit=64K \
      --max-connection-per-server=16 \
      --max-tries=20 \
      --min-split-size=16M \
      --retry-wait=5 \
      --split=16 \
      --summary-interval=15 \
      --timeout=60 \
      --dir "$(dirname "$path.part")" \
      --out "$(basename "$path.part")" \
      "$url"; then
    emit_event "QWEN38_MODEL_ERROR artifact download failed or timed out: $(basename "$path")"
    exit 1
  fi
  verify_file "$path.part" "$expected_bytes" "$expected_sha" || {
    emit_event "QWEN38_MODEL_ERROR artifact verification failed: $(basename "$path")"
    exit 1
  }
  mv -- "$path.part" "$path"
}

download_verified "$MODEL_PATH" "$MODEL_URL" "$MODEL_BYTES" "$MODEL_SHA256"
download_verified "$MMPROJ_PATH" "$MMPROJ_URL" "$MMPROJ_BYTES" "$MMPROJ_SHA256"

LLAMA_SERVER_LIB="$(find /app /usr/local/lib /usr/local/lib64 \
  -name 'libllama-server-impl.so' -type f -print -quit 2>/dev/null || true)"
if [[ -z "$LLAMA_SERVER_LIB" ]]; then
  emit_event "QWEN38_MODEL_ERROR libllama-server-impl.so was not found in the llama.cpp image"
  exit 1
fi
export LD_LIBRARY_PATH="$(dirname "$LLAMA_SERVER_LIB")${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

/app/llama-server \
  --model "$MODEL_PATH" \
  --mmproj "$MMPROJ_PATH" \
  --alias "$MODEL_ALIAS" \
  --host 127.0.0.1 \
  --port 18000 \
  --ctx-size 32768 \
  --batch-size 2048 \
  --ubatch-size 512 \
  --parallel 1 \
  --flash-attn on \
  --cache-type-k q8_0 \
  --cache-type-v q8_0 \
  --cache-ram 0 \
  --image-max-tokens 2048 \
  --n-gpu-layers all \
  --mmproj-offload \
  --jinja \
  >> "$LOG_DIR/llama-server.log" 2>&1 &
LLAMA_PID=$!

python3 /opt/qwen38/worker.py &
PYWORKER_PID=$!

fail_worker() {
  emit_event "QWEN38_MODEL_ERROR $*"
  if [[ -n "$PYWORKER_PID" ]]; then
    kill "$PYWORKER_PID" 2>/dev/null || true
    wait "$PYWORKER_PID" 2>/dev/null || true
    PYWORKER_PID=""
  fi
  exit 1
}

startup_timeout_seconds="${QWEN38_STARTUP_TIMEOUT_SECONDS:-1200}"
[[ "$startup_timeout_seconds" =~ ^[1-9][0-9]*$ ]] || fail_worker "invalid startup timeout"
health_ready=false
for _ in $(seq 1 "$startup_timeout_seconds"); do
  kill -0 "$LLAMA_PID" 2>/dev/null || fail_worker "llama-server exited during startup"
  kill -0 "$PYWORKER_PID" 2>/dev/null || fail_worker "Vast PyWorker exited during startup"
  if curl --fail --silent --max-time 2 http://127.0.0.1:18000/health >/dev/null; then
    health_ready=true
    break
  fi
  sleep 1
done
[[ "$health_ready" == true ]] || fail_worker "llama-server startup timed out"

self_test_ready=false
for _ in 1 2 3; do
  if curl --fail --silent --max-time 180 \
      -H 'Content-Type: application/json' \
      -d '{"model":"qwen38-27b-heretic-q4-k-m","messages":[{"role":"user","content":"Return exactly ready."}],"chat_template_kwargs":{"enable_thinking":false},"temperature":0,"max_tokens":16,"stream":false}' \
      http://127.0.0.1:18000/v1/chat/completions \
      -o /tmp/qwen38-startup-self-test.json \
    && python3 -c 'import json; d=json.load(open("/tmp/qwen38-startup-self-test.json", encoding="utf-8")); assert d["choices"][0]["message"]["content"].strip()'; then
    self_test_ready=true
    break
  fi
  sleep 10
done
rm -f -- /tmp/qwen38-startup-self-test.json
[[ "$self_test_ready" == true ]] || fail_worker "model inference self-test failed"
emit_event "QWEN38_MODEL_READY"

health_failure_limit="${QWEN38_HEALTH_FAILURE_LIMIT:-6}"
[[ "$health_failure_limit" =~ ^[1-9][0-9]*$ ]] || fail_worker "invalid health failure limit"
health_failures=0
while kill -0 "$PYWORKER_PID" 2>/dev/null; do
  kill -0 "$LLAMA_PID" 2>/dev/null || fail_worker "llama-server exited after readiness"
  if curl --fail --silent --max-time 2 http://127.0.0.1:18000/health >/dev/null; then
    health_failures=0
  else
    health_failures=$((health_failures + 1))
    if (( health_failures >= health_failure_limit )); then
      fail_worker "llama-server failed repeated health checks"
    fi
  fi
  sleep 5
done

if wait "$PYWORKER_PID"; then
  worker_status=0
else
  worker_status=$?
fi
PYWORKER_PID=""
if (( worker_status != 0 )); then
  emit_event "QWEN38_MODEL_ERROR Vast PyWorker exited with status $worker_status"
fi
exit "$worker_status"

