# Plan: Rewrite browser (selected pieces) from TypeScript to Rust (`src/`)

- Status: Draft
- Source: `packages/browser/src/...`
- Target Rust: `src/browser/...` (+ shared `src/security/url.rs`)
- Author: analysis subagent
- Date: 2026-08-24

## 1. Executive summary

`packages/browser` (measured 15 TS files, ~85.5 KB total; ~40 KB non-test
source) is the in-process browser-automation runtime that runs **inside the
webview** and must keep working with **zero Rust** in browser-only dev mode
(`python run.py`). Most of the package is a thin TS seam over the existing
Rust command surface (`src/commands/browser.rs` already registers 18
`browser_*` commands; `web/src/lib/browser/tools.ts` binds them to Tauri IPC).
The actual browser automation (Chrome DevTools Protocol) is network I/O that
stays in the Rust sidecar; the TS `LocalBrowserProvider` is a pure forwarder.

Only two pieces genuinely benefit from a Rust rewrite:

1. **SSRF / URL-safety guard (`src/ssrf.ts`, ~5.5 KB)** — the strongest
   candidate. It is security-sensitive URL parsing/validation with a pure
   function surface and a complete vitest suite. Rust already has the same
   class of guard in `src/commands/api_proxy.rs`
   (`is_blocked_external_ip`, `validate_external_url_shape`) and
   `src/commands/context_refs.rs` (`validate_ip`), but there is **no shared
   module** — each command re-implements it. Moving the browser guard to a
   shared `src/security/url.rs` (or `src/browser/ssrf.rs`) and wiring it into
   `commands/browser.rs` gives a single authoritative defense-in-depth check at
   the IPC boundary, closes TS-only gaps (no DNS-rebinding protection,
   string-suffix checks only), and lets `api_proxy` / `context_refs` /
   `browser` share one implementation.
2. **Snapshot formatting / truncation (`src/snapshot.ts`, ~3.7 KB)** — pure
   recursive DOM-accessibility-tree formatter (`@e1` refs, indentation, ignore
   roles, truncation + overflow storage). Moderate value: it is per-snapshot,
   not a hot loop, but it is the kind of CPU/string work that is faster and
   more testable in Rust, and it will be needed in the Rust sidecar when the
   real CDP snapshot pipeline lands. It is an easy, low-risk port with a full
   vitest suite to reuse as parity vectors.

Everything else stays TS: the provider interface (`provider.ts`), backend
registry (`registry.ts`), session manager (`session-manager.ts`), backends
(`backends/local.ts`, `backends/cloud.ts`), tool handlers
(`tool-handlers.ts`) and zod schemas (`schemas.ts`) are either the TS closure
seam (`tool-handlers` are imported as TS handlers by
`packages/agent-tools/src/catalog.ts`), trivial bookkeeping, or stubs whose
real capability already lives in Rust commands.

Recommended Rust scope (priority order):

1. `src/security/url.rs` — shared SSRF guard (port of `ssrf.ts` +
   consolidation of `api_proxy.rs` / `context_refs.rs` helpers); wire into
   `commands/browser.rs::browser_navigate` and the future sidecar boundary.
2. `src/browser/snapshot.rs` — accessibility-tree formatter + truncation;
   used by Rust snapshot commands; TS keeps a mirror for browser-only dev.
3. (Optional / parity) `src/browser/registry.rs` — the 4-step backend
   precedence algorithm as a pure function for single-source-of-truth
   testing; low runtime value.

## 2. Why rewrite (value/motivation, quantified where possible; be honest)

- **SSRF guard (real security value; today the TS guard is weaker than the
  Rust one).**
  - `ssrf.ts` is a string/hostname-only checker: `isPrivateHost` does prefix
    matching on `127.`, `10.`, `192.168.`, `172.16-31.`, `fc00:`/`fe80:`
    plus `.localhost`/`.local` suffixes. It does **not** resolve DNS, so a
    public hostname that resolves to a private IP (DNS-rebinding / internal
    service) passes. It does not handle decimal/octal IPv4 literals, userinfo,
    or IPv4-mapped IPv6 comprehensively.
  - `commands/api_proxy.rs` already has the stronger Rust version
    (`is_blocked_external_ip` covers `is_private`, `is_loopback`,
    `is_link_local`, `is_broadcast`, `is_unspecified`, `100.64/10` CGNAT,
    `fc00::/7` ULA, `fe80::/10` link-local, IPv4-mapped IPv6) plus
    **async DNS-resolution validation** (`validate_external_url`). Today the
    browser path does not use it: `browser_navigate` in Rust is a stub and the
    TS `LocalBrowserProvider::navigate` calls `assertSafeUrl` in JS before
    forwarding.
  - Value: one authoritative guard at the IPC boundary that the Rust side
    enforces even if the webview is compromised or a TS bug/regression lets an
    unsafe URL through; closing the DNS-rebinding gap for browser navigation.
  - Honest caveat: the guard runs once per navigation, so CPU is irrelevant —
    the value is **defense-in-depth + single source of truth**, not speed.
