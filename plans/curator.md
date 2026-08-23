# Curator — Python → TypeScript Rewrite Plan

> Feature: background skill maintenance — usage telemetry, active→stale→archived
> transitions, LLM consolidation, backups/rollback, pinning; `hermes curator` CLI
> + `/curator` slash command. Design-only; no implementation.

## 1. Summary

The Curator is Hermes' **background skill-maintenance pass for agent-created skills**.
It keeps `~/.hermes/skills/` from filling with narrow near-duplicates by: (1) recording
per-skill usage telemetry in `skills/.usage.json` (use/view/patch counts + timestamps),
(2) deterministically walking skills through `active → stale → archived` by inactivity
(`curator.stale_after_days`/`archive_after_days`; pinned and cron-referenced skills
exempt), (3) optionally spawning an **aux-model review fork** that consolidates
overlapping skills into class-level umbrellas (opt-in `curator.consolidate: true`),
(4) taking a tar.gz snapshot of the whole skills tree **before every mutating run**
(`skills/.curator_backups/<utc-iso>/`) so any pass is undoable, and (5) exposing
pin/unpin/adopt/restore/archive/prune via `hermes curator <verb>` and `/curator`.

This plan ports the curator into the TypeScript in-process runtime:
- `web/src/lib/curator/` — `usage-store.ts` (`.usage.json` sidecar), `lifecycle.ts`
  (pure transition walk), `classify.ts` (consolidated-vs-pruned reconciliation),
  `report.ts` (run.json + REPORT.md), `prompts.ts` (review prompt + dry-run banner),
  `review-runner.ts` (child-agent consolidation fork via kimi-code `BackgroundManager`),
  `backup.ts` (snapshot/rollback orchestrated over Rust fs/tar commands), `service.ts`
  (facade mirroring `agent/curator.py::run_curator_review` + `maybe_run_curator`),
  `scheduler.ts` (hourly in-process ticker);
- Desktop UI: a **Curator tab** in `web/src/routes/skills.tsx` (status, state/pinned
  badges, pin/adopt, run/dry-run, backups/rollback, per-skill usage) + `/curator` in the
  composer slash palette;
- The `hermes curator` CLI itself is marked **out of scope for desktop standalone**
  (pure CLI adapter), but its verb set is preserved as the frozen service interface.

**No kimi-code equivalent exists for the curator core.** kimi-code ships background
*tasks*, an event bus, skill *activation*, and OTLP telemetry — but no skill lifecycle,
no `.usage.json` sidecar, no archive/backup/rollback, no pinning, no LLM consolidation.
The lifecycle/backup/report machinery is from-scratch TS; kimi-code only provides
reusable substrate (background task lifecycle, event emitter, `skill_invoked` telemetry
pattern).

## 2. Current Python implementation

Source files under `D:/hermes-agent-cn`:

- **`agent/curator.py`** (2019 lines) — orchestrator + state + scheduler:
  - `.curator_state` persistence (`load_state`/`save_state`/`set_paused`/`is_paused`;
    fields `last_run_at, last_run_duration_seconds, last_run_summary,
    last_run_summary_shown_at, last_report_path, paused, run_count`).
  - Config getters from `config.yaml` `curator:` block: `is_enabled` (default ON),
    `interval_hours` (168), `min_idle_hours` (2), `stale_after_days` (30),
    `archive_after_days` (90), `prune_builtins` (True), `consolidate` (False).
  - `should_run_now()` — gates: enabled ∧ ¬paused ∧ last_run_at ≥ interval; **first-run
    seeds** `last_run_at` and defers one full interval.
  - `apply_automatic_transitions(now)` — pure no-LLM walk over
    `skill_usage.curated_report()`: pins, cron-referenced skills, and never-used skills
    younger than `stale_after_days` are skipped; built-ins get a first-sight **seed
    record**; returns `{marked_stale, archived, reactivated, checked, seeded}`.
  - `run_curator_review(on_summary, synchronous, dry_run, consolidate)` — pre-run
    `curator_backup.snapshot_skills("pre-curator-run")` → auto-transitions → optional
    `_run_llm_review(prompt)` in a daemon `threading.Thread` → `_write_run_report(...)`
    → `save_state`. Dry-run skips mutations, doesn't bump `last_run_at`/`run_count`.
  - `_run_llm_review` — forked `AIAgent` with `enabled_toolsets=["skills","terminal"]`,
    `max_iterations=9999`, `platform="curator"`, `_memory_write_origin="background_review"`
    (fires skill_manage's background write guard); runtime from `auxiliary.curator.*`
    (legacy `curator.auxiliary.*`) via `_resolve_review_runtime`.
  - Classification of archived skills: `_classify_removed_skills` (tool-call heuristic),
    `_parse_structured_summary` (YAML block), `_extract_absorbed_into_declarations`
    (`absorbed_into=<umbrella>` at delete), `_reconcile_classification` (model intent
    beats heuristic; hallucinated umbrellas downgraded); `_build_rename_summary` renders
    `old → umbrella` map + pin hint (cap 10).
  - `_write_run_report`/`_render_report_markdown` — `logs/curator/{YYYYMMDD-HHMMSS}/
    run.json` (full fidelity, tool calls, classification, `cron_rewrites`) + `REPORT.md`;
    cron skill-reference rewrite via `cron.jobs.rewrite_skill_refs(...)`.
  - Entry points: `maybe_run_curator(idle_for_seconds, on_summary)` (session-start hook,
    never raises; gates on `should_run_now()` + `min_idle_hours`).

- **`agent/curator_backup.py`** (752 lines) — snapshot + rollback:
  - `snapshot_skills(reason, protect_ids)` → tar.gz of `skills/` minus
    `{.curator_backups, .hub}` (includes `.usage.json`, `.archive/`, `.curator_state`,
    `.bundled_manifest`, `.curator_suppressed`) + `manifest.json` + `cron/jobs.json`
    copy as `cron-jobs.json`; UTC-ISO id `2026-05-01T13-05-42Z[-NN]`; prunes to
    `curator.backup.keep` (default 5) with `protect_ids`.
  - `rollback(backup_id)` — takes a **pre-rollback safety snapshot**, stages the current
    tree into `.rollback-staging-*`, extracts the target snapshot with path-traversal
    guards, then `_restore_cron_skill_links` surgically restores only `skills`/`skill`
    fields on still-existing jobs (schedule/prompt stay live).
  - `list_backups`/`summarize_backups` for `--list`.

- **`tools/skill_usage.py`** (1340 lines) — telemetry + lifecycle primitives:
  - `.usage.json` record: `created_by` (policy flag = curator-managed),
    `use_count/view_count/patch_count`, `last_used_at/last_viewed_at/last_patched_at`,
    `patch_generation/last_reused_patch_generation`, `created_at`, `state`
    (active/stale/archived), `pinned`, `archived_at` (+ newer `sync` opt-in).
  - Atomic writes (`tempfile.mkstemp` + `os.replace`) with cross-process lock
    (`fcntl`/`msvcrt`).
  - Provenance filters: `.bundled_manifest`, `.hub/lock.json`,
    `PROTECTED_BUILTIN_SKILLS = {"plan"}`, external-dir exclusion; `mark_agent_created`
    / `adopt_skill` write the management marker; `is_curator_managed` reads it.
  - Lifecycle: `set_state`, `set_pinned`, `archive_skill` (moves dir to
    `.archive/<skill>`, appends to `.curator_suppressed` for pruned built-ins),
    `restore_skill` (refuses hub/bundled collisions), `seed_record_if_missing`.
  - Reporting: `curated_report()` (curator-scoped, `_persisted` flag),
    `usage_report()` (all skills + provenance), `unmanaged_report()` /
    `list_unmanaged_skill_names()` (drives `adopt`).

- **`hermes_cli/curator.py`** (850 lines) — argparse shell: `status, usage, run
  (--sync/--background/--dry-run/--consolidate), pause, resume, pin, unpin,
  list-unmanaged, adopt (--all-unmanaged/--dry-run/--yes), restore, list-archived,
  archive, prune (--days/--yes/--dry-run), backup (--reason), rollback
  (--list/--id/-y)`. `/curator` slash command
  (`hermes_cli/cli_commands_mixin.py::_handle_curator_command`, line 1836) delegates to
  `hermes_cli.curator.cli_main` — CLI and session share one handler set.

- **Trigger wiring** (Python-only today): `maybe_run_curator` called from (a) the
  session-start hook and (b) the gateway housekeeping loop (`gateway/run.py`
  `CURATOR_EVERY = 60` ticks ≈ hourly poll; `idle_for_seconds=float("inf")`).

- **Config** (`hermes_cli/config_defaults.py`; v22→v23 migration in
  `hermes_cli/config_migrations.py`): `curator.{enabled, interval_hours,
  min_idle_hours, stale_after_days, archive_after_days, consolidate, prune_builtins,
  backup.{enabled, keep}}`, `auxiliary.curator.{provider, model, timeout, base_url,
  api_key, extra_body}`.

- **REST surface today** (`hermes_cli/web_routers/skills.py`): only `GET/POST
  /api/skills`, `PUT /api/skills/toggle`, `GET/PUT /api/skills/content` + hub
  endpoints. `GET /api/skills` already decorates skills with `usage` (`activity_count`)
  and `provenance` — **no curator status/run/pin/backup REST endpoints exist yet**.

- **Docs**: `website/docs/user-guide/features/curator.md` — full behavior spec:
  lifecycle, first-run deferral, prune-builtins, consolidate opt-in, backups, agent-
  created provenance + adopt, pinning, usage telemetry shape, per-run reports.

### Data flow (current)

```
tick/hook → maybe_run_curator → should_run_now (first-run seeds)
  → run_curator_review → pre-run snapshot → auto-transitions
  → [consolidate] forked AIAgent (skills+terminal) → classify removed
      (absorbed_into > YAML > tool-call audit) → cron.jobs.rewrite_skill_refs
  → logs/curator/<stamp>/{run.json,REPORT.md} → save_state(.curator_state)
hermes curator <verb> / /curator <verb> → hermes_cli.curator.cli_main
```

## 3. Target TypeScript design

New in-process module tree under `web/src/lib/curator/` (business logic out of React
components per AGENTS.md):

```
web/src/lib/curator/
  types.ts          // shared types: SkillUsageRecord, LifecycleState, CuratorState,
                    // CuratorConfig, RunReport, BackupInfo, ClassificationResult
  config.ts         // readCuratorConfig() via Rust get_runtime_config (defaults ≡ config_defaults.py)
  usage-store.ts    // .usage.json: atomic (tmp+rename), cross-process lock, zod, corrupt tolerance
  lifecycle.ts      // applyAutomaticTransitions(now, rows, cfg) — PURE function (§3 interface)
  prompts.ts        // CURATOR_REVIEW_PROMPT + CURATOR_DRY_RUN_BANNER (parity fixtures)
  classify.ts       // absorbed_into > YAML block > tool-call heuristic; rename summary
  review-runner.ts  // child-agent consolidation fork (kimi-code BackgroundManager pattern)
  report.ts         // writeRunReport(dir, payload) → run.json + REPORT.md + cron_rewrites.json
  backup.ts         // snapshotSkills/listBackups/rollback orchestrate Rust fs+tar commands
  service.ts        // CuratorService facade (frozen interface, §7)
  scheduler.ts      // hourly poll (≡ gateway CURATOR_EVERY) + idle check
```

Key interfaces (signatures only):

```ts
interface CuratorService {
  status(): Promise<CuratorStatus>;                       // state + counts + LRU top-5
  run(opts: { dryRun?: boolean; consolidate?: boolean; synchronous?: boolean }): Promise<RunStart>;
  setPaused(paused: boolean): Promise<void>;
  pin(name: string): Promise<Result>; unpin(name: string): Promise<Result>;
  adopt(names: string[], allUnmanaged?: boolean): Promise<AdoptResult>;
  listUnmanaged(): Promise<UnmanagedSkill[]>;
  restore(name: string): Promise<Result>; listArchived(): Promise<string[]>;
  archive(name: string): Promise<Result>;
  prune(days: number, dryRun?: boolean): Promise<PruneResult>;
  backup(reason?: string): Promise<BackupResult>;
  listBackups(): Promise<BackupInfo[]>; rollback(id?: string): Promise<RollbackResult>;
  usage(sort: "activity" | "recent" | "name", provenance?: Provenance): Promise<SkillUsageRow[]>;
  maybeRun(idleForSeconds?: number): Promise<boolean>;   // ports maybe_run_curator
}

// lifecycle is pure (no fs, no LLM) → trivially unit-testable
function applyAutomaticTransitions(
  rows: SkillUsageRecord[], now: Date, cfg: CuratorConfig,
): { checked: number; markedStale: number; archived: number; reactivated: number; seeded: number };
```

**Review-runner design (consolidation fork):** reuse kimi-code
`BackgroundManager`/`AgentBackgroundTask` (`packages/agent-core/src/agent/background/
index.ts`, `agent-task.ts`): unique task id, status lifecycle, ring-buffer output,
abort controller. Child agent inherits the parent runtime binding
(`auxiliary.curator.*` → legacy `curator.auxiliary.*` → main model), runs
`enabledToolsets: ["skills","terminal"]`, `maxIterations: 9999`, `quiet: true`,
`skipMemory: true`, `persistDisabled: true`, and a `background_review` write-origin
(AsyncLocalStorage — see `plans/self-improvement-loop.md` §3) so `skill_manage`
archive/delete guards fire.

**Scheduler:** `scheduler.ts` polls hourly (Python's gateway cadence) and enforces the
real `interval_hours` / `min_idle_hours` / `paused` / first-run-seed gates inside
`service.maybeRun`.

**UI surfaces:** `/curator [verb]` in the composer slash palette (extend
`web/src/lib/composer-skills.ts` mechanics) → `CuratorService`; a **Curator tab** in
`web/src/routes/skills.tsx` (status summary, state/pinned badges, pin/unpin, adopt +
unmanaged list, run/dry-run, backup list + rollback, REPORT.md preview).

## 4. Data models & persistence

Keep **JSON sidecar parity** with Python so the hybrid phase shares `~/.hermes` with
the managed runtime:

| Store | Path | Shape (zod) |
|---|---|---|
| Skill usage telemetry | `skills/.usage.json` | `Record<name, {created_by: "agent"\|"installed"\|null, use_count, view_count, patch_count, last_used_at?, last_viewed_at?, last_patched_at?, patch_generation, last_reused_patch_generation, created_at, state: "active"\|"stale"\|"archived", pinned: boolean, archived_at: string\|null}>` |
| Curator state | `skills/.curator_state` | `{last_run_at?, last_run_duration_seconds?, last_run_summary?, last_run_summary_shown_at?, last_report_path?, paused: boolean, run_count: number}` |
| Backups | `skills/.curator_backups/<utc-iso>[-NN]/` | `skills.tar.gz` + `manifest.json` `{id, reason, created_at, archive, archive_bytes, skill_files, cron_jobs?}` + `cron-jobs.json?` |
| Built-in suppression | `skills/.curator_suppressed` | newline-delimited skill names (re-seeder leaves pruned built-ins archived) |
| Archive | `skills/.archive/<skill>[-YYYYMMDDHHMMSS]/` | full skill directory packages (recoverable) |
| Run reports | `logs/curator/{YYYYMMDD-HHMMSS}[-N]/` | `run.json`, `REPORT.md`, `cron_rewrites.json` (only when jobs changed) |
| Bundled/hub provenance | `skills/.bundled_manifest`, `skills/.hub/lock.json` | `"name:hash"` lines / `{installed: …}` (read-only filters) |
| Config | `config.yaml` | `curator.*`, `auxiliary.curator.*` — read via Rust `get_runtime_config` |

Conventions (port of Python behavior):
- **Tolerant reads**: `errors="replace"` + empty-map fallback; zod `.passthrough()` so
  unknown keys survive.
- **Atomic writes**: `<file>.tmp` in the same dir, `fsync`, `rename` (≡ `os.replace`).
- **Cross-process lock during hybrid**: `proper-lockfile` or `mkdir` lockfile shim;
  enforce a **single writer** per store during Phase 1/2.
- **Migrations**: `{version: 1}` tag on `.usage.json`/`.curator_state`; preserve unknown
  keys; never drop `cron-jobs.json` from backups; first-run seed deferral ports exactly.

## 5. Third-party library strategy

| Python dependency | TS equivalent | Evidence |
|---|---|---|
| `orjson` | native `JSON.parse/stringify` + zod | `packages/protocol/src/hermes-api.ts` already zod-validates |
| `fcntl`/`msvcrt` locks | `proper-lockfile` (npm) or `mkdir` lockfile shim | **no kimi-code evidence** — kimi-code persists via `packages/minidb` (SQLite), not locked JSON sidecars; thin shim required |
| `tarfile` + gzip | Rust Tauri command with `tar`/`flate2` (preferred), or npm `tar` + `node:zlib` | **no kimi-code evidence** — no tar.gz snapshots in kimi-code; delegate to Rust (`src/commands/backup.rs` pattern) to avoid webview sandbox/CSP issues |
| `PyYAML` | `js-yaml` (npm) or minimal frontmatter parser | kimi-code reads SKILL.md metadata in `src/skill/`; exact parser unverified — use `js-yaml` + tolerant hand-rolled fallback for the structured block |
| `datetime`/`fromisoformat` | native `Date` + `web/src/lib/curator/iso-time.ts` (ISO-8601 UTC parse/format, tz-aware compare) | kimi-code uses ms epochs (`startedAt: number` in background/index.ts); keep ISO string parity |
| `threading.Thread` daemon fork | kimi-code `BackgroundManager` / `AgentBackgroundTask` (`packages/agent-core/src/agent/background/`) | `background/index.ts`: task id, status, ring buffer, abort, persistence |
| forked `AIAgent` (consolidation LLM) | kimi-code subagent host (`src/session/subagent-host.ts`) + tool allowlist (`src/agent/tool/index.ts`) + `AgentBackgroundTask` | restricted-toolset child agent; `max_iterations=9999` → child iteration ceiling |
| event/notification wiring | kimi-code `agent.emitEvent` + `telemetry.track` (`src/agent/skill/index.ts::recordActivation`) | `skill.activated` event + `telemetry.track('skill_invoked', …)` — reuse for observability; sidecar stays authoritative |
| telemetry sinks | `packages/telemetry` (OTLP) | kimi-code `agent.telemetry.track`; optional |
| `argparse` CLI (`hermes curator`) | **out of scope for desktop standalone**; `/curator` → composer slash + UI | README.md convention; verb set preserved as `CuratorService` |
| curator core (lifecycle, sidecar, archive, backup, rollback, pinning, prompts, classification, reports) | **implement from scratch in TS** | grep of `packages/agent-core/src` finds no curator/archive/stale/usage-sidecar code; `src/agent/skill/` is activation-only |

**Most important:** every Python dependency has a TS equivalent or thin shim above; the
**feature logic itself has no TS counterpart anywhere** — parity must be test-defined.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **`web/src/hooks/use-skills.ts`** — add `useCuratorStatus()`, `useCuratorRun()`,
  `useCuratorPin()/useCuratorUnpin()`, `useCuratorAdopt()`, `useCuratorBackups()`,
  `useCuratorRollback()`, `useCuratorUsage()` following the existing
  `useSkills`/`useToggleSkill` TanStack Query pattern.
- **`web/src/routes/skills.tsx`** — `SkillsRoute` tabs are
  `builtin | market | stats | user`. Add a **Curator** tab reusing `PageTabs` +
  `skills.module.css` tokens: status header (enabled/paused/last-run/report path),
  state-count cards, per-skill state/pinned badges + pin/unpin + adopt, run/dry-run
  buttons, backup list + rollback confirm, REPORT.md preview via `MarkdownText`.
- **`web/src/components/skills/skill-usage-stats.tsx` + `web/src/hooks/use-analytics.ts`**
  — existing analytics surface; Curator tab additionally needs per-skill
  `use/view/patch/last_activity_at` from `.usage.json` (new `CuratorUsage` component).- **`web/src/lib/skill-origin.ts`** — already resolves `external | user | builtin`;
  extend/reuse for "agent-created / curator-managed" badges and `PROTECTED_BUILTIN_SKILLS
  = {"plan"}` affordances (disable archive for protected/hub/bundled).
- **`packages/protocol/src/hermes-api.ts`** — extend `SkillInfo` with optional `state`,
  `pinned`, `last_activity_at`, `use_count`, `view_count`, `patch_count`; add zod
  schemas `CuratorStatusResponse`, `CuratorRunResponse`, `BackupInfo`,
  `CuratorUsageResponse`.
- **`web/src/lib/gateway-client.ts` + `web/src/hooks/use-gateway.ts`** — subscribe to
  `curator.run.completed` / `curator.state.changed` for toasts + status refresh.
- **Rust (`src/commands/`)** — Phase 2 adds fs/archive primitives
  (`write_usage_sidecar`, `snapshot_skills_tree`, `extract_skills_snapshot`,
  `move_skill_to_archive`, `restore_archived_skill`; extend `skills.rs`/`backup.rs`;
  `tempfile::TempDir`-validated per AGENTS.md). Phase 1 needs no new Rust commands.
- **`web/src/lib/composer-skills.ts`** — add `/curator` to the slash palette via
  existing `getLeadingSlashToken`/`replaceLeadingSlashToken` mechanics.
- **Cross-reference `plans/self-improvement-loop.md`** — Curator consumes skills written
  by the self-improvement review fork; share `usage-store.ts`, the `AsyncLocalStorage`
  `background_review` origin, and the `.usage.json` sidecar with that plan (single
  implementation, both features); the consolidation child agent reuses the same
  review-runner substrate.

## 7. Removing the WebSocket dependency (migration path)

1. **Phase 0 (today):** curator runs entirely in Python; desktop only sees
   `GET /api/skills` (with `usage` + `provenance`). Freeze existing `/api/skills*` REST
   contracts as the shared CRUD baseline.
2. **Phase 1 (TS service behind same interface, Python still authoritative):** add Core
   curator REST endpoints (new `hermes_cli/web_routers/curator.py` router):
   `GET /api/curator/status`, `POST /api/curator/run`,
   `PUT /api/curator/paused`, `POST /api/curator/pin|unpin|adopt|restore|archive|backup`,
   `POST /api/curator/rollback`, `GET /api/curator/backups`,
   `GET /api/curator/usage`, `POST /api/curator/prune`. Desktop consumes them through
   `transport.ts`; `CuratorService` is initially a REST client so the UI never depends
   on Python internals.
3. **Phase 2 (delete WS/REST path):** `CuratorService` runs fully in-process against the
   same `~/.hermes` sidecars; Rust commands own fs/tar I/O; events
   `curator.run.completed`/`curator.state.changed` replace status polling. Delete the
   curator REST router and the Python gateway curator tick (`gateway/run.py`
   `CURATOR_EVERY` block) after the desktop runtime owns cron + skill writes.

**Frozen interface:** `CuratorService.{status, run, setPaused, pin, unpin, adopt,
listUnmanaged, restore, listArchived, archive, prune, backup, listBackups, rollback,
usage, maybeRun}` + events `curator.run.completed` / `curator.state.changed`.

## 8. Migration phases & task breakdown

| # | Task | Phase | Verification |
|---|---|---|---|
| 1 | `types.ts`/`config.ts` + zod schemas in `packages/protocol` | 1 | vitest: defaults match `config_defaults.py` |
| 2 | Core curator REST router + desktop hooks | 1 | vitest + E2E: status/pin/backup round-trips |
| 3 | Curator tab in `routes/skills.tsx` | 1 | Playwright E2E |
| 4 | `/curator` composer slash entry | 1 | E2E: `/curator status` renders summary |
| 5 | `usage-store.ts` (atomic + lock + zod + corrupt tolerance) | 2 | vitest port of `tests/tools/test_skill_usage.py` |
| 6 | `lifecycle.ts` pure transitions | 2 | vitest parity with `tests/agent/test_curator.py` / `test_curator_activity.py` |
| 7 | `classify.ts` + rename summary | 2 | vitest parity with `tests/agent/test_curator_classification.py` |
| 8 | `report.ts` (run.json/REPORT.md/cron_rewrites.json) | 2 | vitest parity with `tests/agent/test_curator_reports.py` |
| 9 | `prompts.ts` fixtures + `review-runner.ts` child agent | 2 | integration with fake LLM; restricted-tool denial |
| 10 | `backup.ts` + Rust fs/tar commands | 2 | vitest + Rust `tempfile::TempDir` parity with `tests/agent/test_curator_backup.py` |
| 11 | `scheduler.ts` + `service.maybeRun` gates | 2 | unit: first-run seed, interval, idle, paused |
| 12 | Cut over: delete curator REST + Python gateway tick; docs update | 3 | full E2E against in-process service |

## 9. Risks & open questions

- **No kimi-code equivalent for the curator core (main risk).** kimi-code has skill
  *activation* (`src/agent/skill/index.ts`), background *tasks* (`src/agent/background/`),
  and `telemetry.track('skill_invoked')` — but no skill lifecycle, usage sidecar,
  archive, backup/rollback, pinning, or LLM consolidation. All from-scratch TS; parity
  is test-defined (same conclusion as `plans/self-improvement-loop.md`).
- **Cross-process locking during hybrid.** `fcntl`/`msvcrt` locks and TS lockfiles are
  incompatible; enforce a single writer per store during Phase 1/2.
- **tar.gz snapshots in the webview.** Tauri CSP/webview sandbox may block Node tar;
  prefer Rust `tar`/`flate2` commands (reuse `src/commands/backup.rs`) and port the
  path-traversal guards from `curator_backup.py` (absolute paths / `..` components).
- **LLM consolidation fork is heavy.** Python uses `max_iterations=9999` and reports
  50–100 API calls per sweep; TS child must reproduce request bytes for prefix-cache
  warmth and never persist its harness turn (`persistDisabled`) — the "curator-takeover"
  bug class flagged in self-improvement-loop.md §9.
- **Cron skill-reference rewrite ownership.** Python rewrites `cron/jobs.json` on
  consolidation and surgically restores it on rollback; the desktop's cron model
  (`src/commands/cron_runs.rs`) may differ. Open question: does Phase 2 TS curator
  rewrite cron refs itself or delegate until cron is also ported?
- **No curator REST surface today.** Desktop must define new endpoints (Phase 1) or go
  in-process early; `GET /api/skills` only carries `usage`/`provenance`.
- **Spec/test path mismatch.** `tests/tools/test_curator*.py` does **not** exist; real
  tests are `tests/agent/test_curator*.py` + `tests/tools/test_skill_usage.py` — parity
  tests target those actual files.
- **Open questions:** (a) adopt `auxiliary.curator.*` aux-model routing in Phase 2 or
  main-model-only first? (b) render REPORT.md inline in chat or only in the Curator tab?
  (c) keep `curator.prune_builtins` ON and honor `.curator_suppressed` in the update
  re-seeder (`scripts/stage-bundled-skills.mjs`)?

## 10. Test strategy

- **Vitest unit (web/src/lib/curator/):** `usage-store.test.ts` (round-trip, crash
  safety, corrupt tolerance, concurrent bump — port of `tests/tools/test_skill_usage.py`);
  `lifecycle.test.ts` (transitions, pin/cron exemptions, grace floor, seeding — port of
  `tests/agent/test_curator.py` + `test_curator_activity.py`); `classify.test.ts`
  (port of `tests/agent/test_curator_classification.py`); `report.test.ts` (port of
  `tests/agent/test_curator_reports.py`); `prompts.test.ts` (byte-identical constants vs
  `agent/curator.py`); `config.test.ts`/`service.test.ts` (defaults vs
  `config_defaults.py`, first-run seed, interval/idle/paused gates, run_count — port of
  `tests/hermes_cli/test_curator_run.py` + `test_curator_recent_run_notice.py`).
- **Rust integration (tests/, `tempfile::TempDir` + wiremock):** snapshot/rollback
  commands — keep-pruning with `protect_ids`, pre-rollback safety snapshot, tar
  path-traversal rejection, cron-jobs capture + surgical skill-link restore; parity with
  `tests/agent/test_curator_backup.py`.
- **Playwright E2E (e2e/, real Core + fake model):** Curator tab renders status/state
  badges; pin/unpin survives reload; dry-run produces REPORT.md; backup→rollback
  restores a removed skill; `/curator status` renders a summary; events refresh status.
- **Parity harness:** run the Python clusters (`tests/agent/test_curator*.py`,
  `tests/hermes_cli/test_curator_*.py`, `tests/tools/test_skill_usage.py`) against the
  TS modules with identical JSON fixtures; CI gates on `web-test.yml` + `rust-test.yml`
  + `web-e2e.yml`.
## 11. Reference links

- Python (D:/hermes-agent-cn): `agent/curator.py`, `agent/curator_backup.py`,
  `tools/skill_usage.py`, `hermes_cli/curator.py`, `hermes_cli/cli_commands_mixin.py`
  (`_handle_curator_command`), `hermes_cli/web_routers/skills.py`,
  `hermes_cli/config_defaults.py`, `hermes_cli/config_migrations.py` (v22→v23),
  `gateway/run.py` (`CURATOR_EVERY`), `cron/jobs.py` (`rewrite_skill_refs`).
- Docs: `website/docs/user-guide/features/curator.md`;
  `website/docs/user-guide/features/skills.md` (self-improvement loop).
- Tests (actual paths): `tests/agent/test_curator.py`, `test_curator_activity.py`,
  `test_curator_backup.py`, `test_curator_classification.py`, `test_curator_reports.py`;
  `tests/tools/test_skill_usage.py`; `tests/hermes_cli/test_curator_{status,run,usage,
  archive_prune,recent_run_notice}.py`. ⚠️ `tests/tools/test_curator*.py` does not exist.
- TS reference (D:/kimi-code): `packages/agent-core/src/agent/background/index.ts`,
  `src/agent/background/agent-task.ts`, `src/agent/skill/index.ts` +
  `src/agent/skill/types.ts`, `src/services/skill/skill.ts`, `src/session/subagent-host.ts`,
  `src/services/event/`, `packages/telemetry`.
- Desktop (D:/Hermes-CN-Desktop): `web/src/hooks/use-skills.ts`,
  `web/src/routes/skills.tsx`, `web/src/components/skills/skill-usage-stats.tsx`,
  `web/src/lib/{skill-origin,composer-skills,gateway-client}.ts`,
  `web/src/hooks/use-gateway.ts`, `packages/protocol/src/hermes-api.ts`,
  `src/commands/{skills,backup}.rs`; cross-reference `plans/self-improvement-loop.md`.
