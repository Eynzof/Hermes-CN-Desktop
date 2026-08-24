# Plan: Rewrite skill-lint from TypeScript to Rust (`src/`)

- Status: Draft
- Source: `packages/skill-lint/src/...`
- Target Rust: `src/skill_lint/` (+ optional `src/bin/skills_lint.rs` binary in the same crate)
- Author: analysis subagent
- Date: 2026-08-24

## 1. Executive summary

**Yes — `packages/skill-lint` qualifies for a Rust rewrite.** It is a small
(6 source files, ~390 LOC excluding tests; 1,087 LOC incl. tests), pure
text/frontmatter-processing package with zero webview-runtime coupling:

- `frontmatter.ts` is a hand-rolled YAML-subset parser (BOM strip, fence regex,
  indentation-based maps, inline/block lists) — deterministic text processing.
- `rules.ts` has 12 deterministic regex/string/Set rules over frontmatter + body.
- `lint.ts` orchestrates the rules; `cli.ts` is a tiny arg parser (`--source`,
  `--json`) with exit-code semantics.
- The only consumers are the repo-root CLI script `scripts/skill-lint.mjs`
  (`pnpm skills:lint` → `node scripts/skill-lint.mjs`) and (for the frontmatter
  parser only) the planned agent-core skills-loader migration. **No web/package
  code imports `@hermes/skill-lint` at runtime**, so the browser-only-dev
  constraint ("same TS runtime with no Rust") does not block a native CLI.

Two honest caveats that shape scope:

1. **Today the CLI's `lintTree` is a stub** — `lintTree()` returns an empty
   `LintResult` without walking the filesystem (browser-safe stub in
   `lint.ts:55`). `pnpm skills:lint` therefore does not actually lint a skill
   tree yet. A Rust rewrite is the natural opportunity to implement the real
   tree walk + disk checks (forbidden files, dangling references) that the TS
   side deliberately left stubbed.
2. **Value is correctness/CLI quality, not hot-path speed.** SKILL.md linting
   is a dev-time/CI task over a bounded set of markdown files; a single-threaded
   Rust binary is already effectively instant. The perf win of "fast +
   parallelizable" is real but secondary; the primary wins are one native
   binary, real fs linting, one source of truth for frontmatter parsing, and
   removal of a hand-rolled YAML-subset parser that is duplicated in
   `packages/agent-core/src/skills/loader.ts` and `packages/shared-ui/src/tokens/skins.ts`.

Recommended scope: port parser + 12 rules + tree walk + CLI to Rust **inside the
existing single crate** (`src/skill_lint/` module + one `[[bin]]` target), keep
the TS package as a thin parity-checked fallback for browser-only dev, and route
the shared frontmatter parser through the same Rust module for the agent-core
skills-loader migration (already proposed in `plans/rust-rewrite-agent-core.md`
§4.3/§5).

## 2. Why rewrite (value/motivation; honest)

| Motivation | Assessment |
|---|---|
| Pure text/frontmatter processing | Genuine: parser + rules are deterministic string/regex work with no I/O except future fs walking. Idiomatic Rust (`regex`, `serde_yaml`/hand-ported subset, `std::fs`, rayon optional). |
| Fast + parallelizable | True but low-stakes: linting a skills tree is dev/CI-time. Real benefit is offloading from Node startup (V8 boot + ESM graph) to a ~1 MB native binary, not CPU parallelism. If trees grow to thousands of skills, rayon over skill files is a cheap later add. |
| Native CLI (`pnpm skills:lint`) | Real win: replaces `node scripts/skill-lint.mjs` with a compiled binary; no Node runtime needed in CI; deterministic behavior. |
| Functional gap | Big win: `lintTree` is a stub today. The Rust CLI can implement real tree walking + disk-based checks (`forbidden-file`, `dangling-reference`) that the TS browser-safe stub cannot. |
| Dedupe hand-rolled YAML-subset parsers | Win: the same parser shape exists in `packages/skill-lint/src/frontmatter.ts`, `packages/agent-core/src/skills/loader.ts`, and `packages/shared-ui/src/tokens/skins.ts` (each a slightly different subset). A single Rust module can become the source of truth for skill metadata parsing; Rust already depends on `serde_yaml` (used in `src/commands/dashboard_api.rs`, `commands/memory.rs`, `commands/model_config.rs`). |
| Speed | Honest: negligible for typical skill counts (10s–100s of files). Do NOT use speed as the primary justification. |

