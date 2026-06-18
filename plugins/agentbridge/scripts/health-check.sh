#!/usr/bin/env bash

set -uo pipefail

INPUT="$(cat 2>/dev/null || true)"

workspace="${CLAUDE_PROJECT_DIR:-${PWD}}"
cooldown_seconds="${AGENTBRIDGE_HEALTH_HOOK_COOLDOWN_SECONDS:-120}"
state_root="${AGENTBRIDGE_HOOK_STATE_DIR:-${TMPDIR:-/tmp}/agentbridge-hooks}"
port="${AGENTBRIDGE_CONTROL_PORT:-4502}"

if ! command -v curl >/dev/null 2>&1; then
  exit 0
fi

mkdir -p "$state_root" 2>/dev/null || true
workspace_key="$(printf '%s' "$workspace" | cksum | awk '{print $1}')"
stamp_file="${state_root}/sessionstart-${workspace_key}.stamp"
now="$(date +%s)"

if [ -f "$stamp_file" ]; then
  last_notice="$(cat "$stamp_file" 2>/dev/null || echo 0)"
  if [ $((now - last_notice)) -lt "$cooldown_seconds" ]; then
    exit 0
  fi
fi

printf '%s' "$now" >"$stamp_file" 2>/dev/null || true

health_json="$(curl -fsS --max-time 1 "http://127.0.0.1:${port}/healthz" 2>/dev/null || true)"

# Derive the peer label from appServerUrl so the hook works across all peer
# modes (Codex/Kimi/ZCode) without hardcoding a name. Map by URL scheme:
#   acp://*            → Kimi
#   zcode://*          → ZCode
#   stdio://* or other → Codex (default, keeps backward compat)
peer_label="Codex"
case "$health_json" in
  *'"appServerUrl":"acp:'*)  peer_label="Kimi" ;;
  *'"appServerUrl":"zcode:'*) peer_label="ZCode" ;;
esac

if [ -n "$health_json" ]; then
  tui_connected="false"
  if printf '%s' "$health_json" | grep -q '"tuiConnected":true'; then
    tui_connected="true"
  fi

  if [ "$tui_connected" = "true" ]; then
    cat <<EOF
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"AgentBridge is running. Daemon healthy, ${peer_label} connected. Bridge is ready for communication."}}
EOF
  else
    cat <<EOF
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"AgentBridge daemon is running but ${peer_label} is not connected yet."}}
EOF
  fi
else
  cat <<EOF
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"AgentBridge daemon is not reachable on http://127.0.0.1:${port}/healthz yet. The bridge may still be starting up."}}
EOF
fi
