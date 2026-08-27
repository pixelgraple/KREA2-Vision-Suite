#!/usr/bin/env bash
set -euo pipefail

# The template pins both this bootstrap URL and QWEN38_WORKER_REF to the same
# immutable Git commit.  Workers therefore cannot silently pick up later code.
WORKER_REF="${QWEN38_WORKER_REF:?QWEN38_WORKER_REF must be a pinned Git commit}"
WORKER_BASE="https://raw.githubusercontent.com/pixelgraple/krea2-vast-gemma26-worker/${WORKER_REF}/qwen38-serverless"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends aria2 ca-certificates curl python3 python3-pip
rm -rf /var/lib/apt/lists/*

# The pinned llama.cpp image contains a Debian cryptography package without
# pip RECORD metadata. Installing over it avoids a nondeterministic uninstall.
python3 -m pip install --no-cache-dir --break-system-packages \
  --ignore-installed cryptography==49.0.0 vastai==1.5.5

install -d -m 0755 /opt/qwen38
curl --fail --location --proto '=https' --tlsv1.2 \
  "${WORKER_BASE}/worker.py" -o /opt/qwen38/worker.py
curl --fail --location --proto '=https' --tlsv1.2 \
  "${WORKER_BASE}/start-worker.sh" -o /opt/qwen38/start-worker.sh
chmod 0755 /opt/qwen38/start-worker.sh

exec /opt/qwen38/start-worker.sh

