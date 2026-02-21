# overty: launch chrome-devtools-mcp as an optional sidecar

## Status
Complete (with follow-up validation)

## Objective
- Keep the sidecar integration for Chrome DevTools MCP fully in `overty`.
- Avoid any edits to `chrome-devtools-mcp` repository.
- Add configuration and docs so `chrome-devtools-mcp` can be launched automatically when needed.

## Decisions
- Add environment-driven sidecar wiring in `source/agents/tooling/overty/src/index.js`.
- Default sidecar command points to sibling `../chrome-devtools-mcp/build/src/index.js` and default executable is the current Node binary.
- Start/stop sidecar from `over ty` process lifecycle only.
- Keep all changes constrained to `over ty` repo (including docs/scripts/package manifest).
- Make `npm run smoke` resilient in browser-restricted environments by adding optional protocol-only fallback when no Chrome binary is available.

## Progress
1. Implemented sidecar config parsing and spawn logic in `src/index.js`.
2. Added safe logging for the exact sidecar command used at startup.
3. Added lifecycle wiring to start before MCP serve and stop on SIGINT/SIGTERM.
4. Added run convenience script `start:with-chrome-devtools`.
5. Added README section documenting env vars and example usage.
6. Hardened spawn behavior for non-node sidecar executables so they are not forced to receive a Node script arg.
7. Updated smoke script to support `OVERTY_SMOKE_ALLOW_NO_CHROME_SMOKE=1` fallback to `scripts/overty_smoke_protocol.sh` when Chrome is unavailable or CDP fails to start.

## Validation commands (to run)
- `node --check src/index.js`
- `OVERTY_WITH_CHROME_DEVTOOLS=1 node src/index.js < /dev/null` (quick startup smoke with `OVERTY_WITH_CHROME_DEVTOOLS=1` against local default sidecar target in a terminal where sibling `chrome-devtools-mcp` is available)
- `npm run smoke:protocol` (`SMOKE_OK` validates protocol bootstrap)
- `timeout 6s bash -lc "OVERTY_WITH_CHROME_DEVTOOLS=1 OVERTY_CHROME_DEVTOOLS_EXEC=/bin/sleep OVERTY_CHROME_DEVTOOLS_ARGS='[\"2\"]' OVERTY_CHROME_DEVTOOLS_START_DELAY_MS=0 node src/index.js"` (non-node executable smoke)
- `OVERTY_SMOKE_ALLOW_NO_CHROME_SMOKE=1 npm run smoke` (`SMOKE_OK` from protocol fallback in no-browser environments)

## Completion criteria
- `chrome-devtools-mcp` repo unchanged.
- `overty` cleanly handles sidecar start/stop from its own process.
- Docs show expected env contract and usage.
- Sidecar can be launched with default Node/JS path assumptions.
- `npm run smoke` remains passable in browserless CI via explicit `OVERTY_SMOKE_ALLOW_NO_CHROME_SMOKE=1` fallback.