- **Snapshot formatting (modest CPU + parity win).**
  - `formatSnapshot` is recursive string building over a possibly large
    accessibility tree (hundreds/thousands of nodes). JS is fine but slower;
    Rust string building is typically several× faster and avoids creating many
    intermediate arrays. It runs once per snapshot call, so this is a
    **perception/latency** win, not a throughput win.
  - The bigger architectural value: when `browser_snapshot` is implemented in
    the Rust sidecar (real CDP work), the formatter should live next to the
    sidecar so the full a11y tree never crosses the IPC boundary as an
    intermediate structure. Today the TS `prepareSnapshot` even writes
    overflow files via a callback — in desktop mode that file write should be
    Rust-owned (`browser_snapshot` command), not webview-owned.
  - Honest caveat: `prepareSnapshot`/`formatSnapshot` have **no live consumer
    today** beyond the tool handlers and tests (grep: only `browser/` files
    import them), because `browser_snapshot` is a Rust stub returning
    `not_implemented`. The port is cheap and future-proofing, not an
    immediate user-visible win.
- **Registry precedence (parity only).**
  - `registry.ts` `resolve()` encodes the Core precedence (CDP override →
    configured backend → legacy walk `browser-use → browserbase → camofox` →
    local fallback) with `reason` strings. It is 88 lines, runs once per
    session creation, and depends on async `provider.isAvailable()`, so Rust
    cannot own the registry object itself. A pure `resolve_backend` mirror is
    for testable parity with `agent/browser_registry.py`; low urgency.
- **Everything else:** no value — `provider.ts`/`backends/*` are the TS seam
  over Rust IPC; `session-manager.ts` is a trivial Map + expiry that the Rust
  sidecar milestone will supersede; `tool-handlers.ts` must stay TS because
  `packages/agent-tools/src/catalog.ts` registers the exported functions as
  TS handler closures (verified import list at `catalog.ts:11-27`); `schemas.ts`
  zod validation is the TS tool-arg authority and only needs serde mirrors at
  the IPC boundary (several already exist in `commands/browser.rs`).

## 3. Scope (in-scope / out-of-scope)

### In-scope (Rust rewrite / mirror)
| TS module | Rust target | What moves |
|---|---|---|
| `src/ssrf.ts` | `src/security/url.rs` (new shared module; or `src/browser/ssrf.rs` if sharing is deferred) | `normalize_url_for_request`, `is_always_blocked_url`, `evaluate_url_safety`, `assert_safe_url`, `redact_cdp_url`; plus DNS-resolution variant (from `api_proxy.rs::validate_external_url`) |
| `src/snapshot.ts` | `src/browser/snapshot.rs` (new module `src/browser/mod.rs`) | `format_snapshot`, `prepare_snapshot`, `count_interactive_elements`, thresholds/constants, overflow-store callback → Rust file write |
| `src/registry.ts` (algorithm only) | `src/browser/registry.rs` (optional phase) | Pure `resolve_backend(config, cdp_url, configured, availability_map)` returning `(kind, reason)` — TS registry stays the owner of provider objects |
| `src/schemas.ts` (types only) | `src/browser/types.rs` | Serde mirrors of `BrowserConfig`, `BrowserSessionRecord`, `BrowserToolResult` (aligns with existing `commands/browser.rs` serde structs) |

### Out-of-scope (stay TS; reasons)
- `src/provider.ts` — pure interface + result types; the TS contract for
  provider implementations. Keep TS.
- `src/backends/local.ts` — thin `invoke()` forwarder to existing Rust
  commands (`browser_sidecar_start`, `browser_navigate`, …). Keep TS; its
  command list is the contract for the Rust side.
- `src/backends/cloud.ts` — stubs (Browserbase / Browser Use / Firecrawl /
  Camofox) with env-availability checks; no real logic. Keep TS until a real
  cloud implementation exists (then it is a network SDK, still TS).