Net: rewrite the parser + rules + CLI as a native binary, primarily for the
native CLI/CI experience and one source of truth, secondarily for parallelism
headroom. Keep the TS library for browser-only dev and parity tests.

## 3. Scope (in-scope / out-of-scope)

### In-scope

- `packages/skill-lint/src/frontmatter.ts` → `src/skill_lint/frontmatter.rs`
  (parse `---` fences, BOM strip, CRLF, inline lists `[a, b]`, block lists,
  nested maps, quoted-scalar passthrough; keep TS quirks for parity, see §5).
- `packages/skill-lint/src/rules.ts` → `src/skill_lint/rules.rs`
  (all 12 checks: `name-format`, `name-dir-mismatch`, `description-length`,
  `description-marketing`, `missing-metadata`, `author-caps`,
  `shell-utility-reference`, `missing-section`, `dangling-reference`,
  `platforms-gating`, `forbidden-file`, `platforms-value`, `related-skills`).
- `packages/skill-lint/src/lint.ts` → `src/skill_lint/lint.rs`
  (`lint_skill_content`, `has_errors`, `format_findings`, and a **real**
  `lint_tree` that walks `roots` recursively for `SKILL.md` files, aggregates
  findings, and implements the disk checks the TS side stubbed).
- `packages/skill-lint/src/cli.ts` → `src/bin/skills_lint.rs`
  (`--source <dir>...`, `--json`, human summary, exit 1 on any `error`,
  exit 0 otherwise — byte-compatible with the TS CLI contract, incl.
  `--source` positional collection stopping at the next `--flag`).
- `packages/skill-lint/src/types.ts` → `src/skill_lint/types.rs`
  (serde types mirroring `LintFinding`, `LintOptions`, `LintResult` v1).
- Keep `packages/skill-lint/` TS source as the browser-only fallback and parity
  oracle (do not delete).

### Out-of-scope (explicitly)

- Do **not** create a new external crate; add `src/skill_lint/` module + one
  `[[bin]]` target in the existing `Cargo.toml` (crate `hermes_agent_cn`).
  New deps only if justified: `walkdir` (or std `WalkDir` hand-rolled) and
  optionally `rayon`; `clap` optional (TS CLI is hand-rolled; keep parity).
- Do **not** move `@hermes/skill-lint` import graph into webview code — no
  consumers need it; the IPC command (Phase 4) is optional and only for the
  future agent-core skills-loader migration.
- Do **not** rewrite `packages/shared-ui` (see `plans/rust-rewrite-shared-ui.md`),
  though the shared frontmatter parser may later serve its skins parser if the
  skins module is ever extracted to a headless package.
- Do **not** change lint rule semantics without an explicit decision — parity
  with the 13 vitest rule tests is the default contract (§8).

## 4. Current contract (TS exports, types, consumers, invariants)

### Exports (`packages/skill-lint/src/index.ts`)

- `parseFrontmatter(content): { frontmatter: SkillFrontmatter; body: string }` —
  throws `Error("missing frontmatter")` when no valid `---` fence pair.
- 12 `checkXxx(frontmatter, body?, opts?)` rule functions (each returns
  `LintFinding[]`).
- `lintSkillContent(content, opts?): LintFinding[]` — parses, catches parse
  errors into a single `{ severity: "error", rule: "frontmatter", message }`
  finding, then runs all rules.
- `hasErrors(findings): boolean`.
- `formatFindings(findings): string` — `"✗ [rule] msg"` / `"⚠ [rule] msg"` lines.
- `lintTree(roots, opts?): LintResult` — **stub**: returns empty
  `{ version: 1, roots, skills: [], totals: { errors: 0, warnings: 0 } }`.
- `runCli(argv): Promise<number>` (exported from `cli.ts`, consumed by
  `scripts/skill-lint.mjs`).

### Types (`types.ts`)

- `LintSeverity = "error" | "warning"`.
- `LintFinding = { severity; rule: string; message: string }`.
- `SkillFrontmatter` — optional `name/description/version/author/license`,
  `platforms?: string | string[]`, `metadata?.hermes?.tags/related_skills`,
  `related_skills?: string[]`, plus `[k: string]: unknown`.
