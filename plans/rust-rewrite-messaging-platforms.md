# Plan: Rewrite messaging-platforms (selected shared pieces) from TypeScript to Rust (`src/`)

- Status: Draft
- Source: `packages/messaging-platforms/src/...` (61 files: `index.ts` + 29 × `adapter.ts` + 29 × `adapter.test.ts` + `registry.test.ts` + `vitest.config.ts`; adapters are ~75–80 lines / ~2.6–3.0 KB each)
- Target Rust: `src/...` — **none today**
- Author: analysis subagent
- Date: 2026-08-24

## 1. Executive summary

**Recommendation: do NOT rewrite `messaging-platforms` in Rust. The whole package stays in TypeScript.**

This is stated strongly and explicitly: after reading every file in the package, there is **no shared parsing/validation module, no real webhook signature verification, no message normalization, no rate limiting, no registry logic, and no CPU-heavy or security-sensitive pure logic** that would justify crossing the Tauri IPC boundary.

The package is a uniform set of **v1 stub adapters**, not a network/SDK integration layer. Every one of the 29 `adapter.ts` files is the same ~75–80 line class with:

- `connect()` / `disconnect()` — lifecycle stubs (`// v1: stubbed; real SDK/transport initialization goes here.`)
- `send*()` / `editMessage()` — fake message IDs built from an incrementing counter (`telegram_${counter}_${chatId}`), no HTTP I/O
- `normalizeUpdate(_update)` — placeholder returning `null` (all 29 adapters)
- `verifyWebhookSecret(payload, signature)` — 3-line placeholder `signature === this.config.webhookSecret` in the 14 adapters that have it (not constant-time, not platform-specific, uses no crypto)
- Per-adapter zod config schema whose field names differ (`botToken`, `appId`, `serverUrl`, `clientState`, …) but which is purely declarative validation with defaults

The only code-level differences between adapters are the config schema fields and the hard-coded platform string. There is no shared `types.ts`, no base class, no helper module, no crypto/HMAC usage, no HTTP client, no WebSocket code anywhere in the package (verified by grep: the only imports in all 29 adapters are `zod` and type-only imports from `@hermes/gateway-core`).

The established hot-path pattern in this repo (`src/state_db.rs`, `src/api_server/`, `src/subscription_proxy/`) applies when Rust already owns durable/privileged state or a hot loop. None of that is true here: the package has no state worth persisting, no hot path, no secret handling, and **no consumer** — `@hermes/messaging-platforms` is not imported by `web/`, `agent-core`, `agent-tools`, `dashboard`, or any other workspace (verified by grep; the only external references are docs/skills/sibling plans and a TanStack Query key string in `web/src/hooks/use-im-onboarding.ts` that targets the dashboard REST API, not this package).

## 2. Why rewrite (value/motivation; be honest)

The honest answer: **there is no value in rewriting today.**

Candidates considered and rejected, with evidence:

1. **Webhook signature verification** — the task listed this as a prime candidate. Reality: `verifyWebhookSecret` is a placeholder `signature === this.config.webhookSecret` in 14/29 adapters. It is neither platform-specific (no Telegram HMAC, no Slack `X-Slack-Signature`, no DingTalk/Feishu timestamp+sign, no WeCom `msg_signature` decrypt) nor constant-time. There is no real verification logic to move. The genuine defect (non-constant-time string compare on a secret) is a **one-line fix in TS** (`crypto.timingSafeEqual` or hash-then-compare), not a Rust port.
2. **Message normalization** — `normalizeUpdate` returns `null` in all 29 adapters; there is no normalization code to move.
3. **Shared parsing/validation** — the only validation is per-adapter zod schemas (~10 declarative lines each) with defaults. Rust already mirrors the config shape at the IPC boundary in `src/commands/messaging.rs` (`MessagingPlatformConfig`). Duplicating the zod schemas in Rust would add a second source of truth with zero functional gain.
4. **Rate limiting** — absent entirely (no token bucket, no counter, no queue).
5. **Registry logic** — `index.ts` is a static `export * from "./x/adapter.js"` list of 29 files; `registry.test.ts` only asserts the 29 `platform` ids are distinct. There is no dynamic registry, no lookup table, no dispatch logic.
6. **CPU-heavy or security-sensitive pure logic** — none exists. The only pure-ish logic is the trivial `content.type === "text" ? content.text : JSON.stringify(content.parts)` branch in `send`/`editMessage`.

What a rewrite would NOT buy (so it would be pure cost):