- `src/session-manager.ts` — in-memory Map + inactivity expiry (~70 lines).
  Trivial; the real session registry belongs to the Rust sidecar milestone
  (`browser_sidecar_start` already returns `sessionName`). Revisit when the
  sidecar owns sessions — not as a standalone port.
- `src/tool-handlers.ts` — TS closure seam consumed by
  `agent-tools/src/catalog.ts`; Rust cannot hold TS handlers. Keep as the
  orchestrator, but have it delegate the safety check and snapshot formatting
  to the new Rust commands (it already forwards via `ctx.invoke`).
  `zodToJsonSchema`/`objectSchema` should delegate to the shared
  `src/toolkit/schema.rs` proposed by the agent-tools plan (cross-cutting).
- `src/schemas.ts` (zod runtime) — TS authority for tool-arg validation; keep
  zod. Rust gets serde mirrors only at the IPC boundary.
- Actual CDP / Playwright automation — network I/O, stays in the Rust
  sidecar (`src/commands/browser.rs` + future sidecar process); out of this
  plan's scope but this plan prepares its safety/formatter building blocks.

## 4. Current contract (TS exports, types, consumers, invariants)

### Entry point
- `packages/browser/src/index.ts` re-exports: `schemas`, `provider`,
  `registry`, `ssrf`, `snapshot`, `session-manager`, `tool-handlers`, plus
  `LocalBrowserProvider` and the four cloud providers.
- `package.json`: `@hermes/browser`, `main/types = ./src/index.ts`, deps on
  `@hermes/protocol` and `zod`.

### Key exports and live consumers (verified)
| Export | Consumers |
|---|---|
| `browserNavigate`, `browserSnapshot`, `browserClick`, `browserType`, `browserScroll`, `browserBack`, `browserPress`, `browserConsole`, `browserGetImages`, `browserVision`, `browserCdp`, `browserDialog`, `browserExec`, `browserToolSchemas`, `objectSchema` | `packages/agent-tools/src/catalog.ts:11-27,624-…` — registered as tools `browser_navigate` … with `credentialGates.browser` gate |
| `BrowserToolContext` / `BrowserInvoker` | `packages/agent-tools` tool handler signature; `web/src/lib/browser/tools.ts` builds the context with `browserInvoker` bound to Tauri IPC (`browser_sidecar_start`, `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_scroll`, `browser_back`, `browser_press`, `browser_console`, `browser_get_images`, `browser_vision`, `browser_cdp`, `browser_dialog`, `browser_exec`, `browser_cdp_probe`, `browser_launch_chrome_debug`, `browser_event_subscribe`, `browser_sidecar_stop`) |
| `evaluateUrlSafety`, `assertSafeUrl` | `backends/local.ts` (`navigate`) and re-exported via `index.ts` |
| `formatSnapshot`, `prepareSnapshot`, `SNAPSHOT_SUMMARIZE_THRESHOLD` | `snapshot.test.ts`, `tool-handlers` result path (Rust stub returns `snapshot` string today) |
| `BrowserSessionManager`, `browserSessionManager` | `tool-handlers.ts` (per-session `getOrCreateSession`) |
| `BrowserProviderRegistry`, `browserRegistry` | `tool-handlers.ts` (per-context registry built in `browserRegistryForContext`) |
| zod schemas (`BrowserConfig`, `BrowserSessionRecord`, tool inputs) | every tool handler; `agent-tools` tool registration schemas via `browserToolSchemas` |

### Invariants
1. **Browser-only dev must work with no Rust.** Every Rust-backed feature
   needs a TS fallback mirror; TS remains the runtime authority in
   `python run.py`.
2. **The tool-handler entry points are TS closures** registered in
   `agent-tools/src/catalog.ts`; Rust never re-implements the dispatch seam.
3. **Desktop mode flows through `web/src/lib/browser/tools.ts` →
   Tauri invoke → `src/commands/browser.rs`.** The TS `LocalBrowserProvider`
   command names must keep matching the registered Rust commands
   (`main.rs:852-871`).
4. **SSRF semantics must be stable** (golden vectors): block
   `file/ftp/sftp/gopher/dict/ldap/ldaps`; block `metadata.google.internal`,
   `169.254.169.254`; block private/loopback by default; allow via
   `allowPrivateUrls` or `allowedHosts`; `normalizeUrlForRequest` collapses
   `.`/`..` path segments; `redactCdpUrl` never leaks token-bearing path
   segments or `token|key|secret|auth|password` query params.