- `LintOptions = { skillDir?: string; allNames?: string[] }`.
- `LintResult = { version: 1; roots: string[]; skills: { path; name?; findings[] }[]; totals }`.

### Consumers

- `scripts/skill-lint.mjs` — the only production consumer (root `package.json`
  `"skills:lint": "node scripts/skill-lint.mjs"`).
- (Planned) `plans/rust-rewrite-agent-core.md` §4.3: `packages/agent-core/src/skills/loader.ts`
  has a second `parseFrontmatter` variant; the plan routes skill metadata
  parsing through the same Rust command.
- Nothing in `web/` or any other `packages/*` imports `@hermes/skill-lint`
  (verified by repo-wide grep).

### Invariants (from vitest tests — must survive the port)

- Fence regex `^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$`; `---\n---` (no body
  newline) is NOT a match → "missing frontmatter".
- BOM stripped before matching; CRLF preserved in body.
- Quoted scalars are kept literally (`version: "1.0.0"` → `'"1.0.0"'`), not
  unquoted — **this differs from `serde_yaml` semantics** (see §5 design choice).
- Inline lists `[a, b,  c]` → trimmed array; empty `[]` → `[]`.
- Block lists under an empty key; nested maps (`metadata.hermes.tags`).
- Unknown/non-key-value lines skipped; comments skipped.
- Rules: `name-format` error regex `^[a-z0-9_\-]+$` (empty string errors);
  `name-dir-mismatch` normalizes `\` → `/` and skips trailing-slash dirs;
  description limit 60 chars; marketing words list (6 words, case-insensitive
  substring); missing-metadata aggregates `version/author/license/metadata.hermes.tags`;
  author-caps regex `/[A-Z]{2,}/`; shell-utility-reference strips fenced +
  inline code blocks then word-boundary case-insensitive match against 13
  utilities; missing-section requires `## When to Use`; dangling-reference and
  forbidden-file are **stubs in browser mode** (no findings with/without
  skillDir); platforms-gating (POSIX primitives only when `scripts/` referenced
  and no platforms); platforms-value whitelist `{linux, macos, windows, darwin}`
  (scalar or array); related-skills resolves against `allNames` (from either
  `metadata.hermes.related_skills` or top-level `related_skills`).
- CLI: default root `["."]`; `--source` collects positionals until next `--`;
  `--json` prints `JSON.stringify(result, null, 2)`; human mode prints per-skill
  findings + `Totals: N errors, M warnings`; exit 1 iff any error finding.
- No env vars, no network, no timestamps — fully deterministic.

## 5. Rust design (module layout, public API, serde types, state handling)

```
src/
├── skill_lint/
│   ├── mod.rs            # pub use; lint_skill_content, has_errors,
│   │                     # format_findings, lint_tree (real fs walk)
│   ├── types.rs          # #[derive(Serialize, Deserialize, Debug, PartialEq)]
│   │                     # LintSeverity, LintFinding, SkillFrontmatter,
│   │                     # LintOptions, LintResult (version: u8 = 1)
│   ├── frontmatter.rs    # parse_frontmatter(&str) -> Result<(SkillFrontmatter, String), LintError>
│   │                     #   (fence regex via `regex`, BOM strip, indent-based
│   │                     #    subset parser — port of frontmatter.ts)
│   ├── rules.rs          # 13 pure fns: check_name_format(...) -> Vec<LintFinding>,
│   │                     # ... each mirroring rules.ts exactly
│   ├── tree.rs           # walk_tree(roots) -> Vec<PathBuf> (SKILL.md files);
│   │                     # forbidden-file + dangling-reference disk checks;
│   │                     # name-dir-mismatch from real dir basename
│   └── cli.rs            # pure arg parsing: parse_args(argv) -> CliArgs
│                         #   { sources: Vec<String>, json: bool }
└── bin/
    └── skills_lint.rs    # [[bin]] hermes-agent-cn-skills-lint:
                          #   parse args → lint_tree → print (JSON|human) → exit code
```

Public Rust API (all pure, no `AppState`/Tauri dependency — usable from unit
tests, integration tests, the bin target, and an optional Tauri command):

