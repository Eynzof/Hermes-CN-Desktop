# Context Files — Python → TypeScript Rewrite Plan

## 1. Summary

Port Hermes Agent's **context-files** feature to the in-process TypeScript runtime so the
React webview can discover, scan, truncate, and inject project context files without the
Python backend. The feature covers:

- Auto-discovery of `.hermes.md` / `HERMES.md` (walks to git root), `AGENTS.md` (merged
  git-root→cwd chain + progressive subdirectory discovery during the session), `CLAUDE.md`
  (cwd only), `.cursorrules` + `.cursor/rules/*.mdc` (cwd only), and global `SOUL.md`
  (from `HERMES_HOME` only).
- A **priority system**: only one project-context type is loaded per session
  (`.hermes.md` → `AGENTS.md` → `CLAUDE.md` → `.cursorrules`); `SOUL.md` is independent
  and always loaded as identity slot #1.
- **Prompt-injection scanning** of every context file (block-with-placeholder, never
  silently inject), and **truncation limits** (explicit `context_file_max_chars` config
  wins; otherwise a dynamic cap scaled to the model window, floor 20K / ceiling 500K
  chars; 70/20 head/tail split with a marker; 8K cap for subdirectory hints).

Two naming corrections discovered while reading the code:

1. `agent/context_engine.py` is the **context compression engine** (ContextEngine ABC,
   compaction/`select_context` hooks) — it is NOT the context-files feature. The real
   implementation is `agent/prompt_builder.py` (`build_context_files_prompt` + per-file
   loaders), `agent/subdirectory_hints.py` (`SubdirectoryHintTracker`),
   `tools/threat_patterns.py` (scanner), `agent/system_prompt.py` (tier wiring),
   `agent/runtime_cwd.py` (cwd + install-tree guard), and `agent/coding_context.py`
   (`detect_project_facts` exposes `contextFiles` via gateway `project.facts`).
2. In kimi-code, `packages/agent-core/src/agent/context/` is message-context
   management (ContextMemory/compaction/projection), not context files. The real TS
   references are `packages/agent-core-v2/src/agent/profile/context.ts`
   (`loadAgentsMdForRoots`), `agentsMdReminderService.ts` (progressive discovery),
   `app/git/workTree.ts` (root discovery), and `profile/agentfile/*` (agent profiles +
   `SYSTEM.md` global prompt, the closest SOUL.md analog).

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`.

| File | Role |
|------|------|
| `agent/prompt_builder.py` | All startup context-file loading; `build_context_files_prompt()` (L2452), `_truncate_content` (L2208), `load_soul_md` (L2248), `_load_hermes_md` (L2282), `_agents_md_directory_chain` (L2310), `_load_agents_md` (L2337), `_load_claude_md` (L2392), `_load_cursorrules` (L2413), `_scan_context_content` (L56), `_find_git_root` (L83), `_find_hermes_md` (L99), cap resolution `_dynamic_context_file_max_chars` (L1531) / `_get_context_file_max_chars` (L1546), truncation-warning ContextVar `drain_truncation_warnings` (L1586) |
| `agent/subdirectory_hints.py` | `SubdirectoryHintTracker` — progressive discovery, appends `[Subdirectory context discovered: <rel>]\n<content>` to tool results; 8K/file cap; digest dedupe; excluded dirs; outside-workspace rejection; ancestor walk ≤ 5 |
| `tools/threat_patterns.py` | Shared threat scanner — scopes `all`/`context`/`strict`, `INVISIBLE_CHARS`, `MAX_SCAN_CHARS=65_536`, NFKC normalization, bounded `(?:\w+\s+){0,8}` filler; `scan_for_threats(content, scope)` returns pattern IDs |
| `agent/system_prompt.py` | Assembles **stable → context → volatile** tiers; calls `build_context_files_prompt(cwd=resolve_context_cwd(), skip_soul=_soul_loaded, context_length=_ctx_len, allow_install_tree_fallback=platform in ("cli","tui"))` (L628); SOUL.md goes into the stable tier as identity (L306-314) |
| `agent/runtime_cwd.py` | `resolve_context_cwd()` — `_SESSION_CWD` contextvar → `TERMINAL_CWD` env → `None` (fallback to launch dir); `_is_install_tree()` guard prevents loading the Hermes install tree's own AGENTS.md when the desktop/gateway falls back into it (#64590) |
| `agent/coding_context.py` | `detect_project_facts(root)` → `ProjectFacts.context_files` (AGENTS.md/CLAUDE.md/.cursorrules presence); `project_facts_for(cwd)` → `{root, manifests, packageManagers, verifyCommands, contextFiles}` served via gateway `project.facts` |
| `hermes_cli/config_defaults.py` | `"context_file_max_chars": None` (L535) — None means dynamic cap |
| `hermes_cli/web_server.py` | Profile REST endpoints incl. SOUL.md (`/api/profiles/{name}/soul`, GET/PUT) — the surface the desktop uses today |

Data flow:

1. **Session start**: `AIAgent._build_system_prompt()` → `build_system_prompt_parts()`
   (system_prompt.py). If `load_soul_md()` returns content it is appended to the **stable**
   tier and `_soul_loaded=True`; otherwise `DEFAULT_AGENT_IDENTITY` is used.
2. **Context tier**: `build_context_files_prompt(...)` loads project context with
   priority `_load_hermes_md or _load_agents_md or _load_claude_md or _load_cursorrules`
   (first non-empty wins), appends SOUL.md unless `skip_soul`, and wraps everything in
   `# Project Context\nThe following project context files have been loaded and should be followed:\n\n` + `"\n".join(sections)`.
