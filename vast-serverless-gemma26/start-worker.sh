#!/usr/bin/env bash
set -euo pipefail

export WORKER_PORT="${WORKER_PORT:-3000}"
export WORKER_HTTP_PORT="${WORKER_HTTP_PORT:-3001}"
export USE_SSL="${USE_SSL:-false}"

MODEL_DIR="${KREA2_MODEL_DIR:-/workspace/krea2-models/gemma4-26b-a4b-heretic-q3-k-l}"
LOG_DIR="/var/log/krea2"
export KREA2_EVENT_LOG="${KREA2_EVENT_LOG:-/tmp/krea2-worker-events.log}"
MODEL_PATH="$MODEL_DIR/gemma-4-26B-A4B-it-uncensored-heretic-Q3_K_L.gguf"
MMPROJ_PATH="$MODEL_DIR/gemma-4-26B-A4B-it-mmproj-BF16.gguf"
MODEL_URL="https://huggingface.co/llmfan46/gemma-4-26B-A4B-it-uncensored-heretic-GGUF/resolve/ea0259bf66bcd33b5f3425eb223932abaa0f4f07/gemma-4-26B-A4B-it-uncensored-heretic-Q3_K_L.gguf?download=true"
MMPROJ_URL="https://huggingface.co/llmfan46/gemma-4-26B-A4B-it-uncensored-heretic-GGUF/resolve/ea0259bf66bcd33b5f3425eb223932abaa0f4f07/gemma-4-26B-A4B-it-mmproj-BF16.gguf?download=true"
MODEL_BYTES=13824487424
MMPROJ_BYTES=1194828000
DOWNLOAD_RESERVE_BYTES=6442450944
MODEL_SHA256="431a5dd46d69d996d5a682d44dadcdd87cad3834185cbaea4176484151974b92"
MMPROJ_SHA256="b3ee6c97d5a5bb1ae9eb93bf14c1d1b51a0179a45ac1076b195931814c759e1e"

mkdir -p "$MODEL_DIR" "$LOG_DIR"
: > "$LOG_DIR/llama-server.log"
: > "$KREA2_EVENT_LOG"

# The Vast SDK watches this ephemeral marker-only file to determine when the
# model can accept work. It never contains images, prompts, or model output.
emit_event() {
  printf '%s\n' "$*" >> "$KREA2_EVENT_LOG"
  printf '%s\n' "$*" >> "$LOG_DIR/llama-server.log"
}

# Forward the model server's own log to the Vast instance log so startup
# failures remain diagnosable even when the PyWorker never reaches readiness.
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
    emit_event "KREA2_MODEL_ERROR unable to determine free model-cache space"
    exit 1
  }
  free_bytes=$((free_kib * 1024))
  required_bytes=$((expected_bytes + DOWNLOAD_RESERVE_BYTES))
  if (( free_bytes < required_bytes )); then
    emit_event "KREA2_MODEL_ERROR insufficient disk: ${free_bytes} bytes free; ${required_bytes} required"
    exit 1
  fi
}

