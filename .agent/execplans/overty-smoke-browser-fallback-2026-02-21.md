# overty: allow smoke fallback when Chrome is unavailable

Status: In progress

## 1) Objective
- Make `npm run smoke` useful in browser-restricted environments by adding explicit fallback behavior instead of hard failing immediately when Chrome/Chromium is unavailable.

## 2) Scope
- `scripts/overty_smoke.sh`:
  - add Playwright-based binary discovery using optional `OVERTY_PLAYWRIGHT_NODE_PATH`.
  - support `OVERTY_SMOKE_ALLOW_NO_CHROME_SMOKE=1` to fallback to protocol-only smoke.
  - keep existing binary discovery order (`OVERTY_CHROME_BIN`, system binaries, local Playwright cache, Playwright module probe).
- `source/agents/tooling/overty/README.md`:
  - document `OVERTY_SMOKE_ALLOW_NO_CHROME_SMOKE` runtime behavior and Playwright fallback override.

## 3) Implementation
1. Update `scripts/overty_smoke.sh` to add `find_playwright_chrome()` and optional fallback execution path.
2. Preserve existing `SMOKE_OK` output shape and artifact assertions when full browser run is possible.
3. Update README usage guidance for new env vars.

## 4) Validation
- `bash scripts/overty_smoke_protocol.sh` (protocol-only smoke path remains green)
- `OVERTY_SMOKE_ALLOW_NO_CHROME_SMOKE=1 bash scripts/overty_smoke.sh` (should run protocol smoke)
- `bash scripts/overty_smoke.sh` (should run full smoke when Chrome binary is discoverable)

## 5) Completion criteria
- Full smoke either succeeds with Chrome/CDP available or exits with fallback behavior when explicitly requested.
- Smoke remains unchanged in non-fallback mode when no browser is present, except it now emits clearer guidance.
- Documentation describes the fallback and Playwright module root override.