```rust
// src/skill_lint/mod.rs
pub fn lint_skill_content(content: &str, opts: &LintOptions) -> Vec<LintFinding>;
pub fn has_errors(findings: &[LintFinding]) -> bool;
pub fn format_findings(findings: &[LintFinding]) -> String;
pub fn lint_tree(roots: &[PathBuf], opts: &LintOptions) -> LintResult; // real fs walk
```

**Frontmatter parser design decision (parity-first):** port the existing
hand-rolled YAML-subset exactly (indentation map + inline/block lists + quoted
scalar passthrough) so the Rust output is identical to the TS `parseFrontmatter`.
Do **not** silently swap to `serde_yaml`: `serde_yaml` unquotes scalars and is a
full YAML parser — behavior differs (e.g. `version: "1.0.0"`), which would break
vitest parity and change lint messages. A shared `src/frontmatter/` module can
be factored out later to serve agent-core's `skills/loader.ts` migration; keep
the parser generic over "frontmatter map" while skill-lint keeps its subset
semantics. (If the team decides to standardize on real YAML via `serde_yaml`,
that is a deliberate behavior change — gate it behind a decision + updated tests.)

**State handling:** none needed. All functions are stateless/pure; `lint_tree`
takes explicit `roots` + `LintOptions`. No `AppState`, no `Mutex`, no globals.

**Concurrency (optional):** keep Phase 1–3 single-threaded. If a future scale
need arises, `lint_tree` can `rayon::par_iter` over discovered `SKILL.md` files
with `Send + Sync` finding structs — but do not add the dep until measured.

**New Cargo deps (justify each):**
- `walkdir` (small, standard; or hand-roll a 20-line recursive walker to stay
  zero-dep) — for `tree.rs`.
- `serde_json` (already present) — JSON report + IPC.
- `regex` (already present) — fence + rule patterns (cache with `OnceLock`).
- Optional `clap` — **not required**; the TS CLI is hand-rolled and tests pin
  exact arg behavior; keep hand-rolled `parse_args` for parity.

## 6. IPC / boundary (Tauri commands; browser-only-dev fallback strategy)

- **CLI path (primary):** the `skills_lint` binary is invoked directly by
  `pnpm skills:lint`. Change `scripts/skill-lint.mjs` to spawn the binary, or
  change root `package.json` to `"skills:lint": "cargo run --quiet --bin skills_lint --"`,
  or ship a wrapper that runs the compiled binary when present and falls back to
  the TS `runCli` otherwise. Browser-only dev (`python run.py`) is **not**
  affected — the TS `@hermes/skill-lint` package stays intact and is only
  invoked by the script, never by webview code.
- **Tauri IPC (optional Phase 4):** add one command
  `#[tauri::command] fn lint_skill(skill_path: String) -> Result<LintResult, AppError>`
  in `src/commands/skill_lint.rs`, registered in `main.rs` `generate_handler!`.
  This is only needed when the agent-core skills-loader migration
  (`plans/rust-rewrite-agent-core.md`) routes SKILL.md parsing/validation
  through Rust; the webview would call it via `window.hermesDesktop` with a TS
  fallback (`packages/skill-lint/src/lint.ts` stub path) so browser-only dev
  still works. If the loader migration does not land, skip the command entirely.
- **Boundary rule:** never put `skill_lint` logic behind `tauri::State`; keep
  the module pure so the bin target and tests don't need a Tauri runtime.

## 7. Implementation phases (ordered, each shippable + testable)

1. **P1 — Types + frontmatter parser port** (`src/skill_lint/types.rs`,
   `frontmatter.rs`, `mod.rs` skeleton). Port the 20 frontmatter vitest cases as
   Rust unit tests (`#[cfg(test)]`); confirm identical parse results on a shared
   fixture table. *Effort: S.*
2. **P2 — Rules port** (`rules.rs`): all 12 (13 counting platforms-value)
   checks as pure fns; port the ~40 rule vitest cases as unit tests.
   *Effort: S.*
3. **P3 — Tree walk + lint aggregation** (`tree.rs` + `lint_tree`): real
   recursive `SKILL.md` discovery, name-dir-mismatch from disk, forbidden-file
   + dangling-reference disk checks (currently stubbed in TS), totals
   aggregation. Integration tests in repo-root `tests/skill_lint.rs` using
   `tempfile::TempDir` per AGENTS.md. *Effort: M.*