download_verified() {
  local path="$1" url="$2" expected_bytes="$3" expected_sha="$4" partial_bytes remaining_bytes
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
  emit_event "KREA2_MODEL_DOWNLOAD $(basename "$path")"
  local download_timeout_seconds="${KREA2_DOWNLOAD_TIMEOUT_SECONDS:-1200}"
  if [[ ! "$download_timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
    emit_event "KREA2_MODEL_ERROR invalid download timeout"
    exit 1
  fi
  if ! timeout --signal=TERM "$download_timeout_seconds" aria2c \
    --allow-overwrite=true \
    --auto-file-renaming=false \
    --continue=true \
    --connect-timeout=30 \
    --file-allocation=none \
    --lowest-speed-limit=1M \
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
    emit_event "KREA2_MODEL_ERROR artifact download failed or timed out: $(basename "$path")"
    exit 1
  fi
  if ! verify_file "$path.part" "$expected_bytes" "$expected_sha"; then
    emit_event "KREA2_MODEL_ERROR artifact verification failed: $(basename "$path")"
    exit 1
  fi
  mv -- "$path.part" "$path"
}

download_verified "$MODEL_PATH" "$MODEL_URL" "$MODEL_BYTES" "$MODEL_SHA256"
download_verified "$MMPROJ_PATH" "$MMPROJ_URL" "$MMPROJ_BYTES" "$MMPROJ_SHA256"

# llama.cpp's server image keeps its shared implementation libraries alongside
# the application rather than in the system linker path. Because this worker
# replaces the image's stock entrypoint, restore that runtime path explicitly.
LLAMA_SERVER_LIB="$(find /app /usr/local/lib /usr/local/lib64 \
  -name 'libllama-server-impl.so' -type f -print -quit 2>/dev/null || true)"
if [[ -z "$LLAMA_SERVER_LIB" ]]; then
  emit_event "KREA2_MODEL_ERROR libllama-server-impl.so was not found in the llama.cpp image"
  exit 1
fi
LLAMA_SERVER_LIB_DIR="$(dirname "$LLAMA_SERVER_LIB")"
export LD_LIBRARY_PATH="$LLAMA_SERVER_LIB_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
echo "KREA2_MODEL_RUNTIME library path ready: $LLAMA_SERVER_LIB_DIR" \
  >> "$LOG_DIR/llama-server.log"

/app/llama-server \
  --model "$MODEL_PATH" \
  --mmproj "$MMPROJ_PATH" \
  --alias gemma4-26b-a4b-heretic-q3-k-l \
  --host 127.0.0.1 \
  --port 18000 \
  --ctx-size 8192 \
  --batch-size 2048 \
  --ubatch-size 2048 \
  --parallel 1 \
  --flash-attn on \
  --cache-ram 0 \
  --image-max-tokens 2048 \
  --n-gpu-layers all \
  --reasoning off \
  --reasoning-format none \
  --reasoning-budget 0 \
  --mmproj-offload \
  >> "$LOG_DIR/llama-server.log" 2>&1 &
LLAMA_PID=$!

python3 /opt/krea2/worker.py &
PYWORKER_PID=$!

fail_worker() {
  emit_event "KREA2_MODEL_ERROR $*"
  if [[ -n "$PYWORKER_PID" ]]; then
    kill "$PYWORKER_PID" 2>/dev/null || true
    wait "$PYWORKER_PID" 2>/dev/null || true
    PYWORKER_PID=""
  fi
  exit 1
}

startup_timeout_seconds="${KREA2_STARTUP_TIMEOUT_SECONDS:-900}"
if [[ ! "$startup_timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
  fail_worker "invalid startup timeout"
fi

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

# A health endpoint alone is not enough: prove that the loaded model can
# actually complete a request before advertising capacity to Vast.
self_test_ready=false
for _ in 1 2 3; do
  if curl --fail --silent --max-time 120 \
      -H 'Content-Type: application/json' \
      -d '{"model":"gemma4-26b-a4b-heretic-q3-k-l","messages":[{"role":"user","content":"Return exactly ready."}],"temperature":0,"max_tokens":16,"stream":false}' \
      http://127.0.0.1:18000/v1/chat/completions \
      -o /tmp/krea2-startup-self-test.json \
    && python3 -c 'import json; d=json.load(open("/tmp/krea2-startup-self-test.json", encoding="utf-8")); assert d["choices"][0]["message"]["content"].strip()' ; then
    self_test_ready=true
    break
  fi
  sleep 10
done
rm -f -- /tmp/krea2-startup-self-test.json
[[ "$self_test_ready" == true ]] || fail_worker "model inference self-test failed"

emit_event "KREA2_MODEL_READY"

# Keep supervising both processes after readiness. A failed model server can
# no longer leave a billable zero-capacity worker alive indefinitely: repeated
# health failures make the container exit non-zero so Vast can recruit a
# replacement from the workergroup.
health_failure_limit="${KREA2_HEALTH_FAILURE_LIMIT:-6}"
if [[ ! "$health_failure_limit" =~ ^[1-9][0-9]*$ ]]; then
  fail_worker "invalid health failure limit"
fi
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
  emit_event "KREA2_MODEL_ERROR Vast PyWorker exited with status $worker_status"
fi
exit "$worker_status"