3. **Per file**: UTF-8 read (BOM tolerated) → strip `.hermes.md` YAML frontmatter →
   `_scan_context_content` (blocks → `[BLOCKED: <name> contained potential prompt
   injection (<ids>). Content not loaded.]`) → `## <provenance>` header →
   `_truncate_content` (head 70%, tail 20%, marker with char counts + `read_file` hint).
4. **AGENTS.md chain**: `_agents_md_directory_chain` returns [git root → every
   intermediate dir → cwd]; each dir contributes first of `AGENTS.md`/`agents.md`;
   byte-identical content deduped; each section and the merged chain are truncated.
5. **During the session**: the tool executor calls `SubdirectoryHintTracker.check_tool_call(tool_name, args)` after each tool call; paths from `path`/`file_path`/`workdir` args and `terminal` command tokens; hint text is appended to the tool result (never the system prompt → prompt cache preserved).
6. **Truncation caps**: `context_file_max_chars` (config) → `max(20_000, min(ctx_len * 4 * 0.06, 500_000))` → 20_000.

## 3. Target TypeScript design

New module tree under `web/src/lib/context-files/` (pure, framework-free, zod-typed):

```
web/src/lib/context-files/
  types.ts              # ContextFileSource, LoadedContextFile, ContextFilesSnapshot, SubdirectoryHint
  fs.ts                 # FsProvider abstraction (stat/readText/readdir/readFile) — 2 impls (see §5)
  discovery.ts          # findGitRoot, findHermesMd, agentsMdDirectoryChain, loadAgentsMd,
                        #   loadClaudeMd, loadCursorRules, buildContextFilesPrompt (pure port)
  scan.ts               # threat-pattern port: INVISIBLE_CHARS, scopes, scanForThreats()
  truncate.ts           # resolveContextFileMaxChars(), truncateContent(), drainTruncationWarnings()
  soul.ts               # loadSoulMd(homeDir, contextLength), ensureDefaultSoul(homeDir)
  subdirectory-hints.ts # SubdirectoryHintTracker (port)
  index.ts              # ContextFilesService — the in-process orchestrator
```

Core signatures (pseudocode — no implementation):

