#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/opt/krea2-dedicated
LOG_ROOT="$ROOT/logs"
TUNNEL_KEY="$ROOT/tunnel_ed25519"
TUNNEL_HOST="${KREA2_TUNNEL_HOST:-103.75.127.117}"
TUNNEL_USER="${KREA2_TUNNEL_USER:-krea2tunnel}"
TUNNEL_PORT="${KREA2_TUNNEL_PORT:-18090}"

mkdir -p "$LOG_ROOT"

stop_children() {
  [[ -n "${router_pid:-}" ]] && kill "$router_pid" 2>/dev/null || true
  [[ -n "${tunnel_pid:-}" ]] && kill "$tunnel_pid" 2>/dev/null || true
}
trap stop_children EXIT INT TERM

router_loop() {
  while true; do
    "$ROOT/start-router.sh" || true
    sleep 3
  done
}

tunnel_loop() {
  while true; do
    ssh -i "$TUNNEL_KEY" \
      -o IdentitiesOnly=yes \
      -o BatchMode=yes \
      -o ExitOnForwardFailure=yes \
      -o ServerAliveInterval=15 \
      -o ServerAliveCountMax=3 \
      -o StrictHostKeyChecking=yes \
      -N -R "127.0.0.1:${TUNNEL_PORT}:127.0.0.1:18000" \
      "${TUNNEL_USER}@${TUNNEL_HOST}" \
      >> "$LOG_ROOT/tunnel.log" 2>&1 || true
    sleep 3
  done
}

router_loop &
router_pid=$!
tunnel_loop &
tunnel_pid=$!
wait -n "$router_pid" "$tunnel_pid"