5. **Snapshot semantics:** Python-compatible `@e1` refs; ignore roles
   `none/generic/presentation/separator/scrollbar`; indent 2 spaces per depth;
   truncate at `maxChars` (default 15 000) with a `... snapshot truncated (N
   chars, M elements)` footer; overflow persisted only when `storeOverflow`
   provided and `<= 1 000 000` chars.
6. **Registry precedence order** (mirrors `agent/browser_registry.py`):
   CDP URL override → configured backend → legacy walk
   (`browser-use` → `browserbase` → `camofox`) → local fallback → throw
   "No browser provider is available".

## 5. Rust design (module layout, public API, serde types, state handling)

### Module layout (single crate; add modules to `src/lib.rs`)
```
src/
├── lib.rs                     # add: pub mod security; pub mod browser;
├── security/                  # SHARED home (browser, api_proxy, context_refs all use it)
│   ├── mod.rs                 # pub use url::*;
│   └── url.rs                 # SSRF guard (port of ssrf.ts + api_proxy.rs consolidation)
└── browser/
    ├── mod.rs                 # pub use snapshot::*; pub use registry::*;
    ├── types.rs               # serde mirrors (align with commands/browser.rs structs)
    ├── snapshot.rs            # a11y tree formatter + truncation
    └── registry.rs            # (optional) pure resolve_backend precedence algorithm
```
`src/commands/browser.rs` calls `crate::security::url` before acting (and the
new shared module replaces its local `is_loopback` and future URL checks).
`commands/api_proxy.rs` and `commands/context_refs.rs` are refactored to call
the same `security::url` helpers (see Risks — behavior must stay identical).

### Public Rust API
```rust
// src/security/url.rs — sync (shape) + async (DNS) variants
pub struct UrlSafetyResult { pub safe: bool, pub normalized_url: String, pub reason: Option<String> }
pub struct SsrfOptions<'a> { pub allow_private_urls: bool, pub allowed_hosts: &'a [String] }

pub fn normalize_url_for_request(raw: &str) -> String;          // collapse . / .., trim
pub fn is_always_blocked_url(raw: &str) -> bool;                // schemes + metadata hosts
pub fn evaluate_url_safety(raw: &str, opts: &SsrfOptions) -> UrlSafetyResult;
pub fn assert_safe_url(raw: &str, opts: &SsrfOptions) -> Result<String, AppError>; // error msg "Unsafe URL: {reason}"
pub fn redact_cdp_url(raw: &str) -> String;                     // path-segment + sensitive-query redaction
pub fn is_blocked_external_ip(ip: std::net::IpAddr) -> bool;    // moved from api_proxy.rs (same body)
pub async fn validate_external_url(raw: &str) -> Result<url::Url, AppError>; // DNS-resolution guard (moved/consolidated)
```
```rust
// src/browser/snapshot.rs — pure sync
pub const SNAPSHOT_SUMMARIZE_THRESHOLD: usize = 15_000;
pub const MAX_STORED_SNAPSHOT_CHARS: usize = 1_000_000;

#[derive(serde::Deserialize)] #[serde(rename_all = "camelCase", default)]
pub struct AccessibilityNode { pub role: Option<String>, pub name: Option<String>,
                               pub value: Option<String>, pub children: Vec<AccessibilityNode>,
                               pub r#ref: Option<String> }
pub struct FormattedSnapshot { pub text: String, pub element_count: usize,
                               pub truncated: bool, pub overflow_path: Option<String> }
pub fn format_snapshot(root: &AccessibilityNode) -> String;
pub fn count_interactive_elements(root: &AccessibilityNode) -> usize;
pub fn prepare_snapshot(root: &AccessibilityNode, max_chars: Option<usize>,
                        overflow_writer: Option<&dyn Fn(&str) -> std::io::Result<Option<String>>>)
    -> std::io::Result<FormattedSnapshot>; // sync; async variant only if a Tokio file write is needed
```
```rust
// src/browser/types.rs — serde mirrors (camelCase to match commands/browser.rs)
pub struct BrowserConfig { pub backend: BrowserBackendKind, pub cdp_url: Option<String>,
                           pub command_timeout: u32, pub headed: bool, /* … */ }
pub struct BrowserSessionRecord { pub task_id: String, pub backend: BrowserBackendKind, /* … */ }
```
Note: `commands/browser.rs` already defines `BrowserToolResult` and the
sidecar input/output structs with `#[serde(rename_all = "camelCase")]`; keep
those as the IPC types and make `browser/types.rs` import/reuse them rather
than duplicating.

