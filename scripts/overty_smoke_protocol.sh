#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RUN_DIR="${OVERTY_RUN_DIR:-"$ROOT/output/overty/protocol-smoke-$(date +%s)"}"
mkdir -p "$RUN_DIR"

RPC_OUT="$RUN_DIR/rpc_out.jsonl"
REQ_OUT="$RUN_DIR/requests.jsonl"
SERVER_LOG="$RUN_DIR/server.log"

# Minimal MCP handshake + tools/list only (no CDP target required).
cat >"$REQ_OUT" <<'JSON'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"overty-protocol-smoke","version":"0.0.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
JSON

OVERTY_DEBUG="${OVERTY_DEBUG:-0}" \
  node "$ROOT/src/index.js" <"$REQ_OUT" >"$RPC_OUT" 2>"$SERVER_LOG"

if [[ ! -s "$RPC_OUT" ]]; then
  echo "Smoke failed: no JSON-RPC output at $RPC_OUT" >&2
  exit 10
fi

for tool in connect navigate execute_js set_css take_screenshot render_html_mockups assert_layout visual_diff qa_matrix; do
  if ! grep -Eq "\"name\"[[:space:]]*:[[:space:]]*\"$tool\"" "$RPC_OUT"; then
    echo "Smoke failed: tools/list missing tool '$tool' (see $RPC_OUT)" >&2
    exit 11
  fi
done

echo "SMOKE_OK $RUN_DIR"

