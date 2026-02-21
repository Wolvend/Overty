# overty

Minimal MCP stdio server that connects to a Chrome DevTools Protocol (CDP) target (Chrome or Electron) and exposes a fast UI iteration loop:

- `connect` (select a target)
- `navigate` (navigate + readiness waits)
- `execute_js` (inject CSS / inspect DOM / quick fixes)
- `set_css` (fast CSS injection without writing JS)
- `install_css` / `uninstall_css` / `list_installed_css` (persist CSS across reloads/navigations)
- `set_viewport` / `clear_viewport` (consistent screenshots)
- `wait_for` (stabilize before screenshots)
- `wait_for_network_idle` (stabilize after navigation; ignores long-lived EventSource/WebSocket by default)
- `audit_layout` (detect common layout issues like horizontal overflow)
- `assert_layout` (pass/fail layout assertions with violations)
- `visual_diff` (pixel diff baseline vs candidate screenshot)
- `qa_matrix` (multi-viewport screenshot + assertion sweep)
- `list_events` (console/log/exception capture)
- `capture_bundle` (screenshot + DOM + events + layout audit to disk)
- `take_screenshot` (visual QA)
- `screenshot_element` (component-level screenshots)
- `take_dom_snapshot` (outerHTML for inspection)
- `render_html_mockups` (batch: render standalone HTML + screenshot multiple CSS variants + write `index.html` gallery + `manifest.json`)

## Requirements

- Node.js v22+
- A CDP target, for example:
  - Chrome: `google-chrome --remote-debugging-port=9222`
  - Electron: start with `--remote-debugging-port=9222`

## Smoke Test (Recommended)

This repo includes a reproducible smoke test that launches headless Chrome with CDP enabled, runs a small JSON-RPC batch that touches the main tool surface (including `render_html_mockups`), and writes artifacts under the safe output roots:

- `output/overty/screenshots/`
- `output/overty/bundles/`
- `output/overty/mockups/`

```bash
./scripts/overty_smoke.sh
```

If you can't run Chromium in your environment (some sandboxed CI runners restrict it), a protocol-only smoke is also available (no browser required):

```bash
./scripts/overty_smoke_protocol.sh
```

You can also keep `npm run smoke` working in browserless environments by enabling fallback:

```bash
OVERTY_SMOKE_ALLOW_NO_CHROME_SMOKE=1 npm run smoke
```

## Run (stdio)

```bash
node src/index.js
```

Set a default endpoint (optional):

```bash
OVERTY_BROWSER_URL=http://127.0.0.1:9222 node src/index.js
```

## Optional sidecar mode (launches chrome-devtools-mcp for you)

`overty` can launch a local `chrome-devtools-mcp` process automatically when `OVERTY_WITH_CHROME_DEVTOOLS=1` is set.  
This keeps `chrome-devtools-mcp` untouched and lets `overty` own the lifecycle (start and stop).

### Sidecar env vars

- `OVERTY_WITH_CHROME_DEVTOOLS`: `1` or `true` to enable sidecar.
- `OVERTY_CHROME_DEVTOOLS_EXEC`: executable used to start sidecar (default: Node runtime path, same as `process.execPath`).
- `OVERTY_CHROME_DEVTOOLS_CMD`:
  - defaults to sibling `../chrome-devtools-mcp/build/src/index.js` when `OVERTY_CHROME_DEVTOOLS_EXEC` is Node
  - defaults to empty when a non-node executable is provided.
- `OVERTY_CHROME_DEVTOOLS_ARGS`: extra args for the sidecar; set as JSON array (e.g. `["--http-port","9333"]`) or as shell-like tokens (`--http-port 9333`).
- `OVERTY_CHROME_DEVTOOLS_START_DELAY_MS`: delay (ms) after spawn before continuing startup (default: `1500`).

Example:

```bash
OVERTY_WITH_CHROME_DEVTOOLS=1 \
OVERTY_CHROME_DEVTOOLS_CMD=/absolute/path/to/chrome-devtools-mcp/build/src/index.js \
OVERTY_CHROME_DEVTOOLS_ARGS='["--http-port","9223"]' \
node src/index.js
```

Using a non-node executable

```bash
OVERTY_WITH_CHROME_DEVTOOLS=1 \
OVERTY_CHROME_DEVTOOLS_EXEC=/usr/local/bin/chrome-devtools-mcp \
OVERTY_CHROME_DEVTOOLS_ARGS='["--http-port","9223"]' \
node src/index.js
```

## Codex MCP config (example)

Using Codex CLI:

```bash
codex mcp add overty -- node /absolute/path/to/overty/src/index.js
```

## Tool Examples (copy/paste)

### 1) Initialize

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}
```

### 2) Connect (select a target by URL substring)

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"connect","arguments":{"browserUrl":"http://127.0.0.1:9222","targetUrlSubstring":"localhost"}}}
```

You can also select by exact `targetId` (from the `/json/list` response) via `connect.arguments.targetId`.

### 3) Inject CSS (fast live iteration) + Screenshot

Preferred (simpler) CSS injection:

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"set_css","arguments":{"css":"*{outline:1px solid rgba(255,0,0,.15)}"}}}
```

Persistent CSS injection across reloads/navigations:

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"install_css","arguments":{"css":"*{outline:1px solid rgba(255,0,0,.15)}"}}}
```

Equivalent via raw JS:

```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"execute_js","arguments":{"expression":"(() => { let s=document.getElementById('overty-style'); if(!s){s=document.createElement('style'); s.id='overty-style'; document.head.appendChild(s);} s.textContent='*{outline:1px solid rgba(255,0,0,.15)}'; return 'ok'; })()"}}}
```

```json
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"take_screenshot","arguments":{"fullPage":true}}}
```

Screenshot a specific component (element clip):

```json
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"screenshot_element","arguments":{"selector":".card","paddingPx":8}}}
```

### 4) Navigate (with readiness + app-specific waits)

```json
{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"navigate","arguments":{"url":"https://example.com","waitUntil":"load","timeoutMs":30000}}}
```

Wait for your app to render something specific:

```json
{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"navigate","arguments":{"url":"https://example.com","waitUntil":"domcontentloaded","waitForText":"Example Domain","timeoutMs":30000}}}
```

Optionally wait for network to go idle after navigation:

```json
{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"wait_for_network_idle","arguments":{"idleMs":500,"timeoutMs":30000}}}
```

### 5) Set viewport + wait_for (stability)

```json
{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"set_viewport","arguments":{"width":1280,"height":720,"deviceScaleFactor":1}}}
```

```json
{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"wait_for","arguments":{"timeMs":150}}}
```

### 6) Layout audit + console/log events (debugging)

```json
{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"audit_layout","arguments":{"tolerancePx":1,"maxElements":20}}}
```

```json
{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"list_events","arguments":{"limit":30}}}
```

Capture a single “QA bundle” folder (screenshot + DOM + events + layout audit):

```json
{"jsonrpc":"2.0","id":15,"method":"tools/call","params":{"name":"capture_bundle","arguments":{"label":"after-css-fix","fullPage":true,"inlineScreenshot":true}}}
```

### 7) DOM snapshot (outerHTML)

```json
{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"take_dom_snapshot","arguments":{"maxChars":50000}}}
```

### 8) Batch render 10 HTML mockup variants (screenshots to disk)

This opens a fresh tab, writes `html`, applies `baseCss + variant.css` for each item, screenshots each variant, then restores the previously connected target (if any).

```json
{"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":"render_html_mockups","arguments":{"html":"<!doctype html><html><head><meta charset='utf-8'><title>Mock</title></head><body><main class='card'><h1>Mockup</h1><p>Variant screenshots</p></main></body></html>","baseCss":"body{font-family:ui-sans-serif,system-ui;margin:0;padding:40px;background:#0b0d12;color:#eaf0ff}.card{max-width:640px;margin:0 auto;padding:24px;border-radius:16px;background:#131a2b;box-shadow:0 30px 80px rgba(0,0,0,.45)}","viewport":{"width":1280,"height":720},"variants":[{"name":"aura","css":".card{background:linear-gradient(135deg,#1b2b6b,#151b2b)} h1{letter-spacing:.06em}","fullPage":false},{"name":"paper","css":"body{background:#f6f3ee;color:#111}.card{background:#fff;box-shadow:0 18px 40px rgba(17,17,17,.12)}"},{"name":"mono","css":"body{font-family:ui-monospace,Menlo,monospace;background:#0f0f10;color:#f2f2f2}.card{border:1px solid rgba(255,255,255,.12);background:#0f0f10}"}],"inlineLimit":2}}}
```

### 9) Assert layout quality rules (pass/fail)

```json
{"jsonrpc":"2.0","id":21,"method":"tools/call","params":{"name":"assert_layout","arguments":{"maxHorizontalOverflowPx":0,"maxOverflowingElements":0,"maxClippedText":0,"maxOverlapCount":0,"minTapTargetPx":44,"maxTapTargetViolations":0}}}
```

### 10) Visual diff (baseline file vs current page screenshot)

```json
{"jsonrpc":"2.0","id":22,"method":"tools/call","params":{"name":"visual_diff","arguments":{"baselinePath":"output/overty/baselines/home.png","fullPage":true,"threshold":16,"failPercent":0.5,"failOnDimensionMismatch":true,"writeDiff":true,"inlineDiff":true}}}
```

### 11) QA matrix (viewport sweep)

```json
{"jsonrpc":"2.0","id":23,"method":"tools/call","params":{"name":"qa_matrix","arguments":{"outputDir":"output/overty/qa-matrix/home","viewports":[{"name":"mobile","width":390,"height":844,"mobile":true},{"name":"tablet","width":768,"height":1024,"mobile":true},{"name":"desktop","width":1440,"height":900,"mobile":false}],"includeLayoutAudit":true,"includeAssertions":true,"assertRules":{"maxHorizontalOverflowPx":0,"maxOverflowingElements":0,"maxClippedText":0,"maxOverlapCount":0,"minTapTargetPx":44,"maxTapTargetViolations":0},"inlineLimit":1}}}
```

## Notes

- `connect` refuses non-loopback CDP endpoints unless you pass `allowRemote: true`.
- For large screenshots, `take_screenshot` will auto-save to `output/overty/screenshots/` instead of returning inline image data.
- `render_html_mockups` writes `index.html` and `manifest.json` in the output folder by default (set `writeIndexHtml:false` / `writeManifest:false` to disable).
- `visual_diff` uses browser Canvas via CDP; keep a connected target before calling.
- `open_page` uses `PUT` for `/json/new` (newer Chrome), with a fallback to `GET` for older targets.