### State handling
- The SSRF guard and snapshot formatter are **stateless**; no `AppState`
  changes needed.
- If/when the browser session registry moves to Rust (sidecar milestone),
  add `browser_sessions: HashMap<String, BrowserSessionRecord>` or a
  dedicated `BrowserRegistry` handle to `AppStateInner`
  (`src/state.rs:226-279`), behind the existing `Mutex<AppStateInner>` —
  same pattern as `mcp_stdio_children` / `api_server` / `subscription_proxy`.
- This plan does **not** add new external crates: `url` (already a
  dependency) provides parsing/host/IP types; no new crate is needed for the
  SSRF/snapshot work.

## 6. IPC / boundary (Tauri commands; browser-only-dev fallback strategy)

### Tauri commands (add to `src/commands/browser.rs`, register in `main.rs` `generate_handler!`)
- Wire the guard into the existing surface (no new command names required):
  - `browser_navigate` (already registered, currently `not_implemented`) →
    first call `security::url::assert_safe_url(url, allow_private=false)` /
    `validate_external_url(url)`, reject with `AppError::InvalidRequest`
    before any sidecar work.
  - `browser_snapshot` → when implemented, call
    `browser::snapshot::prepare_snapshot` on the sidecar a11y tree and write
    overflow to the cache dir via a Rust-owned path (`storeOverflow`
    equivalent), returning `BrowserToolResult { snapshot, … }`.
- Optional new command if TS parity tooling wants it:
  - `browser_url_safety_check(url, allow_private_urls, allowed_hosts) ->
    UrlSafetyResult` (thin wrapper for tests + browser-only-dev bridge; not
    required for production flow).

### Browser-only-dev fallback
- Keep `packages/browser/src/ssrf.ts` and `src/snapshot.ts` as the TS mirror
  (they already exist and are fully tested). In `python run.py` the tool
  handlers use the TS versions; in desktop mode the Rust command re-validates
  at the boundary. Parity is enforced by golden-vector tests (Section 8).
- The TS `tool-handlers.ts` stays the dispatcher in both modes; desktop mode
  simply means `ctx.invoke` is bound to Tauri IPC (`web/src/lib/browser/tools.ts`).

## 7. Implementation phases (ordered, each shippable + testable)

### Phase 1 — Shared SSRF guard in Rust (L)
1. Create `src/security/mod.rs` + `src/security/url.rs`; port
   `ssrf.ts` functions 1:1 (sync shape checks) with `url` crate.
2. Move/consolidate `is_blocked_external_ip` + `validate_external_url` from
   `commands/api_proxy.rs` into `security/url.rs`, re-exporting from
   `api_proxy.rs` to keep `commands` callers unchanged.
3. Wire `browser_navigate` to `assert_safe_url` (sync) + `validate_external_url`
   (async DNS) before forwarding.
4. Unit tests inline (`#[cfg(test)]`) for every ssrf.ts test case + extra
   Rust-only cases (IPv4-mapped IPv6, decimal IP, DNS-rebinding via
   `tokio::net::lookup_host` mock — see testing).
5. Refactor `context_refs.rs::validate_ip` to reuse shared helpers (behavior
   identical; keep `AppError::InvalidRequest` messages).
   Shippable: cargo test + vitest parity green; no behavior change to
   `api_proxy`/`context_refs` (golden tests lock it).

### Phase 2 — Snapshot formatter in Rust (M)
1. Create `src/browser/mod.rs` + `types.rs` + `snapshot.rs`; port
   `formatSnapshot` / `countInteractiveElements` / `prepareSnapshot`.
2. Add unit tests mirroring `snapshot.test.ts` (refs, indentation, ignore
   roles, truncation footer, overflow threshold).
3. Add a Tauri command path: when `browser_snapshot` is implemented, use it;
   until then expose `browser_snapshot_format` (or keep the Rust module
   internal with only unit tests) — decide at implementation time based on
   whether TS parity tests need IPC.
4. Wire TS parity: add vitest parity test that runs the same golden trees
   through the Rust formatter (via the new command or a helper binary) and
   asserts byte-identical output.
   Shippable: formatter + tests; no user-visible change until the sidecar
   snapshot pipeline consumes it.

### Phase 3 — (Optional) Registry precedence parity (S)
1. Port the 4-step precedence algorithm to `src/browser/registry.rs` as a
   pure `resolve_backend(kind, availability: &[bool]) -> (kind, reason)`.
