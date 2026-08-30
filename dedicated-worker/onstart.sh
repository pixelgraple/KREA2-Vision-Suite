#!/usr/bin/env bash
set -u

ROOT=/opt/krea2-dedicated
PID_FILE="$ROOT/supervisor.pid"

if [[ -s "$PID_FILE" ]]; then
  existing_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ "$existing_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$existing_pid" 2>/dev/null; then
    exit 0
  fi
fi

nohup setsid "$ROOT/start-dedicated.sh" >> "$ROOT/logs/supervisor.log" 2>&1 &
printf '%s\n' "$!" > "$PID_FILE"