```ts
interface ContextFilesService {
  buildContextFilesPrompt(opts: {
    cwd: string | null;            // null = fallback to configured cwd (TERMINAL_CWD equivalent)
    skipSoul: boolean;
    contextLength: number | null;  // model window → dynamic cap
    allowInstallTreeFallback: boolean;
  }): Promise<string>;             // exact "# Project Context..." block, or ""

  tracker(): SubdirectoryHintTracker; // session-scoped progressive discovery
}

interface FsProvider { stat(p): Promise<FileStat|null>; readText(p): Promise<string>; readdir(p): Promise<string[]>; }
```

Design decisions:

- **Keep the Python prompt bytes as the parity contract.** `buildContextFilesPrompt`
  must reproduce the `# Project Context` wrapper, `## <provenance>` headers, block
  placeholders, and truncation markers byte-for-byte so an in-process session is
  indistinguishable from today's backend-built prompt.
- **Session lifecycle**: `ContextFilesService` is created per agent session; the tracker
  seeds the cwd digest at construction (mirrors `SubdirectoryHintTracker.__init__`).
- **cwd resolution**: port `resolve_context_cwd()` (session-scoped cwd → `TERMINAL_CWD`
  equivalent from the runtime env → null) and `_is_install_tree()`; the desktop's default
  cwd is the install tree, so without an explicit cwd context discovery must be skipped
  (the live #64590 behavior), except `cli`/`tui` surfaces which set
  `allowInstallTreeFallback=true`.
- **Where it plugs into the in-process loop**: a new `SystemPromptService` (TS) assembles
  stable → context → volatile tiers; the tool executor hooks
  `tracker.checkToolCall(toolName, args)` after each tool call and appends the returned
  hint text to the tool result, preserving the Hermes behavior of inlining the hint
  content (kimi-code v2 instead injects a "read these files" system-reminder — see §9).
- **SOUL.md**: `loadSoulMd(homeDir)` reads `<HERMES_HOME>/SOUL.md`, seeds a default when
  missing, strips/truncates/scan-blocks like Python. `HERMES_HOME` for the active profile
  comes from the Rust `AppState`/path_resolver (profile dir) — see §6.

## 4. Data models & persistence

Context files are **derived, not stored**: nothing new goes into SQLite/IndexedDB. The
persisted/stateful pieces:

| Item | Storage | Notes |
|------|---------|-------|
| `SOUL.md` | File at `<HERMES_HOME>/SOUL.md` (per active profile) | Today REST `GET/PUT /api/profiles/{name}/soul`; in-process writes the file directly. Zod schema `ProfileSoulResponse {content, exists}` already exists (`packages/protocol/src/hermes-api.ts` ~L1160) — reuse for the local provider |
| `context_file_max_chars` | `config.yaml` (via existing `useConfig`/`useSaveConfig`) | Core default `None` → dynamic cap; keep `null | number` in the schema |
| `SubdirectoryHintTracker` state | In-memory per session | `loadedDirs: Set<Path>`, `loadedDigests: Set<sha256>`, warnings accumulator — no persistence |
| Truncation warnings | In-memory, drained per prompt build | Port the ContextVar isolation to an AsyncLocalStorage-equivalent so concurrent session builds don't leak warnings |
| `ProjectFacts.contextFiles` | Derived at session start | Already exposed as `project.facts` JSON; schema addition only if the UI starts showing it |

New zod schemas to add in `packages/protocol/src/hermes-api.ts`:

```ts
ContextFilesSnapshot = z.object({
  root: z.string().optional(),
  projectContext: z.string(),          // "# Project Context..." block or ""
  soul: z.object({ content: z.string(), exists: z.boolean() }).optional(),
  contextFiles: z.array(z.string()),   // provenance labels, e.g. ["AGENTS.md", "../AGENTS.md"]
  warnings: z.array(z.string()),
});
```

No schema migrations are required (no persisted DB schema changes).

## 5. Third-party library strategy

Most important section. Evidence is read from `D:/kimi-code`.

| Python dependency | TS equivalent | kimi-code evidence |
|-------------------|---------------|--------------------|
| `pathlib.Path` / `os.path` | `pathe` (cross-platform path utils) or Node `node:path` | `packages/agent-core-v2/src/agent/profile/context.ts` (L1: `import { basename, dirname, join, normalize } from 'pathe'`), `packages/agent-core/src/profile/agentfile/roots.ts`, `app/git/workTree.ts` all use `pathe` |
| `hashlib.sha256` (digest dedupe) | `node:crypto` `createHash('sha256')` | Not evidenced in kimi-code (they dedupe by normalized path `seen: Set<string>` in `loadAgentsMdForRoots`), but Node builtin — no npm dep needed |
| Git root discovery (`_find_git_root`, `_git_root`) | **fs-based walk, no git binary**: `findGitWorkTree(fs, cwd)` | `packages/agent-core-v2/src/app/git/workTree.ts` — walks up for `.git` dir OR `.git` **file** and parses `gitdir:` worktree pointer (L46-53); also `profile/agentfile/roots.ts` `findProjectRoot`. This beats shelling out; port it and note the Python gap (Python only checks `.exists()`, doesn't parse `gitdir:`) |
| Git status/branch (only if ProjectFacts port needs it) | `child_process.spawnSync(git, [...], {timeout})` with resolved absolute git binary | `apps/kimi-code/src/utils/git/git-status.ts` — `spawnSync` + `resolveCommandPath('git', workDir)` (L75), 500ms timeout, TTL caches (L13-16) |
| `re` + threat-pattern table | **NO TS equivalent found — port `tools/threat_patterns.py` to a TS regex table from scratch** | Grep across kimi-code found no context-file injection scanner (`sanitize`/`threat`/`prompt injection` hits are provider/kosong error handling and telemetry, not context scanning). Port: `INVISIBLE_CHARS` set, `MAX_SCAN_CHARS` slicing, `String.prototype.normalize('NFKC')`, scope sets (`all` ⊂ `context` ⊂ `strict`), bounded filler `(?:\w+\s+){0,8}` (keep the ReDoS hardening + the long-near-miss perf test) |
| `unicodedata.normalize("NFKC", ...)` | `String.prototype.normalize('NFKC')` | Standard JS; no lib |
| `shlex.split` (terminal path extraction) | Simple tokenizer first; optionally kimi-code's bash parser | `packages/agent-core-v2/src/agent/agentsMdReminder/agentsMdReminderService.ts` uses internal `IBashParserService.parse(command, {timeoutMs: 20, maxNodes: 10_000})` + `extractBashTargetDirs` (L192-206). Their parser is heavier than needed; recommend the Python-equivalent tokenizer, keep bash-target extraction as a follow-up |
| YAML frontmatter strip (`.hermes.md`) | Hand-rolled `---` scan (no YAML lib) | `packages/agent-core/src/profile/agentfile/parser.ts` parses agent-file frontmatter in-house; `_strip_yaml_frontmatter` in Python is a simple delimiter scan, so hand-rolling preserves parity |
| `os.scandir` / filesystem stat | `FsProvider` abstraction; Node impl via Rust IPC or `node:fs/promises` in the runtime host | kimi-code wraps everything in `IHostFileSystem` (`packages/agent-core-v2/src/os/interface/hostFileSystem.ts`) and passes `{fs}` deps into `loadAgentsMdForRoots` — same pattern (`profile/context.ts` L137) |
| Prompt assembly/caching | `@hermes/protocol` zod + new `SystemPromptService` | `packages/agent-core/src/services/prompt/prompt.ts` + `promptService.ts` (session prompt build/cache); v2 `profile/profileService.ts` holds `agentsMd`/`agentsMdWarning` in a state service |
| `.cursorrules` / `.cursor/rules/*.mdc` | **Implement from scratch** | kimi-code has NO `.cursorrules` support (grep only matched a `.mdc` syntax-highlight grammar asset in `dist-web`). This is a Hermes-specific compatibility surface |

**Conclusion**: the only genuinely missing TS dependency is the threat scanner (port the
regex table) and the Cursor-rule file support (trivial glob+read). Everything else maps to
`pathe` + Node builtins + kimi-code's fs-abstraction pattern.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **`web/src/hooks/use-soul.ts`** — keep the hook signature; swap the query/mutation source
  from `/api/profiles/{name}/soul` REST to the local `ContextFilesService` (or a Rust
  command pair `read_soul` / `write_soul` behind the same `ProfileSoulResponse` shape).
  `SOUL_CHAR_LIMIT = 20_000` in `use-soul.ts` already matches Core's
  `CONTEXT_FILE_MAX_CHARS` default — keep in sync via one constant.
- **`web/src/routes/soul.tsx` + persona market (`components/persona/persona-market-panel.tsx`)
  + profile soul dialog (`components/profiles/profile-editors.tsx`)** — unchanged UI;
  they already operate on `ProfileSoulResponse`. The in-process provider must preserve
  "empty file → `exists: false`" and the char-counter warning semantics.
- **`web/src/routes/settings.tsx`** — no context-files UI today (grep found zero
  context/SOUL references). Add a "Context files / 上下文文件" section driven by
  `useConfig` / `useConfigSchema` / `useSaveConfig`: pin `context_file_max_chars`, list
  discovered files (`ContextFilesSnapshot.contextFiles`), show block/truncation warnings.
- **`web/src/routes/guide.tsx`** — onboarding; optionally add a context-files tip card.
  No code change required for the feature itself.
- **`web/src/lib/local-provider-context.ts`** — name collision only: it is the local
  provider **context-window** warning (64K min), unrelated to context files. Do not
  reuse it; keep both modules separate.
- **Rust (`src/commands/*`)** — add thin fs commands for the webview's `FsProvider`
  (`fs_stat`, `fs_read_text`, `fs_readdir`, optionally `fs_walk`) using `tokio::fs`,
  plus `read_soul`/`write_soul` that resolve `<HERMES_HOME>/SOUL.md` via the existing
  `path_resolver.rs` / `profiles.rs` machinery. No new DB.
- **`packages/protocol`** — add `ContextFilesSnapshot` and reuse `ProfileSoulResponse`
  (`hermes-api.ts` L1160).
- **Existing gateway `project.facts`** (Core `coding_context.project_facts_for`) already
  returns `contextFiles`; the desktop currently never reads it. Keep it as the parity
  source for a future verify/status display, or replace with the in-process
  `detectProjectFacts` port.

## 7. Removing the WebSocket dependency (migration path)

Nothing in this feature rides `/api/ws` today (prompt assembly is server-side in the
Python process; SOUL.md goes over REST, not WS). The migration is about deleting the
Python process for prompt assembly, not a socket. Freeze this API surface during the
transition so the two implementations stay interchangeable:

1. `build_context_files_prompt(cwd, skip_soul, context_length, allow_install_tree_fallback)` — exact output bytes.
2. `GET/PUT /api/profiles/{name}/soul` → `{content, exists}` / `{ok}`.
3. `project.facts.contextFiles` — string list.

Phases:

- **Phase 1 (today)**: backend builds context files + SOUL; desktop reads SOUL via REST;
  `use-soul.ts` is the only frontend touchpoint.
- **Phase 2 (in-process behind an interface)**: `ContextFilesService` + `SystemPromptService`
  in `web/src/lib/context-files/`; `use-soul.ts` switches to the local provider behind a
  feature flag (`useLocalContextFiles`); Rust fs commands land; REST remains as fallback.
- **Phase 3 (delete backend path)**: drop the REST soul routes and server-side prompt
  assembly from the managed-runtime contract; `ContextFilesService` becomes the only
  implementation; the WS link can then be removed wholesale by the overarching effort.

## 8. Migration phases & task breakdown

- **P0 — Pure-function ports (no UI, no runtime wiring)**: `types.ts`, `fs.ts`
  (interface + mock), `scan.ts`, `truncate.ts`, `discovery.ts` (root discovery,
  hermes-md, AGENTS chain + dedupe, claude, cursorrules/mdc, `buildContextFilesPrompt`),
  `soul.ts`. Vitest parity suite for each.
- **P1 — Runtime integration**: `ContextFilesService` + `SystemPromptService` tier
  assembly; `SubdirectoryHintTracker` hooked to the in-process tool executor; cwd
  resolution + install-tree guard; warning isolation (AsyncLocalStorage).
- **P2 — Desktop surface**: Rust fs + soul commands; swap `use-soul.ts`; add the
  settings "Context files" section; protocol schemas; guide tip.
- **P3 — Decommission**: remove REST/WS server-side paths after the flag flips green in
  smoke tests; parity test against a frozen golden prompt corpus.

## 9. Risks & open questions

- **No TS equivalent for the threat scanner** — must port ~30 regexes + invisible-unicode
  + NFKC + scopes exactly; the ReDoS-hardening tests (`tests/tools/test_threat_patterns.py`
  `TestReDoSHardening`) are the canary. JS RegExp with the bounded `{0,8}` filler should
  port directly; verify with a perf test.
- **No `.cursorrules`/`.cursor/rules/*.mdc` support anywhere in kimi-code** — Hermes-only
  compatibility surface; implement from scratch (glob + read + scan + truncate). Low risk.
- **Spec path mismatch**: `tests/agent/test_context_files*.py` does not exist; the parity
  tests live in `tests/agent/test_prompt_builder.py`
  (`TestScanContextContent`, `TestTruncateContent`, `TestDynamicContextFileCap`,
  `TestBuildContextFilesPrompt`, `TestFindHermesMd`), `tests/agent/test_subdirectory_hints.py`
  (+ `test_subdirectory_hints_tilde.py`), `tests/tools/test_threat_patterns.py`,
  `tests/agent/test_system_prompt.py`, `tests/agent/test_platform_hint_desktop.py`,
  and `tests/test_hermes_home_profile_warning.py`.
- **Windows case-insensitive FS**: `CLAUDE.md` vs `claude.md` ordering is pinned by a
  Python test that skips on darwin; on Windows both names alias. TS must define an
  explicit uppercase-first policy and test it, not rely on readdir order.
- **Worktree `.git` file**: kimi-code parses `gitdir:` pointers; Python only checks
  `.exists()`. Decide whether the TS port matches kimi-code (better) or Python (parity).
- **Prompt cache stability**: context files are in the cached context tier; any drift in
  the dynamic cap (model `context_length` source) changes the cached prefix. The TS model
  catalog must supply `context_length` identically to Python's compressor (`_ctx_len`).
- **Tauri webview has no direct fs**: `FsProvider` reads must round-trip through Rust IPC;
  batch reads (AGENTS chain) to avoid N round-trips; keep the interface async.
- **Per-profile SOUL vs HERMES_HOME**: REST stores soul per profile; in-process must map
  the active profile to its HERMES_HOME dir. Port the `get_hermes_home()` profile fallback
  warning semantics (`tests/test_hermes_home_profile_warning.py`).
- **Subdirectory-hint injection style**: Python inlines content into the tool result;
  kimi-code v2 emits a system-reminder that tells the model to **read** the files instead
  (`agentsMdReminderService.ts` `reminderText`). Inlining keeps parity but consumes more
  context per turn; open question whether to adopt kimi-code's lighter approach.
- **Install-tree guard** (#64590) is desktop-critical: the app's default cwd is the
  install tree, and without the guard the desktop repo's own `AGENTS.md` would be injected
  as authoritative project context. Port `_is_install_tree` + `TERMINAL_CWD` handling
  before any UI work.

## 10. Test strategy

- **Vitest unit parity** (mirror the Python tests 1:1):
  - `scan.test.ts` ← `tests/tools/test_threat_patterns.py` (scopes, Brainworm payload,
    false-positive guards, ReDoS timing < 0.5s, NFKC homograph, invisible unicode).
  - `truncate.test.ts` ← `TestTruncateContent` + `TestDynamicContextFileCap` (70/20 split,
    marker text, config-beats-dynamic, 200K window → 48K cap).
  - `discovery.test.ts` ← `TestBuildContextFilesPrompt` + `TestFindHermesMd` +
    `TestFindGitRoot` (priority order, chain merge root→cwd, gap skip, identical-content
    dedupe, no-git-root stays cwd-only, install-tree skip on fallback, empty SOUL,
    CLAUDE.md uppercase priority, `.hermes.md` YAML frontmatter strip).
  - `subdirectory-hints.test.ts` ← `test_subdirectory_hints.py` + `_tilde.py` (discovery,
    no duplicate, terminal cd, relative path, workdir arg, 8K truncation, excluded dirs,
    outside-workspace rejection, PermissionError tolerance, symlink/identical-copy dedupe,
    `~500-700` no-crash).
  - `soul.test.ts` ← `test_hermes_home_profile_warning.py` + `load_soul_md` behavior
    (default seed, empty → nothing, profile fallback warning once).
  - `system-prompt.test.ts` ← `test_system_prompt.py` + `test_platform_hint_desktop.py`
    (cwd wiring: `TERMINAL_CWD` vs null; `skip_soul`; desktop platform hint intact).
- **Golden-prompt parity harness**: run Python `build_context_files_prompt` on a fixture
  tree, store the output; assert the TS output is byte-identical for the same tree.
- **Playwright E2E**: settings "Context files" section renders discovered files and a
  blocked-file placeholder; `/soul` editor still saves/truncates.
- **Rust tests**: fs commands (tempdir, wiremock-free) per the repo's `#[cfg(test)]`
  conventions; no network.

## 11. Reference links

- `D:/hermes-agent-cn/agent/prompt_builder.py` (L56-139 scan/discovery, L1516-1593 caps+warnings, L2203-2529 loaders+builder)
- `D:/hermes-agent-cn/agent/subdirectory_hints.py`
- `D:/hermes-agent-cn/tools/threat_patterns.py`
- `D:/hermes-agent-cn/agent/system_prompt.py` (L299-314 stable/SOUL, L617-633 context tier)
- `D:/hermes-agent-cn/agent/runtime_cwd.py` (L60-100 cwd resolution + install-tree)
- `D:/hermes-agent-cn/agent/coding_context.py` (L765-862 ProjectFacts)
- `D:/hermes-agent-cn/website/docs/user-guide/features/context-files.md`
- `D:/hermes-agent-cn/website/docs/developer-guide/prompt-assembly.md`
- `D:/hermes-agent-cn/website/docs/user-guide/configuration.md` (L688-697 `context_file_max_chars`)
- Tests: `tests/agent/test_prompt_builder.py`, `tests/agent/test_subdirectory_hints.py`,
  `tests/agent/test_subdirectory_hints_tilde.py`, `tests/tools/test_threat_patterns.py`,
  `tests/agent/test_system_prompt.py`, `tests/agent/test_platform_hint_desktop.py`,
  `tests/test_hermes_home_profile_warning.py`
- kimi-code: `packages/agent-core-v2/src/agent/profile/context.ts`
  (`loadAgentsMdForRoots`, `dirsRootToLeaf`, `findAgentsMdInDir`, `AGENTS_MD_RECOMMENDED_MAX_BYTES`),
  `packages/agent-core-v2/src/agent/agentsMdReminder/agentsMdReminderService.ts`,
  `packages/agent-core-v2/src/workspace/workspaceInstructions/workspaceInstructionsService.ts`,
  `packages/agent-core-v2/src/app/git/workTree.ts`,
  `packages/agent-core/src/profile/agentfile/{roots,discovery,system-file,from-file,parser}.ts`,
  `apps/kimi-code/src/utils/git/git-status.ts`
- Desktop: `web/src/hooks/use-soul.ts`, `web/src/routes/soul.tsx`, `web/src/routes/settings.tsx`,
  `web/src/routes/guide.tsx`, `web/src/lib/local-provider-context.ts` (name collision),
  `packages/protocol/src/hermes-api.ts` (L1160 `ProfileSoulResponse`),
  `src/commands/profiles.rs`, `src/path_resolver.rs`
