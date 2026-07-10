# Targets: residual quality (post #1–#3) — 2026-07-10
repo: /Users/michael/forge/plugins/iris @ iris-sweep-fixes (PR #1) | formula: impact(J) × opportunity(J)
mode: meticulous residual sweep + execution

## Fixed this pass
1. **PR #1** — https://github.com/mizner/iris/pull/1 (11 commits branched off main)
2. **network_get body secrets** — `redactNetworkBody` deep JSON scrub; `bodyRedacted` flag; base64 bodies not scrubbed
3. **Plane labeling** — AppleScript/agent successes prefixed / `plane` field; `IRIS_FALLBACK=off` disables non-extension planes
4. **Agent fail-loud** — unsupported tools list full supported subset
5. **CDP click** — `Input.dispatchMouseEvent` when debugger attached; DOM fallback
6. **Skill inventory CI** — `scripts/check-skill-tools.mjs` + `test:skill-tools` / chained `test`

## Verification (parent QA)
- `bun run check:runtime` pass
- `bun run test` → 8/8 broker + skill 34 tools
- `bun run build` pass
- Live: `browser_press Escape` → Pressed Escape; `browser_click body` → Clicked body
- Unit: redactNetworkBody redacts access_token/clientSecret/refresh_token; preserves tokenCount

## Candidates remaining (unscored)
- Snapshot ref/uid addressing
- Header redaction edge names (x-amz-security-token)
- Extension unit harness beyond broker
- Full agent-mode tool parity (wait_for/network) beyond fail-loud

## Gate
No further premium dispatch without new named targets.