2. Unit tests mirroring `registry.test.ts` cases; TS `registry.ts` optionally
   delegates to the Rust command in desktop mode (not required).
   Shippable: parity tests only.

### Phase 4 — Sidecar snapshot/session integration (future, out of scope)
- When the real CDP sidecar lands, make `browser_snapshot` /
  `browser_sidecar_start` own the formatter + session registry in Rust and
  shrink `session-manager.ts` / `backends/local.ts` to pure callers.

## 8. Testing strategy (Rust unit/integration with wiremock/tempfile; TS↔Rust parity; vitest parity tests)

- **Rust unit tests** (`#[cfg(test)] mod tests` in each new file):
  - `security/url.rs`: port every `ssrf.test.ts` assertion (blocked schemes,
    metadata host, loopback/private IPv4 ranges, `.local`, allowed-hosts,
    `allow_private_urls`, path-collapse, redaction no-leak, invalid URL).
  - `browser/snapshot.rs`: port every `snapshot.test.ts` assertion (refs,
    indentation, ignored roles, truncation footer, overflow store).
  - `browser/registry.rs`: port `registry.test.ts` precedence cases.
- **Rust integration tests** (`tests/` at repo root, `hermes_agent_cn` crate):
  - DNS-rebinding guard: `wiremock::MockServer` for an HTTP target is not
    needed (no network) — use `#[serial_test::serial]` with a stub
    `lookup_host` seam if feasible; otherwise test `validate_external_url`
    against `localhost`/loopback literals and a `TempDir`-based unit seam.
    Keep CI closed (no real network).
  - Snapshot overflow: `tempfile::TempDir` for the overflow writer path; assert
    the file is written and the returned path is inside the temp dir (never
    `/tmp` or cwd).
- **TS↔Rust parity (golden vectors):**
  - Shared fixture files (e.g. `tests/fixtures/ssrf_cases.json`,
    `tests/fixtures/snapshot_trees.json`) read by both vitest and Rust tests;
    assert identical outputs.
  - Vitest parity tests in `packages/browser/src/*.parity.test.ts` that call
    the new Tauri command (skipped when no Rust, matching existing env-gated
    test conventions) and compare against the TS implementation.
- **Required commands before done:** `pnpm typecheck`, `pnpm test:unit`
  (browser workspace), `cargo fmt --check`, `cargo clippy -D warnings`,
  `cargo test --all-features` (per AGENTS.md).

## 9. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| URL parsing differences: Rust `url` crate vs WHATWG `URL` (e.g. punycode, default ports, `URL.toString()` trailing slash) | Parity test failures; subtle behavior drift for users | Lock behavior with golden vectors; normalize through `url` crate then apply TS-compatible string rules (`url.to_string()`); where semantics differ, keep the TS mirror authoritative and document the delta |
| Refactoring `api_proxy.rs`/`context_refs.rs` to shared helpers changes existing egress behavior | Regressions in `external_request` / context-refs fetch | Keep function bodies identical when moving; add/keep existing Rust unit tests for both; run `cargo test --all-features` before/after |
| SSRF guard at IPC adds latency to every `browser_navigate` (DNS lookup) | Per-nav overhead | DNS check only for non-loopback domain hosts (same as `validate_external_url`); cache negative results if needed; keep sync shape check first as fast path |
| Snapshot formatter port drifts from TS (ref numbering, ignore roles, truncation footer) | Tool output mismatch in browser-only vs desktop | Shared golden-tree fixtures + vitest parity tests; keep TS mirror until Rust sidecar consumes the formatter |
| Credential/secret-bearing URLs logged in new Rust errors | Secret leak in logs | Use `redact_cdp_url` before logging errors; never include raw URL in `AppError` messages |
| `browser_navigate` currently returns `not_implemented`; wiring the guard before sidecar work makes the stub stricter | Temporary UX change for the stub path | Acceptable: guard rejection is correct even for stubs; document in PR |
| New `src/browser/` module added to `lib.rs` grows crate compile surface | Compile time | Modules are small; no new crates needed |

## 10. Effort estimate (S/M/L per phase)

| Phase | Effort |
|---|---|
| P1 Shared SSRF guard (`src/security/url.rs` + wire into `browser_navigate`, refactor `api_proxy`/`context_refs`) | L |
| P2 Snapshot formatter (`src/browser/snapshot.rs` + parity) | M |
| P3 Registry precedence parity (`src/browser/registry.rs`) | S |
| P4 Sidecar snapshot/session integration (future) | L (separate milestone) |