4. **P4 — CLI binary + TS↔Rust parity harness**: `src/bin/skills_lint.rs`,
   `parse_args`, JSON/human output, exit codes; wire `pnpm skills:lint`;
   add a vitest parity test that (when the binary is built / `SKILLS_LINT_BIN`
   env set) runs golden fixtures through both `runCli` and the binary and
   asserts identical exit code + normalized output. *Effort: S–M.*
5. **P5 (optional) — Tauri IPC command + agent-core loader dedupe**: if the
   agent-core skills-loader migration proceeds, factor the parser into
   `src/frontmatter/`, expose `commands::skill_lint::lint_skill`, keep a TS
   fallback behind the bridge. *Effort: S–M.*

## 8. Testing strategy (Rust unit/integration; TS↔Rust parity; vitest parity tests)

- **Rust unit tests** (`#[cfg(test)]`, per AGENTS.md): port every vitest case —
  20 frontmatter cases, 40+ rule cases, CLI arg parsing cases — as unit tests
  in the owning module; `pretty_assertions` for message diffs.
- **Rust integration tests** (`tests/skill_lint.rs`, crate `hermes_agent_cn`):
  `lint_tree` over `tempfile::TempDir` fixtures (nested skills, Windows `\`
  separators via `PathBuf`, forbidden files, dangling refs, related-skills
  resolution across the tree). No `/tmp`, no cwd writes, no network.
- **Env-dependent:** none expected (pure fs via TempDir); if a test ever needs
  the built binary, mark it `#[serial_test::serial]` and gate on env
  (mirror `tests/real_backend.rs` opt-in pattern).
- **TS↔Rust parity (vitest):** keep all existing vitest tests green; add
  `packages/skill-lint/src/parity.test.ts` that shells out to the built binary
  over a shared fixture set (guarded by `SKILLS_LINT_BIN`, skipped when unset)
  — same inputs → same findings/exit codes. This is the acceptance gate for P4.
- **CI:** extend existing `rust-test.yml` (fmt/clippy/test already run `cargo
  test`); `web-test.yml` continues to run vitest incl. parity test. No new CI
  job needed for the bin (cargo test builds it), only optionally a release
  artifact step to publish the binary.

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Parser parity drift (TS hand-rolled subset vs Rust port) | Port 1:1 first; golden fixture table shared by both; parity test shells the binary; do not swap to `serde_yaml` without a decision. |
| `lintTree` stub becomes real — behavior change in CLI output | This is the point (currently `pnpm skills:lint` reports 0 findings for every tree). Document the change; keep TS stub for browser-only fallback; version the `LintResult` (`version: 1`) so consumers can detect the change. |
| Adding `[[bin]]` target to the Tauri crate confuses release builds | Bin target is independent of `tauri`; ensure `cargo tauri build` unaffected (bin is additive). CI `cargo test` covers it. |
| Unicode/emoji in messages or file paths (Windows) | Use `String`/`PathBuf` lossless; existing rules are ASCII-focused; add a Windows-path integration test (`PathBuf` with `\`). |
| Optional rayon/clap deps bloat | Defer both until measured; keep zero-new-dep core (walkdir or hand-rolled walker). |
| Agent-core migration coupling | P1–P4 stand alone; P5 (shared `src/frontmatter/`) only when the agent-core plan lands, to avoid churn. |

## 10. Effort estimate (S/M/L per phase)

| Phase | Scope | Effort |
|---|---|---|
| P1 | Types + frontmatter parser port + unit tests | S |
| P2 | 12 rule functions port + unit tests | S |
| P3 | Tree walk + lint aggregation + integration tests | M |
| P4 | CLI binary + `pnpm skills:lint` wiring + parity harness | S–M |
| P5 (optional) | Tauri IPC command + agent-core loader dedupe | S–M |
| **Total** | | **M (S–M realistic; ~2–4 eng-days focused, plus parity/CI polish)** |

Cross-cutting note: the same shared native frontmatter parser (P5) is the
convergence point for `packages/agent-core/src/skills/loader.ts` and — if ever
extracted to a headless package — `packages/shared-ui/src/tokens/skins.ts`
(which also contains its own YAML-subset parser). See
`plans/rust-rewrite-shared-ui.md` §7 for that optional refactor.
