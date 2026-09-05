# WanderMemory Frontend Merge Decision

> Decision document for merging the WanderMemory (MemOS) web frontend into the
> Hermes Agent CN Desktop frontend. Written during Phase 0 of
> `implement_memory_to_hermes.md`; updated with final decisions at the end.

## 1. Backend Target

- [x] MemOS (ports 18400/18401/18402 — auto-shift when occupied, see Appendix L)
- [ ] Hermes-CN-Core (port 9120)
- [x] Hybrid / adapter (MemOS first, Hermes later)

**Decision:** Hybrid with the **MemOS adapter first** (plan Option 3, default path).
The `WanderMemoryClient` interface in `web/src/lib/wander-memory/client.ts` is
backend-agnostic; a future `HermesWanderMemoryClient` can implement the same
interface without touching any view. Phase 8 (Hermes-native adapter + Rust
commands) is documented future work and is **not** implemented in this pass.

**Rationale:** MemOS is the source system with feature parity; the adapter
interface isolates backend choice. Hermes-CN-Core stays the *test backend* for
Hermes integration coverage (real-backend tests), while MemOS serves as the
real backend for the WanderMemory client/views.

## 2. Visual Direction

- [x] Follow global Hermes theme (light/dark tokens)
- [ ] Dark enclave for WanderMemory routes only

**Decision:** Follow the global Hermes theme with CSS Modules + design tokens.
No dark enclave; no Tailwind; no gradients/shadows (they are stripped by
`web/src/styles/global.css` anyway).

**Rationale:** project convention (CSS Modules + tokens), minimal visual risk,
theme switch support out of the box.

## 3. Views to Port

| View | Route | Priority | Notes |
|------|-------|----------|-------|
| Memories | /wander-memory/memories | P0 | Core feature (search/list/add/delete) |
| Chat | /wander-memory/chat | P0 | Streaming chat via WS |
| Files | /wander-memory/files | P1 | File-system ingest (MemOS FS API) |
| Dialogue | /wander-memory/dialogue | P1 | Transcript import |
| Context | /wander-memory/context | P1 | Prompt preview |
| Status | /wander-memory/status | P2 | Health/endpoints/maintenance |
| ApiDocs | /wander-memory/api | P2 | Reference tables |

## 4. Feature Overlap with Existing Hermes Routes

- `/memory` (built-in memory entries) — no overlap; WanderMemory is external MemOS.
- `/memconfig`, `/openviking`, `/hindsight` (external memory providers) — no overlap; WanderMemory is a third, distinct memory surface under its own top tab.
- Chat composer (gateway chat) — no overlap; WanderMemory chat is memory-grounded LLM chat via MemOS.

Top-tab split implemented: old `记忆` (`externalMemory`) is replaced by
`Wander 记忆` (`wanderMemory`, 04) + `Hermes 记忆` (`hermesMemory`, 05).
Existing URLs (`/memory`, ...) are unchanged — they now land under `Hermes 记忆`.

## 5. Open Questions (resolved)

1. Does MemOS accept Hermes auth headers? — MemOS does not require them;
   `fetchExternalJSON` sends only the headers the caller provides, and the
   dev/prod REST paths (Vite proxy / external origin) work without Hermes auth.
2. Will MemOS be bundled with Hermes Desktop releases? — No for this pass
   (Appendix G.2 Option 2: external MemOS; user runs it separately; origins are
   configurable + auto-discovered).
3. Do we need offline demo mode in production? — Demo client exists
   (`DemoWanderMemoryClient`) for dev/test/offline; Status view exposes the
   mode badge.
4. Port-shift policy: probe range `[18400, 18409]`; shifted ports published via
   stdout line `WM_PORTS=api,ws,fs` and a ports file; frontend re-probes on
   every launch and caches in ui-store (Appendix L).

## 6. Testing Strategy (real backends)

Per project requirement, tests exercise the **real backend projects**:

- **Hermes-CN-Core** (sibling checkout `../Hermes-CN-Core`, port 9120) — real Hermes backend
  for integration coverage (extends the existing `tests/real_backend.rs`
  pattern; web-side real-backend tests run against the real Core backend).
- **Wander-Memory / MemOS** (`Wander-Minds/Wander-Memory`, sibling checkout
  `../Wander-Memory`, REST 18400 / WS 18401 / FS 18402, port-shift aware) —
  real MemOS backend for the WanderMemory client and E2E (started in remote
  mode against the in-repo dummy OpenAI backend so no real LLM is required;
  `--port 0` style ephemeral ports are used for the test trio where possible,
  with discovery).
- Unit tests (vitest, mock transport) run in `pnpm test:unit`; real-backend
  tests are opt-in via env vars (mirroring `HERMES_REAL_BACKEND_URL` /
  `HERMES_CORE_DIR`), and `e2e/wander-memory.spec.ts` runs against the real
  MemOS backend under the existing Playwright harness.

CI pins the private backend to `efea8c6b0ea8c16cf1593082a93905acd7a055e3`
and checks it out with the read-only `WANDER_MEMORY_DEPLOY_KEY` Actions Secret.
Fork and Dependabot PRs receive no private-repository credentials, so they skip
only the Wander-Memory server/spec while retaining the rest of the E2E suite.

## 7. Implementation Notes

- Client layer: `web/src/lib/wander-memory/*` built on Hermes transport
  (`fetchJSON` / `fetchExternalJSON`), `ui-store` persistence, and port-shift
  discovery (env → ui-store → ports file/probe → defaults).
- Vite dev proxy: `/v1` → MemOS REST, `/v1/fs` → MemOS FS (rewrite `/v1/fs` →
  `/v1`), port-shift aware at config load.
- No Tailwind; no new runtime dependencies.
- All dynamic memory text rendered as plain text (never `dangerouslySetInnerHTML`).
