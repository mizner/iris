# Targets: quality (bugs + reliability + security + DX) — 2026-07-15 refresh (post-OMP)
repo: /Users/michael/forge/plugins/iris @ 25066a5 | formula: impact(J) × opportunity(J)
mode: **refresh** of `quality-2026-07-15.md` after uncommitted `@mizner/iris-omp` + publish-prep tree
swept: packages/{core,opencode,mcp,omp,skill} + scripts/ (~17 sources, ~7.8k LOC first-party) | small-repo direct scoring (no Haiku fan-out)
history caveat: **16 commits** total — churn ranks low-confidence; judgment + live evidence
status note 2026-07-15 evening: #1 #2 #3 #5(partial harness) #6 **fixed in tree**; #4 open until PR lands

prior fixed (do not re-open): press/CDP keys, doctor STALE, default-tab, network JSON scrub v1, plane labels + IRIS_FALLBACK=off, agent fail-loud, CDP click, skill inventory CI, 4.8.0 git release, **OMP native adapter landed (uncommitted)**

Scores = impact(1–5) × opportunity(1–5). Discard either factor ≤ 2.

## 1. Snapshot + page_text dump live input values (incl. passwords) — 20 (impact 5 × opportunity 4) [fixed]
Files: `packages/core/extension/background.js` `toolSnapshot` (~L2019–2023); in-page `getInputValues` / `getPageText` (~L1130–1193)
Evidence (reconfirmed):
- Snapshot: `node.value = el.value` for every visible INPUT/TEXTAREA — **no** `type === "password"` gate
- `getPageText` (query `page_text`) appends `getInputValues()` which joins **all** non-empty input values as `name: value` with no password mask
- High-frequency agent tools → secrets into model context / transcripts
- OMP/MCP/OpenCode all share this extension path unchanged
Handoff:
> Fix ONE scored target: stop leaking sensitive field values from browser_snapshot **and** page_text/getInputValues in packages/core/extension/background.js. Mask password/hidden secret inputs (omit or `[redacted]`); gate full values behind explicit flag if needed (default off for secrets). Acceptance: snapshot and page_text of `<input type=password value=secret>` never contain `secret`; normal buttons/links still work. One target only; report adjacent query property mode for re-scoring.

## 2. Network redaction incomplete (non-JSON / base64 / header edges) — 16 (impact 4 × opportunity 4) [fixed]
Files: `packages/core/extension/background.js` `redactHeaders` (~L358–377), `redactNetworkBody` (~L382–417), `toolNetworkGet` (~L2460–2469)
Evidence (reconfirmed; partial JSON fix already landed):
- Body scrub JSON-key-only; form-urlencoded / raw JWT / non-JSON pass through
- `base64Encoded: true` → skip scrub (`redacted: false`) at L2465
- Headers miss `x-amz-credential`, `x-session-id`, generic credential/session families
Handoff:
> Fix ONE scored target: harden network redaction (headers + form bodies + optional base64 decode then scrub). Unit-test pure helpers without Chrome. Acceptance: form body `password=x&access_token=y` and header `x-amz-credential` never leave tools verbatim. One target only.

## 3. Snapshot `uid` not an action handle — 16 (impact 4 × opportunity 4) [fixed]
Files: `packages/core/extension/background.js` snapshot uid (~L2008), `resolveLocator` (~L1041–1062); adapters selector-only
Evidence (reconfirmed):
- Emits `uid: eN` + lossy CSS; no `uid`/`ref` locator kind
- Click/type/press cannot target `e12` from snapshot
- Agent-backend plane still has separate `refs` map (plane inconsistency)
Handoff:
> Fix ONE scored target: make snapshot uids actionable (`uid=e12` / stamp `data-iris-uid` / per-tab map). Acceptance: snapshot → click by returned uid hits same element. Do not break CSS/label locators. One target only.

## 4. Publish-prep + monorepo release divergence (now includes omp) — 16 (impact 4 × opportunity 4) [open]
Files: `packages/{core,opencode,mcp,omp}/package.json`, `bun.lock`; tag `v4.8.0` @ `25066a5`
Evidence (updated):
- Tag still ships opencode `"@mizner/iris": "workspace:*"` as **runtime** dep
- Working tree publish-prep: adapters move bundled deps to **devDependencies**, `files`/`publishConfig` — **uncommitted**
- New `@mizner/iris-omp` untracked; publish order must become **core → opencode → mcp → omp** (omp bundles opencode)
- npm auth still missing on this machine
Handoff:
> Fix ONE scored target: land publish-prep + omp package on a PR (versions 4.8.0 or cut 4.8.1). Acceptance: `bun pm pack` / `bun publish --dry-run` registry-safe for core/opencode/mcp/omp; git matches publish artifacts; document order core→opencode→mcp→omp. No npm publish without auth. One target only.

## 5. No extension pure-logic unit harness — 12 (impact 3 × opportunity 4) [fixed] (network-redact module + tests; snapshot still injection-only)
Files: `packages/core/test/` (broker-only); root test now also skill + **omp load test** only
Evidence (updated):
- Still zero tests for `redactHeaders` / `redactNetworkBody` / snapshot masking / locators
- OMP load test proves adapter registration, **not** extension security helpers
Handoff:
> Fix ONE scored target: extract pure redaction (+ optional snapshot mask helpers) and add node:test coverage. Acceptance: `bun run test` fails if password masking or form-body redaction regresses. No full Chrome runner. One target only.

## 6. OMP adapter: AbortSignal not forwarded into Iris tools — 9 (impact 3 × opportunity 3) [fixed] (Promise.race in omp execute)
Files: `packages/omp/src/extension.ts` execute (~L246–251); `packages/opencode/src/plugin.ts` broker socket singleton
Evidence:
- OMP execute only checks `signal?.aborted` **before** `tool.execute`; does not abort in-flight broker request
- iris-opencode keeps module-level socket open (live-smoke requires `process.exit`)
- Cancelled OMP tool calls can still run to 60s broker timeout
Handoff:
> Fix ONE scored target: wire AbortSignal into broker request path used by OMP (or close/destroy request on abort). Acceptance: aborted `browser_wait` / long tool does not hold the turn for full broker timeout. One target only. Optional: document that short-lived scripts must exit explicitly because of open socket.

## Candidates (unscored / next sweep)
- Empty `profileEmails` allow-all — documented intentional; SECURITY.md still missing
- Agent-backend tool parity (~10 tools) — fail-loud; product work
- Zod structural converter in omp fails **entire** extension load on unknown arg type (brittle but correct fail-closed)
- Template skill vs packages/skill prose drift; CI only checks opencode↔skill tool names (not omp)
- MCP uncaughtException guard still absent
- Broker PPID 1 long-lived process (launchd already in reliability.md)
- CWS package path not re-validated

## Resolved (carry-forward + this session)
- keyboard/press, doctor STALE, default-tab (2026-07-09)
- network JSON scrub v1, plane labels, IRIS_FALLBACK=off, agent fail-loud, CDP click, skill CI (2026-07-10)
- 4.8.0 git tag/release (2026-07-10)
- **`@mizner/iris-omp` OMP extension** — 34 tools, schema rebuild, live plugin link, `/iris` commands (2026-07-15, uncommitted)

## Gate
Do **not** dispatch root-cause-fixer / Fable until a named target is approved in chat.
Recommended next: **#1 snapshot/page_text secrets** → **#2 network redaction** → **#3 uid** → **#4 land PR (publish-prep + omp)** → **#5 unit harness** → **#6 OMP abort** if cancellation pain shows up.
