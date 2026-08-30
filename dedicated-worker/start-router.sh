#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/opt/krea2-dedicated
MODEL_ROOT="$ROOT/models"
LOG_ROOT="$ROOT/logs"
LLAMA_ROOT=/opt/llama.cpp/cuda-12.8
LLAMA_SERVER="$LLAMA_ROOT/llama-server"
API_KEY_FILE="$ROOT/router-api-keys.txt"
PRESET_FILE="$ROOT/models.ini"

mkdir -p "$MODEL_ROOT/gemma" "$MODEL_ROOT/qwen" "$LOG_ROOT"
touch "$LOG_ROOT/router.log"

if [[ ! -s "$API_KEY_FILE" ]]; then
  umask 077
  python3 - <<'PY' > "$API_KEY_FILE"
import secrets
print(secrets.token_urlsafe(48))
PY
fi
chmod 600 "$API_KEY_FILE"

download_verified() {
  local path="$1" url="$2" bytes="$3" sha256="$4"
  local actual_bytes actual_sha
  if [[ -f "$path" ]]; then
    actual_bytes="$(stat -c '%s' "$path" 2>/dev/null || printf 0)"
    if [[ "$actual_bytes" == "$bytes" ]]; then
      actual_sha="$(sha256sum "$path" | awk '{print $1}')"
      [[ "$actual_sha" == "$sha256" ]] && return 0
    fi
    rm -f -- "$path"
  fi

  if command -v aria2c >/dev/null 2>&1; then
    aria2c \
      --allow-overwrite=true \
      --auto-file-renaming=false \
      --continue=true \
      --connect-timeout=20 \
      --file-allocation=none \
      --max-connection-per-server=16 \
      --max-tries=8 \
      --min-split-size=16M \
      --retry-wait=2 \
      --split=16 \
      --dir="$(dirname "$path")" \
      --out="$(basename "$path").part" \
      "$url"
  else
    curl --fail --location --retry 8 --retry-all-errors \
      --connect-timeout 20 --speed-time 60 --speed-limit 1048576 \
      --continue-at - --output "$path.part" "$url"
  fi
  actual_bytes="$(stat -c '%s' "$path.part")"
  [[ "$actual_bytes" == "$bytes" ]] || {
    printf 'invalid byte count for %s: expected %s, got %s\n' "$path" "$bytes" "$actual_bytes" >&2
    rm -f -- "$path.part"
    return 1
  }
  actual_sha="$(sha256sum "$path.part" | awk '{print $1}')"
  [[ "$actual_sha" == "$sha256" ]] || {
    printf 'invalid SHA-256 for %s\n' "$path" >&2
    rm -f -- "$path.part"
    return 1
  }
  mv -- "$path.part" "$path"
}

download_verified \
  "$MODEL_ROOT/gemma/gemma-4-26B-A4B-it-uncensored-heretic-Q3_K_L.gguf" \
  'https://huggingface.co/llmfan46/gemma-4-26B-A4B-it-uncensored-heretic-GGUF/resolve/ea0259bf66bcd33b5f3425eb223932abaa0f4f07/gemma-4-26B-A4B-it-uncensored-heretic-Q3_K_L.gguf?download=true' \
  13824487424 \
  431a5dd46d69d996d5a682d44dadcdd87cad3834185cbaea4176484151974b92

download_verified \
  "$MODEL_ROOT/gemma/mmproj-gemma-4-26B-A4B-it-BF16.gguf" \
  'https://huggingface.co/llmfan46/gemma-4-26B-A4B-it-uncensored-heretic-GGUF/resolve/ea0259bf66bcd33b5f3425eb223932abaa0f4f07/gemma-4-26B-A4B-it-mmproj-BF16.gguf?download=true' \
  1194828000 \
  b3ee6c97d5a5bb1ae9eb93bf14c1d1b51a0179a45ac1076b195931814c759e1e

download_verified \
  "$MODEL_ROOT/qwen/RVN-Q4_K_M-multilingual.gguf" \
  'https://huggingface.co/0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF/resolve/20b94f0613b632b4848bbe3b1e05d9ee0c2b1608/RVN-Q4_K_M-multilingual.gguf?download=true' \
  16547400224 \
  9ed40ccc8b8432f38b9a85d0ca67928167f5719e8c10bd299e56d34facaf6e61

download_verified \
  "$MODEL_ROOT/qwen/mmproj-Qwen3.8-27B-Q8_0.gguf" \
  'https://huggingface.co/0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF/resolve/20b94f0613b632b4848bbe3b1e05d9ee0c2b1608/mmproj-Qwen3.8-27B-Q8_0.gguf?download=true' \
  629247008 \
  2e968a6af97ce35d8971890b257b9b7edabf20ad91450501fa53162a19ee33eb

export LD_LIBRARY_PATH="$LLAMA_ROOT${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$LLAMA_SERVER" \
  --host 127.0.0.1 \
  --port 18000 \
  --models-preset "$PRESET_FILE" \
  --models-max 1 \
  --api-key-file "$API_KEY_FILE" \
  --metrics \
  --log-timestamps \
  >> "$LOG_ROOT/router.log" 2>&1
