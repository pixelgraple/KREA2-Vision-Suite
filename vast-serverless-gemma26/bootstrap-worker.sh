#!/usr/bin/env bash
set -euo pipefail

# Vast can pull the public pinned llama.cpp CUDA image anonymously.  Keep the
# KREA2 orchestration scripts equally reproducible without requiring a private
# container-registry credential on ephemeral Serverless hosts.
WORKER_REF="krea2-worker-v0.13.9"
WORKER_BASE="https://raw.githubusercontent.com/pixelgraple/KREA2-Vision-Suite/${WORKER_REF}/vast-serverless-gemma26"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends aria2 ca-certificates curl python3 python3-pip
rm -rf /var/lib/apt/lists/*
python3 -m pip install --no-cache-dir --break-system-packages vastai==1.5.5

install -d -m 0755 /opt/krea2
curl --fail --location --proto '=https' --tlsv1.2 \
  "${WORKER_BASE}/worker.py" -o /opt/krea2/worker.py
curl --fail --location --proto '=https' --tlsv1.2 \
  "${WORKER_BASE}/start-worker.sh" -o /opt/krea2/start-worker.sh
chmod 0755 /opt/krea2/start-worker.sh

exec /opt/krea2/start-worker.sh
