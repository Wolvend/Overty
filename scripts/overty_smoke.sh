#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${OVERTY_CDP_PORT:-9222}"
ALLOW_NO_BROWSER_SMOKE="${OVERTY_SMOKE_ALLOW_NO_CHROME_SMOKE:-0}"

# You can override the browser binary with OVERTY_CHROME_BIN=/path/to/chrome
CHROME_BIN="${OVERTY_CHROME_BIN:-}"
if [[ -z "$CHROME_BIN" ]]; then
  if command -v google-chrome >/dev/null 2>&1; then
    CHROME_BIN="$(command -v google-chrome)"
  elif command -v chromium >/dev/null 2>&1; then
    CHROME_BIN="$(command -v chromium)"
  elif command -v chromium-browser >/dev/null 2>&1; then
    CHROME_BIN="$(command -v chromium-browser)"
  else
    MS_PW="$HOME/.cache/ms-playwright"
    CHROME_BIN="$(ls -dt "$MS_PW"/chromium-*/chrome-linux64/chrome 2>/dev/null | head -1 || true)"
  fi
fi

run_protocol_fallback() {
  echo "Could not run browser-dependent smoke. Falling back to protocol-only smoke: ./scripts/overty_smoke_protocol.sh" >&2
  exec "$ROOT/scripts/overty_smoke_protocol.sh"
}

if [[ -z "$CHROME_BIN" || ! -x "$CHROME_BIN" ]]; then
  if [[ "$ALLOW_NO_BROWSER_SMOKE" == "1" || "$ALLOW_NO_BROWSER_SMOKE" == "true" ]]; then
    run_protocol_fallback
  fi
  echo "Could not find a Chromium/Chrome binary. Set OVERTY_CHROME_BIN to an executable path." >&2
  exit 2
fi

RUN_TAG="${OVERTY_SMOKE_TAG:-smoke-$(date +%s)}"
RUN_DIR="${OVERTY_RUN_DIR:-"$ROOT/output/overty/$RUN_TAG"}"
SMOKE_SCREENSHOT_DIR="${OVERTY_SCREENSHOT_DIR:-"$ROOT/output/overty/screenshots/$RUN_TAG"}"
SMOKE_BUNDLE_DIR="${OVERTY_BUNDLE_DIR:-"$ROOT/output/overty/bundles/$RUN_TAG"}"
SMOKE_MOCKUPS_DIR="${OVERTY_MOCKUP_DIR:-"$ROOT/output/overty/mockups/$RUN_TAG"}"
PROFILE_DIR="$RUN_DIR/chrome-profile"
mkdir -p "$PROFILE_DIR" "$SMOKE_SCREENSHOT_DIR" "$SMOKE_BUNDLE_DIR" "$SMOKE_MOCKUPS_DIR"

CHROME_LOG="$RUN_DIR/chrome.log"
SERVER_LOG="$RUN_DIR/server.log"
RPC_OUT="$RUN_DIR/rpc_out.jsonl"
REQ_OUT="$RUN_DIR/requests.jsonl"

# Keep the HTML/CSS single-line and avoid double quotes so we can embed into JSON safely.
HTML_DOC="<!doctype html><html><head><meta charset='utf-8'><title>Overty Smoke</title></head><body><main class='card'><h1>Overty Smoke</h1><p id='p'>hello</p><button id='btn'>Click</button></main><script>console.log('smoke log');</script></body></html>"
CSS_BASE="body{margin:0;padding:40px;background:#0b0d12;color:#eaf0ff;font-family:ui-sans-serif,system-ui} .card{max-width:640px;margin:0 auto;padding:24px;border-radius:16px;background:#131a2b;box-shadow:0 30px 80px rgba(0,0,0,.45)} #btn{margin-top:12px;padding:10px 14px;border-radius:12px;border:0;background:#3b82f6;color:white}"

"$CHROME_BIN" \
  --headless=new \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE_DIR" \
  --no-sandbox \
  --disable-setuid-sandbox \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  about:blank \
  >"$CHROME_LOG" 2>&1 &
CHROME_PID=$!