- **Latency/throughput**: no hot path exists; the stubs are memory-only counters.
- **Durability/state placement**: nothing is persisted today; there is no SQLite table to own (contrast `gateway-core`'s delivery ledger, where `src/state_db.rs` already owns the `sessions` table — see `plans/rust-rewrite-gateway-core.md`).
- **Security placement**: no secrets are processed here; the config control plane already lives in Rust (`src/commands/messaging.rs`), and its docblock states live bot connections remain in the Core managed runtime.
- **Correctness parity**: nothing algorithmic to preserve byte-for-byte (contrast `gateway-core`'s `sessionIdFromKey` 31-multiplier hash).

The task premise ("adapters are predominantly network/SDK integrations with HTTP I/O") does **not** match the current source: they are stub surfaces. That strengthens the conclusion — when real transport code lands later, it should be added as TS network/SDK code (per `docs/typescript-runtime.md`), not pre-emptively placed in Rust.

## 3. Scope

### In-scope

- **None for Rust.** This plan intentionally proposes no source changes and no new `src/` modules.
- The only actionable item is a TS-side security hardening of the placeholder `verifyWebhookSecret` (constant-time compare) — tracked here as P0 so the defect is not lost, but it is a TS edit, not a Rust rewrite.

### Out-of-scope (keep TS — all 29 adapters, explicitly)

`bluebubbles`, `buzz-nostr`, `dingtalk`, `discord`, `email`, `feishu-lark`, `google-chat`, `hermes-relay`, `homeassistant-messaging`, `irc`, `line`, `matrix`, `mattermost`, `msgraph-webhook`, `ntfy`, `photon`, `qqbot`, `raft`, `signal`, `simplex`, `slack`, `sms-twilio`, `teams`, `telegram`, `webhooks`, `wecom`, `weixin`, `whatsapp`, `yuanbao`.

Also out of scope:

- `packages/gateway-core/src/adapter.ts` — canonical TS contract types (`PlatformAdapter`, `InboundMessageEvent`, `OutboundContent`, `SendMeta`, `SendResult`, `PlatformStatus`) stay TS; they are the type source for the 29 adapters (see sibling plan `rust-rewrite-gateway-core.md` §3).
- `src/commands/messaging.rs` — the Rust control plane (`get_messaging_platforms`, `get_messaging_status`, `set_messaging_platform_config`, `start_messaging_platform`, `stop_messaging_platform`) already exists and stays as-is.
- Any new external crate (single-crate rule from AGENTS.md).

## 4. Current contract

**Exports** (`src/index.ts`): static re-exports of all 29 `./<platform>/adapter.js` modules. Each module exports `<x>ConfigSchema` (zod) + `<x>Adapter` class implementing `PlatformAdapter`.

**Contract types** come from `@hermes/gateway-core/src/adapter.ts` (imported type-only by every adapter):

- `interface PlatformAdapter`: `platform`, `status`, `connect()`, `disconnect()`, `send(chatId, content, meta?)`, `sendDocument(chatId, path, meta?)`, `sendImageFile(chatId, path, meta?)`, `sendTyping(chatId)`, `editMessage(chatId, messageId, content)`, `typedCommandPrefix()`.
- Shared zod schemas there: `platformStatusSchema`, `messagePartSchema`, `inboundMessageEventSchema`, `sendResultSchema`, `sendMetaSchema`, `outboundContentSchema`.
- Note: `verifyWebhookSecret` and `normalizeUpdate` are **not** part of the `PlatformAdapter` interface — they are extra per-adapter methods (14 adapters have the former, all 29 have the latter).

**Invariants** (verified by reading):

- 29 distinct `platform` strings (`registry.test.ts` asserts uniqueness).
- `connect()` when `enabled === false` leaves status `"idle"`; otherwise flips `connecting → running`; `disconnect()` sets `"stopped"`.
- `send`/`editMessage` return `{ ok: true, messageId: "<platform>_<counter>_<chatId>" }` / `{ ok: true, messageId }` — stub IDs, never network calls.
- `verifyWebhookSecret` returns `true` when `webhookSecret` is unset, else `signature === webhookSecret` (non-constant-time).
- `normalizeUpdate` always returns `null`.

**Consumers**: none outside the package's own tests (verified by repo-wide grep). Dependency direction is `gateway-core` ← `messaging-platforms` (this package imports gateway-core types; nothing imports this package).

**Rust already in place** (reuse, don't duplicate): `src/commands/messaging.rs` (203 lines, `#[cfg(test)]` unit tests) owns platform definitions, config round-trip and start/stop lifecycle; `web/src/hooks/use-im-onboarding.ts` talks to the dashboard REST API `/api/messaging/platforms`, not to this TS package.

## 5. Rust design

Not applicable for the recommended scope. For completeness, if a future phase ever qualifies (see §7 P1+ triggers), the shape would follow the established pattern — new `src/messaging/` module in the existing `hermes_agent_cn` crate with serde `camelCase` structs mirroring the zod schemas, a `src/commands/messaging_core.rs` with narrow `#[tauri::command]`s registered in `main.rs` `generate_handler!`, and a dual-path TS shim for browser-only dev. Nothing in the current source justifies building this now; documenting the shape avoids re-deriving it later.

## 6. IPC / boundary

- No new Tauri commands are needed. The messaging **control plane** (config/status/start/stop) already lives in Rust via `src/commands/messaging.rs`, and the **adapter plane** stays TS in the webview.
- CRITICAL constraint honored: browser-only dev (`python run.py`) runs the same TS runtime with **no Rust at all**. Since nothing moves, `run.py` keeps working unchanged — no shim or fallback is required.
- If P1+ triggers ever land real Rust adapters/verifiers, the sibling plan's dual-path rule applies: every Rust-moved function must keep a TS twin selected only when Tauri is absent (`runtime.isLocalOnly()` / `hermesDesktop` presence); never break browser-only dev.

## 7. Implementation phases

Ordered, each shippable + testable (note: all are TS-side or no-op; none are Rust ports):

1. **P0 — Fix the real defect in TS (recommended, ~S).** Make the 14 `verifyWebhookSecret` placeholders constant-time (`crypto.timingSafeEqual` over hashed/utf8 bytes) or delegate to a small shared helper. Add a vitest that asserts no early-exit on length mismatch. *Exit: `pnpm test:unit` + `pnpm typecheck` green; behavior unchanged for unset secrets (still returns `true`).*
2. **P1 — Revisit only when real transport lands.** When any adapter grows real platform webhook/signature verification, message normalization, or rate limiting, evaluate that *specific* pure function for Rust with the sibling plan's criteria (durability/security placement/hot path). Likely verdict stays TS: verification/normalization are per-platform and chat-volume I/O-bound, and Rust IPC round-trips add latency without moving state.
3. **P2 — (Future, gated) Rust `src/messaging/` module** only if a Rust-owned gateway/transport becomes the end-state (§5 shape). Do not start without a consumer; there is none today.

## 8. Testing strategy

- **Keep existing vitest suites** (`pnpm test:unit`): the 29 adapter tests + `registry.test.ts` are the contract; they run headless and will stay green because nothing is rewritten.
- **No Rust unit/integration tests** are planned — there is no Rust code to test.
- **P0 only**: add/extend adapter tests asserting constant-time `verifyWebhookSecret` behavior (matching and non-matching secrets, unset-secret short-circuit). No wiremock/TempDir needed.
- **Parity harness (not needed now)**: the golden-vector TS↔Rust parity pattern from `plans/rust-rewrite-gateway-core.md` §8 applies **only if** P1/P2 ever moves real logic; it is intentionally omitted today because there is no algorithmic logic to pin.

## 9. Risks & mitigations

- **Over-eager port = dead, unowned code.** The package has no consumer; a Rust mirror would be a second implementation of stubs. Mitigation: this plan ships no port; any future port must be gated on a real consumer (P2 gate).
- **Stub-vs-network premise mismatch.** If the team assumes these are live integrations, they may over-estimate rewrite value. Mitigation: this plan documents the stub reality and its evidence (§1, §2).
- **Non-constant-time secret compare (real, current risk).** `signature === webhookSecret` is a timing side-channel if it is ever used with real secrets. Mitigation: P0 TS fix (constant-time compare), tracked in §7.
- **IPC latency for chat I/O.** If real adapters were Rust-backed via IPC, every inbound webhook/send would round-trip the webview boundary. Mitigation: keep transport/send in TS; only move pure per-message logic if a consumer appears (P1 gate).
- **Dual-path divergence (browser vs Tauri).** Only relevant if P1/P2 proceeds; reuse the sibling plan's shim + fallback rule (§6) and add a vitest that runs the headless suite under the browser-only selection.

## 10. Effort estimate (S/M/L per phase)

- P0 TS constant-time fix: **S** (0.5–1 day incl. tests).
- P1 future per-function evaluation: **S** per candidate (analysis only; likely stays TS).
- P2 Rust `src/messaging/` module: **L if attempted now** — do not start without a consumer; only then re-estimate.
- **Total for the recommended plan: no Rust effort; P0 only ≈ 1 dev-day (TS).**

Cross-references: sibling plan `plans/rust-rewrite-gateway-core.md` already concluded the 29 adapter implementations stay TS (its §3 out-of-scope); this plan agrees, and adds the direct evidence that the adapters are v1 stubs with no moveable pure logic. The existing `src/commands/messaging.rs` control plane and `docs/typescript-runtime.md` conventions remain authoritative for the boundary.
