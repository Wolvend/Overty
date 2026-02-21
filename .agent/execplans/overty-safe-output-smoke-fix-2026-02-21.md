# overty: safe-output + smoke path hardening plan

Status: Partially complete (blocked on Chrome binary availability)

## 1) Objective
- Keep all MCP tool file output writes within approved safe output roots.
- Ensure smoke script artifacts stay in safe roots to avoid `OVERTY_INVALID_ARG` and match tool validation.
- Keep behavior deterministic and document the new paths for operators.

## 2) Scope
- `src/index.js`: harden output path validation and centralize safe root checks.
- `scripts/overty_smoke.sh`: rewrite runtime artifact locations.
- `README.md`: update smoke documentation with expected artifact roots.

## 3) Plan
1. Audit current safe-output checks in MCP handlers.
2. Introduce/verify helper to resolve and validate only paths under `output/overty/{screenshots,mockups,bundles,qa-matrix,diffs}`.
3. Update smoke script to route screenshots/bundles/mockups into safe roots:
   - `output/overty/screenshots/<tag>/`
   - `output/overty/bundles/<tag>/`
   - `output/overty/mockups/<tag>/`
4. Add explicit smoke assertions against these paths.
5. Run protocol smoke and report results.

## 4) Validation
- Command: `bash scripts/overty_smoke_protocol.sh`
- Command: `bash scripts/overty_smoke.sh`
- Expected: protocol smoke should print `SMOKE_OK ...`.
- Expected: full smoke prints `SMOKE_OK ...` if Chrome/CDP is available.

## 5) Completion criteria
- No `OVERTY_INVALID_ARG` due to smoke artifact paths.
- Tool handlers consistently reject writes outside approved output roots.
- README clearly documents where smoke artifacts land.

## 6) Outstanding if blocked
- `scripts/overty_smoke.sh` requires `OVERTY_CHROME_BIN` (or Chromium/Chrome on PATH).
- If missing, smoke remains blocked until runtime dependency is present.

Current environment observation:
- `scripts/overty_smoke_protocol.sh` passes.
- `scripts/overty_smoke.sh` fails at startup because no Chrome/Chromium binary is available.
