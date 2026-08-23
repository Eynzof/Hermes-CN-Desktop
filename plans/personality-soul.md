# Personality / SOUL.md — Python → TypeScript Rewrite Plan

## 1. Summary

Personality & SOUL.md covers the agent's **identity layer**: a durable global `SOUL.md`
(identity slot #1 of the system prompt), 14 built-in `/personality` presets, custom
personalities defined in `config.yaml` (`agent.personalities`), the session-level
`/personality` overlay (`display.personality` selection), and the user-owned
`agent.system_prompt` manual override. In the end-state desktop, all of this must be
resolved **in-process in TypeScript** — reading `HERMES_HOME/SOUL.md` and
`config.yaml` directly (via Rust IPC), rendering the identity block, and applying the
ephemeral overlay at prompt-build time — with no Python backend / WebSocket involved.

Key design decisions:

1. **Single-owner module `web/src/lib/personality/`** mirrors `hermes_cli/personality.py`:
   one TS module owns built-ins, name normalization, rendering, resolution and
   persistence — no surface may bypass it (the CLI/gateway/TUI split-brain bug history
   from PR #81946 must not be reintroduced).
2. **SOUL.md is slot #1 of the stable system-prompt tier**, replacing
   `DEFAULT_AGENT_IDENTITY`; the TS agent loop must call `loadSoulMd()` exactly like
   `agent/system_prompt.py` does, with `skipSoul` dedup against the context-files block.
3. **The personality overlay is ephemeral** — rendered text is applied at prompt-build
   time and never persisted into `agent.system_prompt`; only the **name** is written to
   `display.personality` via a single atomic YAML write path.
4. **kimi-code has no `/personality` or persona-preset concept** — its `SYSTEM.md`
   (global identity file) and `ConfigState.systemPrompt` (manual override) are the only
   analogs; the 14 built-ins, the overlay merge, and the slash command are a from-scratch
   TS design. `js-yaml`/`pathe`/`proper-lockfile` from kimi-code's agent-core are the
   third-party evidence for the config/persistence layer.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`.

- **`hermes_cli/personality.py`** — single owner of personality overlays (186 lines):
  - `BUILTIN_PERSONALITIES` — **14** entries: helpful, concise, technical, creative,
    teacher, kawaii, catgirl, pirate, shakespeare, surfer, noir, uwu, philosopher, hype
    (each a prompt string).
  - `NEUTRAL_PERSONALITY_NAMES = {"", "none", "default", "neutral"}`.
  - Pure helpers: `prompt_text` (str|list|None → text), `render_personality_prompt`
    (dict → `system_prompt` + `Tone:` + `Style:` lines), `describe_personality`
    (50-char preview for list UIs), `normalize_personality_name` (lowercased, neutral→"").
  - Resolution: `available_personalities(cfg)` (built-ins overlaid by
    `agent.personalities`, user wins by lowercase name), `resolve_personality(value,cfg)`
    → `(canonical_name, prompt)` raising `ValueError` with an availability listing,
    `active_personality_name(cfg)` (only known names), `resolve_ephemeral_system_prompt(cfg)`
    (personality wins, else `agent.system_prompt`).
  - Persistence: `persist_personality(value)` — the **only** write path: writes the
    canonical name to `display.personality` via `utils.atomic_roundtrip_yaml_update`
    (comment/order preserving, `0600`), never touches `agent.system_prompt`.
- **`hermes_cli/default_soul.py`** — `DEFAULT_SOUL_MD` template ("You are Hermes Agent…"
  + "Always respond in Chinese.") and `is_legacy_template_soul()` (normalized-content
  compare against old comment-only scaffolds so user-customized SOUL.md is never upgraded).
- **`hermes_cli/config.py`** — `_ensure_default_soul_md(home)` seeds `HERMES_HOME/SOUL.md`
  on first run / upgrades legacy templates (called from `ensure_hermes_home()`);
  `resolve_ephemeral_system_prompt_from_config()` (env `HERMES_EPHEMERAL_SYSTEM_PROMPT`
  first, then `hermes_cli.personality`).
- **`agent/prompt_builder.py`** —
  - `load_soul_md(context_length)` (L2248): reads `<HERMES_HOME>/SOUL.md`, strips BOM,
    runs `_scan_context_content` (→ `tools/threat_patterns.scan_for_threats(scope="context")`,
    blocks injection with a `[BLOCKED…]` marker), truncates via `_truncate_content`
    (head 70% / tail 20%, `CONTEXT_FILE_MAX_CHARS` 20_000 floor, dynamic cap up to 500K
    scaled to `context_length`), returns `None` on missing/empty/read-failure.
  - `build_context_files_prompt(skip_soul=True)` (L2452): SOUL.md is **not** injected
    again in the context-files block when it was already loaded for identity.
- **`agent/system_prompt.py`** — `build_system_prompt_parts()` (L265): **stable tier slot #1**
  = `load_soul_md()` content or `DEFAULT_AGENT_IDENTITY` fallback (L302–314); `context`
  tier appends caller `system_message` + context files; `volatile` tier = skills/memory/
  timestamp. The ephemeral personality prompt is **not** part of the cached prompt — it is
  injected at API-call time (`agent.ephemeral_system_prompt`, set via
  `HERMES_EPHEMERAL_SYSTEM_PROMPT`/`resolve_ephemeral_system_prompt`).
- **Command surfaces** (all route through `hermes_cli.personality`):
  - CLI: `cli.py` L4566–4575 (session `system_prompt` resolution + `self.personalities`),
    `hermes_cli/cli_commands_mixin.py` `_handle_personality_command` (L1336; list / set /
    neutral-reset, `persist_personality`, `self.agent = None` re-init, `system_prompt`
    fallback to manual prompt on reset), `_personality_completions` (L2084).
  - Gateway: `gateway/slash_commands.py` `_handle_personality_command` (L2497; same
    resolution/persistence, sets in-memory `self._ephemeral_system_prompt`).
  - TUI/desktop: `tui_gateway/server.py` `config.set key=personality` (L~11837), session
    `personality` marker (`_apply_personality_to_session`, L6205), and `/personality`
    slash handler; **historical bug fixed by test_personality_clobbers_system_prompt.py**:
    the picker used to write rendered TEXT into `agent.system_prompt` — the fix writes only
    the name and preserves the manual prompt.
  - Dashboard REST: `hermes_cli/web_server.py` GET/PUT `/api/profiles/{name}/soul`
    (SOUL.md per profile; atomic write so interrupted saves never truncate the file).

## 3. Target TypeScript design

New module tree under `web/src/` (in-process, no Python):

```
web/src/lib/personality/
  builtin-personalities.ts   # readonly record: the 14 built-ins (copy of BUILTIN_PERSONALITIES)
  personality-core.ts        # pure functions (mirror hermes_cli/personality.py)
  soul.ts                    # loadSoulMd / seedSoulMd / scanContextContent / truncateContent
  config-personality.ts      # js-yaml read+atomic write of display.personality /
                             # agent.personalities / agent.system_prompt
  slash-personality.ts       # /personality command handler for the chat composer
web/src/hooks/use-personality.ts   # React Query hooks over the local store
web/src/lib/persona-market/        # (existing) market -> SOUL.md full-replace path stays
```

Pure core (unit-testable, no I/O):

```ts
type PersonalityDefinition = string | { system_prompt?: string; tone?: string; style?: string; description?: string };
interface PersonalityCfg { display?: { personality?: string }; agent?: { personalities?: Record<string, PersonalityDefinition>; system_prompt?: string } }

const NEUTRAL_PERSONALITY_NAMES = new Set(["", "none", "default", "neutral"]);
const BUILTIN_PERSONALITIES: Readonly<Record<string, string>> = { helpful: "You are a helpful…", … 14 total };

function normalizePersonalityName(value: unknown): string;          // lower, strip, neutral→""
function promptText(value: unknown): string;                        // str|string[]|null
function renderPersonalityPrompt(value: PersonalityDefinition): string; // dict: system_prompt + "Tone: …" + "Style: …"
function describePersonality(value: PersonalityDefinition, width = 50): string;
function availablePersonalities(cfg?: PersonalityCfg): Record<string, PersonalityDefinition>; // user overlays built-ins
function resolvePersonality(value: unknown, cfg?: PersonalityCfg): { name: string; prompt: string }; // throws on unknown w/ listing
function activePersonalityName(cfg?: PersonalityCfg): string;
function resolveEphemeralSystemPrompt(cfg?: PersonalityCfg): string;  // personality wins, else agent.system_prompt
```

Identity block (called by the TS agent-loop prompt builder):

```ts
async function loadSoulMd(home: string, opts?: { contextLength?: number }): Promise<string | null> {
  const path = join(home, "SOUL.md");
  const content = await fsReadTextUtf8(path).catch(() => null);
  if (!content?.trim()) return null;
  const scanned = scanContextContent(content, "SOUL.md");   // threat scan → [BLOCKED…] marker
  return truncateContent(scanned, "SOUL.md", { contextLength });
}
function buildIdentityBlock(soul: string | null, defaultIdentity: string): string { return soul ?? defaultIdentity; }
```

The in-process prompt builder mirrors `agent/system_prompt.py` tiering: stable tier starts
with `buildIdentityBlock(await loadSoulMd(home), DEFAULT_AGENT_IDENTITY)`, then guidance;
the context-files builder is called with `skipSoul=true` when the identity was loaded;
the resolved ephemeral overlay (`resolveEphemeralSystemPrompt(cfg)`, env override first) is
passed to the model call as the ephemeral system message — never written into the cached
prompt. On `/personality <name>`, the handler: `resolvePersonality` → persist only the name →
mark the in-memory session store overlay → rebuild/re-init the agent so the next turn picks it up.

## 4. Data models & persistence

- **`HERMES_HOME/SOUL.md`** — plain UTF-8 Markdown; the durable identity. Seeded with
  `DEFAULT_SOUL_MD` when missing or when content matches a legacy scaffold
  (`isLegacyTemplateSoul` port); user content is never overwritten. Per-profile: each
  profile's home is `profiles/<name>/`, so each profile has its own SOUL.md.
- **`config.yaml` keys** (same schema as Python — no migration needed in TS):
  - `display.personality: string` — selected name (`""` = none). The ONLY persisted
    selection; written atomically via a temp-file + rename (comment/order-preserving
    round-trip is a nice-to-have; a plain key patch is acceptable for the first port).
  - `agent.personalities: Record<string, string | {system_prompt,tone,style,description}>`
    — user-defined/overridden personalities; overlay built-ins by lowercase name.
  - `agent.system_prompt: string` — user-owned manual overlay; personality code never
    writes it (regression test `test_personality_clobbers_system_prompt.py` must pass).
- **Storage strategy**: files on disk (Rust `fs` commands), with React Query as the UI
  cache (`soul`, `personality`, `config` query keys, profile-scoped like today). No
  SQLite/IndexedDB needed for this feature. The existing `v34` one-time personality reset
  is a Python migration that already ran; the TS port must **not** re-reset selections.
- **Session state**: the ephemeral overlay for the current session lives in the in-memory
  session store (`session["personality"]` analog in the TS agent runtime), not on disk.

## 5. Third-party library strategy

| Python dependency | TS equivalent | kimi-code evidence |
|---|---|---|
| `PyYAML` (config.yaml parse/write) | **`js-yaml`** (+ `zod` validation in protocol) | `packages/agent-core/package.json` lists `js-yaml@^4.1.1` (used by `skill/parser.ts`, `profile/agentfile/parser.ts` frontmatter) and `zod@^4.3.6`; desktop protocol already uses zod |
| `utils.atomic_roundtrip_yaml_update` | **temp-file + `rename`**; optional `proper-lockfile` for concurrent writers | `proper-lockfile@^4.1.2` in agent-core deps |
| `pathe` / `os.path` | **`pathe`** (or Node `path`; in webview use Tauri `path` API) | `pathe@^2.0.3` in agent-core deps (used in `profile/agentfile/*.ts`) |
| `tools/threat_patterns.scan_for_threats` (prompt-injection scan) | **implement from scratch** `lib/personality/scan.ts` — port the `context`-scope regex set (classic injection, promptware/C2, role-play hijack) as a TS module | no kimi-code equivalent: `SYSTEM.md` is read with no scan (`system-file.ts` L40–49) — **risk, see §9** |
| `contextvars` truncation-warning accumulator | trivial module-scoped/request-scoped array | not applicable |
| template rendering | not needed — `renderPersonalityPrompt` is plain string concat; do **not** pull nunjucks (kimi-code uses it for agentfile templates, Hermes personalities don't) | `nunjucks@^3.2.4` exists in agent-core but unused for this feature |

Third-party additions to the desktop `web` package: `js-yaml`, `pathe` (runtime), and a
dev-dep `@types/js-yaml`. Everything else is a pure-TS port.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **Reuse as-is (today, over REST/WS)**: `web/src/hooks/use-soul.ts`
  (`/api/profiles/{name}/soul`), `web/src/routes/soul.tsx` (SOUL editor + persona-market
  tabs), `components/persona/persona-market-panel.tsx` + `lib/persona-market.ts` (215
  personas → full SOUL.md replace), `hooks/use-config.ts` (`/api/config` for
  `agent.personalities`/`agent.system_prompt`), `hooks/use-gateway.ts` `config.set`
  (hot-switch overlay today).
- **New local modules replace the REST/WS surface**: `use-personality.ts` will expose
  `usePersonalities()` (merged built-ins + custom, from `config.yaml`), `useActivePersonality()`,
  `useSetPersonality()` (persist name + hot-switch), `useSoulLocal()` (Rust fs read/write).
- **Rust**: add Tauri commands (or reuse existing fs/dialog commands): `read_home_file`,
  `write_home_file_atomic` (for `SOUL.md` and `config.yaml`), `hermes_home()` (already
  available via runtime-manager). `src/commands/api_proxy.rs` continues to proxy the REST
  surface during migration only.
- **Protocol** (`packages/protocol/src/hermes-api.ts`): add `PersonalityListResponse`
  (name → rendered preview), `PersonalitySetRequest` (`{name}`), `PersonalityListRequest`;
  keep `ProfileSoulResponse` unchanged for the REST parity phase.
- **Composer**: `/personality` becomes a real client-side slash command (chat input
  autocomplete already exists in `lib/composer-*`); `builtin-commands.ts` gains the entry;
  `command-palette.ts` already links `/soul` for navigation.
- **Guide/settings**: `routes/guide.tsx` and `routes/settings.tsx` currently have no soul
  wiring (verified by grep) — the new persona section lives in the existing `soul.tsx`
  route; a "人格" card can be added to settings later.

## 7. Removing the WebSocket dependency (migration path)

Today personality state crosses the boundary four ways:

1. REST `GET/PUT /api/profiles/{name}/soul` (SOUL.md content).
2. REST `GET/PUT /api/config` (`display.personality`, `agent.personalities`,
   `agent.system_prompt`).
3. WS JSON-RPC `config.set {key:"personality", value:name, session_id}` (desktop picker
   hot-switch, tui_gateway).
4. WS slash `/personality` (chat command, CLI/gateway/tui_gateway).

**Phase A — freeze the interface**: keep all four; implement `personality-core.ts`,
`soul.ts`, `config-personality.ts` as pure TS behind the same behavior; add vitest parity
suites against the Python tests. No behavior change.

**Phase B — local-first reads/writes**: `use-soul.ts`/`use-personality.ts` switch their
`queryFn`/`mutationFn` to Rust IPC (`hermes_home()` + read/write file commands) when
`runtime.platform === "tauri"`; REST remains the web/attached fallback. The `config.set
key=personality` WS call is replaced by a local `setPersonality()` that (a) atomically
writes `display.personality`, (b) updates the in-memory session overlay, (c) invalidates
the `personality`/`config` React Query keys — identical next-turn semantics, no WS.

**Phase C — delete**: remove `config.set` personality handling and the `/personality`
WS slash from the desktop path; the composer's `/personality` runs `slash-personality.ts`
locally; REST soul endpoints are removed once no attached/web mode needs them. The frozen
contract to preserve during migration: `display.personality` holds a name, `agent.system_prompt`
is never written by personality code, SOUL.md is identity slot #1 and appears exactly once.

## 8. Migration phases & task breakdown

1. **P1 — pure core (no I/O)**: port `builtin-personalities.ts` (14 entries),
   `personality-core.ts` (normalize/render/describe/available/resolve/active/ephemeral).
   Vitest parity with `tests/hermes_cli/test_personality_single_owner.py` (all pure cases:
   overlays, neutral names, dict render, unknown-name listing, ephemeral precedence).
2. **P2 — SOUL.md loader + identity block**: `soul.ts` (`loadSoulMd`, `scanContextContent`,
   `truncateContent`, `seedSoulMd`, `isLegacyTemplateSoul`), `buildIdentityBlock`.
   Parity with `tests/agent/test_prompt_builder.py` (empty soul adds nothing; seeded global
   soul), `tests/run_agent/test_run_agent.py::TestBuildSystemPrompt` (soul replaces
   DEFAULT_AGENT_IDENTITY; skip-soul dedup), `tests/agent/test_system_prompt.py`.
3. **P3 — config persistence**: `config-personality.ts` (js-yaml read; atomic write of
   `display.personality` only; never touch `agent.system_prompt`). Parity with
   `persist_personality` roundtrip + no-clobber tests.
4. **P4 — hooks + UI swap**: `use-personality.ts`; wire `soul.tsx` persona picker
   (built-ins + custom list) to the local store; keep market flow.
5. **P5 — slash command**: `slash-personality.ts` (list/set/neutral-reset, unknown-name
   listing, session hot-switch), composer autocomplete integration.
6. **P6 — Rust IPC + removal**: add Rust file commands; switch hooks to local; delete WS
   `config.set` personality + `/personality` proxy; update `packages/protocol` zod schemas.
7. **P7 — E2E**: Playwright for soul route, picker, and composer slash command.

## 9. Risks & open questions

- **No TS equivalent found — built-in personalities / `/personality` overlay**:
  kimi-code has no persona preset or personality slash command (verified: no
  `persona|personality` matches under `apps/kimi-code/src`). The 14 presets + overlay
  merge + ephemeral-injection semantics must be implemented from scratch; parity is defined
  by the Python tests, not by kimi-code.
- **Prompt-injection scan parity**: Python blocks SOUL.md with `tools/threat_patterns.py`
  `scan_for_threats(scope="context")`. kimi-code reads `SYSTEM.md` without scanning
  (`system-file.ts`). Porting the exact regex set is required to keep SOUL.md safe;
  until ported, risk of divergence (blocked files behave differently). Consider reusing
  the existing web `rehype-harden` only for rendering, not for prompt scanning.
- **Tests path mismatch**: the spec cites `tests/agent/test_soul*.py` — no such file
  exists; soul coverage lives in `tests/agent/test_prompt_builder.py`,
  `tests/agent/test_system_prompt.py`, `tests/run_agent/test_run_agent.py`,
  `tests/hermes_cli/test_config.py`, plus `tests/hermes_cli/test_web_profile_soul_writes.py`.
- **v34 migration semantics**: the one-time personality reset already ran in Python; TS
  must not reset `display.personality` on read or it will break users who selected after
  upgrading. Parity test needed: post-v34 selection is never reset.
- **Atomic write parity**: Python preserves YAML comments/ordering via
  `atomic_roundtrip_yaml_update`; a plain js-yaml `dump` would reformat the whole file.
  First port may accept reformatting, but flag it: users hand-edit config.yaml.
- **Hot-switch timing**: Python applies the overlay to `ephemeral_system_prompt` and
  re-inits the agent ("next message only"). The TS in-process runtime must replicate
  session-scoped overlay without persisting it, or the `config.set` vs slash paths
  diverge again (the original #81946 bug class).
- **SOUL.md char limit drift**: `use-soul.ts` hardcodes `SOUL_CHAR_LIMIT = 20_000`; the
  Python cap is dynamic (up to 500K) with a 20K floor. The editor limit is fine as a UI
  hint but the loader must implement the dynamic cap for parity.

## 10. Test strategy

- **Vitest unit (pure)**: `personality-core` parity port of
  `test_personality_single_owner.py` — built-ins available without config, user overlays
  win, neutral normalization, case-insensitive resolve, unknown-name error listing, dict
  render, `prompt_text` normalization, `describe_personality` truncation, ephemeral
  precedence (personality > manual prompt; unknown name falls back; neutral falls back).
- **Vitest unit (fs)**: `soul.ts` with a temp HERMES_HOME — seed default, legacy-template
  upgrade, empty-file fallback, BOM strip, truncation (head/tail + marker), `[BLOCKED…]`
  on scan hit, `skipSoul` dedup in the context-files builder; `config-personality.ts`
  roundtrip + never-touches-`system_prompt` (port of `test_personality_clobbers_system_prompt.py`
  and `test_web_profile_soul_writes.py` interrupted-save behavior).
- **Integration**: in-process prompt builder — soul replaces `DEFAULT_AGENT_IDENTITY`
  (port `test_run_agent.py::TestBuildSystemPrompt::test_can_use_soul_identity_even_when_context_files_are_skipped`);
  identity appears exactly once; ephemeral overlay excluded from the cached prompt.
- **Playwright E2E**: `/soul` route loads/edits/saves; persona-market apply overwrites
  SOUL.md with overwrite confirmation; picker selects built-in + custom personality and
  the badge reflects active; composer `/personality` list/set/reset and unknown-name error.
- **Parity check script** (optional): run Python tests + corresponding vitest side-by-side
  on a shared fixture set (names, definitions, config shapes).

## 11. Reference links

- Python: `D:/hermes-agent-cn/hermes_cli/personality.py`, `hermes_cli/default_soul.py`,
  `hermes_cli/config.py` (L967–1069 seed, L3404 resolver), `agent/prompt_builder.py`
  (L2203–2529), `agent/system_prompt.py` (L265–732), `hermes_cli/cli_commands_mixin.py`
  (L1336), `cli.py` (L4564–4575), `gateway/slash_commands.py` (L2497),
  `tui_gateway/server.py` (L6205, L11837), `hermes_cli/web_server.py`
  (`/api/profiles/{name}/soul`), `tools/threat_patterns.py`.
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/features/personality.md`.
- Tests: `D:/hermes-agent-cn/tests/hermes_cli/test_personality_single_owner.py`,
  `tests/hermes_cli/test_web_profile_soul_writes.py`,
  `tests/tui_gateway/test_personality_clobbers_system_prompt.py`,
  `tests/tui_gateway/test_make_agent_personality_prompt.py`,
  `tests/agent/test_prompt_builder.py`, `tests/agent/test_system_prompt.py`,
  `tests/run_agent/test_run_agent.py` (TestBuildSystemPrompt),
  `tests/hermes_cli/test_config.py` (soul seeding).
- TS reference: `D:/kimi-code/packages/agent-core/src/agent/config/{index,types}.ts`
  (`ConfigState.systemPrompt`), `src/profile/agentfile/{system-file,discovery,parser}.ts`
  (`SYSTEM.md`), `src/profile/resolve.ts`, `src/utils/render-prompt.ts`,
  `packages/agent-core/package.json` (js-yaml, pathe, proper-lockfile, zod).
- Desktop: `D:/Hermes-CN-Desktop/web/src/hooks/use-soul.ts`,
  `web/src/routes/soul.tsx`, `web/src/lib/persona-market.ts`,
  `web/src/components/persona/persona-market-panel.tsx`, `web/src/hooks/use-config.ts`,
  `web/src/hooks/use-gateway.ts`, `web/src/lib/transport.ts`,
  `packages/protocol/src/hermes-api.ts` (ProfileSoulResponse), `src/commands/api_proxy.rs`.