cleanup() {
  kill "$CHROME_PID" >/dev/null 2>&1 || true
  wait "$CHROME_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

ready=0
for _ in $(seq 1 200); do
  if curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$CHROME_PID" >/dev/null 2>&1; then
    break
  fi
  sleep 0.05
done

if [[ $ready -ne 1 ]]; then
  echo "Chrome CDP did not become ready." >&2
  echo "CHROME_BIN=$CHROME_BIN" >&2
  echo "CHROME_LOG=$CHROME_LOG" >&2
  tail -n 80 "$CHROME_LOG" >&2 || true
  echo "" >&2
  if [[ "$ALLOW_NO_BROWSER_SMOKE" == "1" || "$ALLOW_NO_BROWSER_SMOKE" == "true" ]]; then
    echo "Falling back to protocol-only smoke due to missing CDP readiness." >&2
    run_protocol_fallback
  fi
  echo "Try: set OVERTY_CHROME_BIN to a system Chrome/Chromium build, or set OVERTY_SMOKE_ALLOW_NO_CHROME_SMOKE=1 and run protocol-only fallback." >&2
  echo "  ./scripts/overty_smoke_protocol.sh" >&2
  exit 3
fi

cat >"$REQ_OUT" <<JSON
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"overty-smoke","version":"0.0.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"open_page","arguments":{"browserUrl":"http://127.0.0.1:$PORT","url":"data:text/html,$HTML_DOC"}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"set_viewport","arguments":{"width":1200,"height":800,"deviceScaleFactor":1}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"execute_js","arguments":{"expression":"(() => { console.log('execute_js log'); return document.title; })()"}}}
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"install_css","arguments":{"css":"$CSS_BASE"}}}
{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"navigate","arguments":{"url":"data:text/html,$HTML_DOC","waitUntil":"load","timeoutMs":30000}}}
{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"wait_for_network_idle","arguments":{"idleMs":200,"timeoutMs":10000}}}
{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"take_screenshot","arguments":{"fullPage":false,"filePath":"$SMOKE_SCREENSHOT_DIR/live.png"}}}
{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"screenshot_element","arguments":{"selector":".card","paddingPx":8,"filePath":"$SMOKE_SCREENSHOT_DIR/card.png"}}}
{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"audit_layout","arguments":{"tolerancePx":1,"maxElements":10}}}
{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"list_events","arguments":{"limit":50}}}
{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"capture_bundle","arguments":{"label":"after","outputDir":"$SMOKE_BUNDLE_DIR","fullPage":false}}}
{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"render_html_mockups","arguments":{"browserUrl":"http://127.0.0.1:$PORT","outputDir":"$SMOKE_MOCKUPS_DIR","viewport":{"width":1200,"height":800},"html":"$HTML_DOC","baseCss":"$CSS_BASE","variants":[{"name":"aura","css":".card{background:linear-gradient(135deg,#1b2b6b,#151b2b)} h1{letter-spacing:.06em}","fullPage":false},{"name":"paper","css":"body{background:#f6f3ee;color:#111}.card{background:#fff;box-shadow:0 18px 40px rgba(17,17,17,.12)} #btn{background:#111}","fullPage":false},{"name":"mono","css":"body{font-family:ui-monospace,Menlo,monospace;background:#0f0f10;color:#f2f2f2}.card{border:1px solid rgba(255,255,255,.12);background:#0f0f10} #btn{background:#22c55e;color:#052e16}","fullPage":false}]}}}
{"jsonrpc":"2.0","id":15,"method":"tools/call","params":{"name":"close_target","arguments":{}}}
JSON

OVERTY_DEBUG="${OVERTY_DEBUG:-1}" \
  node "$ROOT/src/index.js" <"$REQ_OUT" >"$RPC_OUT" 2>"$SERVER_LOG"

if [[ ! -s "$RPC_OUT" ]]; then
  echo "Smoke failed: no JSON-RPC output at $RPC_OUT" >&2
  exit 10
fi
if [[ ! -f "$SMOKE_SCREENSHOT_DIR/live.png" ]]; then
  echo "Smoke failed: missing $SMOKE_SCREENSHOT_DIR/live.png" >&2
  exit 11
fi
if [[ ! -f "$SMOKE_SCREENSHOT_DIR/card.png" ]]; then
  echo "Smoke failed: missing $SMOKE_SCREENSHOT_DIR/card.png" >&2
  exit 12
fi
if [[ ! -f "$SMOKE_BUNDLE_DIR/bundle.json" ]]; then
  echo "Smoke failed: missing $SMOKE_BUNDLE_DIR/bundle.json" >&2
  exit 13
fi
if [[ ! -f "$SMOKE_MOCKUPS_DIR/manifest.json" ]]; then
  echo "Smoke failed: missing $SMOKE_MOCKUPS_DIR/manifest.json" >&2
  exit 14
fi
if [[ ! -f "$SMOKE_MOCKUPS_DIR/index.html" ]]; then
  echo "Smoke failed: missing $SMOKE_MOCKUPS_DIR/index.html" >&2
  exit 15
fi

echo "SMOKE_OK $RUN_DIR"
