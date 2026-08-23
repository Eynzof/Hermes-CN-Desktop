# Context References — Python → TypeScript Rewrite Plan

## 1. Summary

The **context references** feature lets users attach inline `@` tokens to a message —
`@file:path`, `@file:path:10-25`, `@folder:path`, `@diff`, `@staged`, `@git:N`, `@url:…` —
which are expanded into attached context before the message reaches the model. Today the
desktop web app only does **detection + completion + token insertion** (`web/src/lib/composer-mentions.ts`)
and delegates everything else to the Python backend: completion goes over the WS `complete.path`
RPC (`tui_gateway/methods_complete.py`), and expansion happens inside the gateway at submit
time (`gateway/run.py` → `agent/context_references.py`).

This plan ports the **entire feature in-process** into the TypeScript frontend:

- a pure-TS parser + expander (`web/src/lib/context-references/`) that runs at submit time,
  replacing `agent/context_references.py`;
- a local completion engine replacing the `complete.path` RPC, keeping the existing
  `SlashCompletionItem` wire shape so `goose-composer.tsx` + `composer-mentions.ts` stay intact;
- filesystem / git / URL-fetch capabilities pushed to Rust Tauri commands (WebView2 has no
  Node), reusing `read_workspace_file` (already exists) and adding `git_capture` + a safe URL
  fetch command;
- security parity: sensitive-path blocking + fail-closed deny-list + workspace-root
  containment, all enforced in Rust and mirrored in TS.

Out of scope (recorded decision): plugin-registered `@<prefix>:` providers and docker-backend
path translation (`_agent_visible_path`) are gateway/CLI-only concerns; the desktop standalone
has no plugin registry or container backend yet.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`.

### 2.1 Expansion engine — `agent/context_references.py` (730 lines)

- **Plugin provider API** (lines 24–77): `ContextReferenceProvider` ABC
  (`prefix`, `autocomplete()`, `expand()`), `register_context_reference_provider`,
  `get_context_reference_providers`; `BUILTIN_PREFIXES = {"diff","staged","file","folder","git","url"}`.
- **Parsing** (lines 80–209): `REFERENCE_PATTERN` regex
  `(?<![\w/])@(?:(?P<simple>diff|staged)\b|(?P<kind>file|folder|git|url):(?P<value>…(?::\d+(?:-\d+)?)?…))`;
  `parse_context_references()` returns `ContextReference(raw, kind, target, start, end, line_start, line_end)`;
  `format_reference_value()` quotes values containing whitespace/brackets (`\s()[]{}<>"'`` `)
  with backtick/double/single quotes; `_strip_trailing_punctuation()` (`,.;!?` + balanced `)]}`);
  `_parse_file_reference_value()` handles `path:N` and `path:N-M` (1-indexed, inclusive).
- **Preprocessing** (lines 212–325): `preprocess_context_references` / `_async` expand all refs
  concurrently via `asyncio.gather`; token budget `hard = 50%`, `soft = 25%` of `context_length`
  (via `agent/model_metadata.estimate_tokens_rough`, ~4 chars/token, CJK/Hangul/Kana ≈ 1 token/codepoint,
  ceiling division); output appends `--- Context Warnings ---` and `--- Attached Context ---`
  sections; hard-limit → `blocked=True`, message returned unchanged.
- **Expanders** (lines 328–468): `_expand_file_reference` (read UTF-8 with `errors="replace"`,
  line slicing, code-fence language map, `📄` block, binary → actionable `📎` block with
  `_agent_visible_path` container mapping); `_expand_folder_reference` (tree listing, 200-entry
  cap with `- ...`, ripgrep-backed `_rg_files` via `ripgrepy` with `os.walk` fallback);
  `_expand_git_reference` (subprocess `git diff` / `git diff --staged` / `git log -N -p`, 30s
  timeout, `windows_hide_flags`); `_fetch_url_content` (default fetcher = `tools.web_tools.web_extract_tool`).
- **Security** (lines 471–533): `_resolve_path` (expanduser, resolve, `allowed_root` containment —
  defaults to cwd); `_ensure_reference_path_allowed`: narrow list `_SENSITIVE_HOME_DIRS/FILES`
  (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.azure`, `~/.config/gh`,
  `~/.ssh/id_rsa`, `~/.bashrc`, `~/.netrc`, `~/.pgpass`, `~/.npmrc`, `~/.pypirc`, …,
  `$HERMES_HOME/.env`, `$HERMES_HOME/skills/.hub`) **plus** the canonical deny-list
  `agent/file_safety.get_read_block_error()` (auth.json, `.anthropic_oauth.json`, `mcp-tokens/`,
  project-local `.env`, webhook secrets) — the canonical guard **fails closed** when it raises.
- **Binary detection** (lines 580–588): MIME guess + known-text extension bypass + NUL-byte scan
  of first 4096 bytes.

### 2.2 Completion — CLI + gateway RPC

- `hermes_cli/commands.py` `SlashCommandCompleter._context_completions` (≈1693–1777):
  static starters (`@diff`, `@staged`, `@file:`, `@folder:`, `@git:`, `@url:`), `@file:`/`@folder:`
  prefix-filtered directory listing (folders only / files only, file size label meta), bare-`@`
  fuzzy project file search via `_fuzzy_file_completions` + `_get_project_files` (rg/fd, 5s cache).
- `tui_gateway/methods_complete.py` `complete.path` (lines 41–269) — **the RPC the desktop uses**:
  static starters + plugin prefixes; fuzzy basename ranking (score sort, 30 cap) for queries
  without `/`; plain path listing with `@kind:` tag, trailing `/` for dirs, `@/foo` → cwd-relative
  fallback; `@folder:` never yields files (regression: `tests/hermes_cli/test_at_context_completion_filter.py`).

### 2.3 Call sites

- `cli.py` chat path: expands before sending (provider-aware context length — see
  `tests/cli/test_cli_codex_context_reference.py`).
- `gateway/run.py` ≈16977–17079: inbound message preprocessing with
  `allowed_root=_msg_cwd`; `blocked` → adapter warns the chat peer and drops the message.
- Messaging platforms (Telegram/Discord) pass `@` through as-is (docs: Platform Availability).

### 2.4 Docs & tests (parity sources)

- Docs: `website/docs/user-guide/features/context-references.md` (syntax table, line ranges,
  size limits 25%/50%/200 files/10 commits, sensitive-path table, error table).
- Tests: `tests/agent/test_context_references.py` (parse/email-ignore, folder fallback,
  missing-file warning, binary block docker/local, deny-list fail-closed, quote round-trip),
  `tests/cli/test_cli_codex_context_reference.py`, `tests/hermes_cli/test_at_context_completion_filter.py`,
  plus `tests/agent/test_context_refs_concurrent.py`, `tests/agent/test_plugin_context_references.py`,
  `tests/gateway/test_complete_path_at_filter.py`, `tests/gateway/test_context_ref_expansion_runtime.py`.

> ⚠️ `agent/context_tools.py` is **not** the reference engine — it holds `CompactMode` guidance and
> `context_usage`/`compact` tool schemas. It is listed in the feature inventory but is irrelevant
> to this port (compaction is a separate feature).

## 3. Target TypeScript design

All logic lives under `web/src/lib/context-references/`; it runs in-process in the Tauri webview.
Filesystem / git / network go through the existing Tauri bridge (`web/src/lib/tauri-bridge.ts`)
to Rust commands — the webview has no Node `fs`/`child_process`/`undici`.

### 3.1 Module layout (design-only)

```
web/src/lib/context-references/
  types.ts        # ContextReference, ContextReferenceResult, RefKind, CompletionItem, provider registry
  parse.ts        # REFERENCE_PATTERN port, parseContextReferences, formatReferenceValue, strip helpers
  expand.ts       # expandContextReferencesAsync(message, {cwd, contextLength, allowedRoot, fetchUrl})
  tokens.ts       # estimateTokensRough (CJK-aware, ceiling division — port of model_metadata)
  file.ts         # readFileReference, folderListing (200 cap), binary detect, codeFenceLanguage
  sensitive.ts    # narrow list + canonical deny-list check, FAIL CLOSED
  git.ts          # gitDiff / gitStaged / gitLogN via Tauri `git_capture`
  url.ts          # fetch + Readability extraction + SSRF guard (via Rust or guarded browser fetch)
  completion.ts   # completePathRefs(word, {cwd, sessionId}) — port of methods_complete.py
  index.ts        # ContextReferences facade: parse | expand | complete
```

### 3.2 Core interfaces (pseudocode)

```ts
// types.ts
type RefKind = "file" | "folder" | "diff" | "staged" | "git" | "url" | (string & {});
interface ContextReference { raw: string; kind: RefKind; target: string; start: number;
                             end: number; lineStart?: number; lineEnd?: number; }
interface ContextReferenceResult {
  message: string; originalMessage: string; references: ContextReference[];
  warnings: string[]; injectedTokens: number; expanded: boolean; blocked: boolean;
}
interface CompletionItem { text: string; display?: string; meta?: string; } // = SlashCompletionItem

// expand.ts
async function expandContextReferencesAsync(
  message: string,
  opts: { cwd: string; contextLength: number; allowedRoot?: string; fetchUrl?: UrlFetcher },
): Promise<ContextReferenceResult>;

// completion.ts — keeps the current SlashCompletionResult contract
async function completePathRefs(word: string, opts: { cwd: string; sessionId?: string }):
  Promise<{ items: CompletionItem[] }>;
```

### 3.3 Data flow (in-process)

1. **Typing**: `goose-composer.tsx` detects `@` token via `getActiveMentionToken` and calls
   `getMentionCandidates` → local `completePathRefs` (replacing WS `complete.path`); results are
   `SlashCompletionItem`s so `classifyMention`/picker code is unchanged. Add live line-range hints
   (`@file:src/main.ts:10-` / `:10-25`) after a file path is complete.
2. **Submit**: before `transport.send`, `expandContextReferencesAsync` runs on the composer text
   with `cwd = workspacePath` (already tracked by the composer) and `contextLength` from the
   session/model config. If `blocked` → inline error + abort send. Else the expanded message
   (with `--- Attached Context ---`) is sent and stored exactly as today, so rendering/chips/
   history need no change.
3. **Rust IPC**: `@file` → `read_workspace_file` (root containment, text/binary sniff, size cap);
   `@folder` → new `list_workspace_dir` (or walk via existing preview/browser commands);
   `@diff/@staged/@git` → new `git_capture {args, cwd, timeoutMs:30_000}` returning
   `{stdout, stderr, exitCode}`; `@url` → new `http_fetch_safe {url, maxBytes}` (Rust reqwest +
   SSRF guard) or guarded browser fetch (see §5 risk).

### 3.4 Feature parity checklist

| Python behavior | TS design |
|---|---|
| `REFERENCE_PATTERN` lookbehind `(?<![\w/])@` | native `RegExp` (Chromium/WebView2 supports lookbehind) |
| quote round-trip (`format_reference_value`) | port verbatim; desktop already mirrors it in legacy `directive-text.tsx` |
| `path:N` / `path:N-M` slicing | `read_workspace_file` + line slicing in `file.ts` |
| 25% soft / 50% hard budget | `tokens.ts` + same constants in `expand.ts` |
| folder 200 cap + `- ...` | same in `folderListing` |
| `@git:N` clamp [1,10] | same in `git.ts` |
| sensitive-path + deny-list fail-closed | `sensitive.ts` (TS check) **+** Rust containment (enforcement) |
| binary → `📎` block | same block text, minus docker path mapping (N/A desktop) |
| completion starters / `@folder:` filter / fuzzy basename | `completion.ts` port of `methods_complete.py` |

## 4. Data models & persistence

No new durable tables. The expanded message is persisted as ordinary message text — the current
gateway already writes the post-expansion string into session history, and the desktop stores
messages via its existing stores/transport; keep that contract.

Caches (all ephemeral, design-only):

- **Fuzzy file index**: per-workspace in-memory map `workspacePath → {relPath, isDir, mtime, size}`
  built lazily on first `@` completion, invalidated by Rust `preview-file-changed` events or a
  short TTL (mirror `_get_project_files` 5s cache and legacy `cachedPathCompletion`).
- **Completion LRU**: keyed `(cwd, sessionId, word)` — legacy `apps/desktop` used
  `cachedPathCompletion`; port that pattern (60ms debounce + cache-hit skip already exist in the
  picker adapter).
- **Git cache**: `git diff`/`staged`/`log` results cached per workspace with short TTL
  (kimi-code `git-status.ts` pattern: branch 5s, status 15s).
- Optional: persist the file index in IndexedDB keyed by workspace path + `mtime` snapshot to
  make cold-start completion instant on big repos (defer until a perf test proves it necessary).

Schema impact on `packages/protocol`: none required — `SlashCompletionItem`
(`hermes-api.ts:1314`) is already `passthrough()` and matches `{text, display, meta}`. If line-range
completion ships, extend it with an optional `range?: string` field (backward compatible).

## 5. Third-party library strategy

Most important section. Python dep → TS equivalent, with kimi-code evidence.

| Python dep | TS equivalent | Evidence (kimi-code) |
|---|---|---|
| `re` (regex parse) | native `RegExp` — no lib | — |
| `ripgrepy` / `rg` / `fd` (folder listing, fuzzy scan) | `fd` binary via `@moonshot-ai/pi-tui` `CombinedAutocompleteProvider` with fs fallback (`MAX_FALLBACK_SCAN=2000`, `MAX_FALLBACK_SUGGESTIONS=50`, skips `.git`, ranks basename: exact/prefix/includes/path, quotes spaces as `@"path"`) | `apps/kimi-code/src/tui/components/editor/file-mention-provider.ts` (extractAtPrefix, collectFsMentionCandidates, rankFsMentionCandidates, toMentionItem) |
| `.gitignore` respect during walk | npm `ignore` ^5.3.2 (already a kimi-code dep) | `packages/agent-core/package.json` |
| `mimetypes` + NUL-byte binary sniff | port `detectFileType` (sniff first `MEDIA_SNIFF_BYTES`, NUL scan, extension map) | `packages/agent-core/src/tools/support/file-type.ts`, `tools/builtin/file/read.ts` |
| `subprocess.run(["git", …])` | **no Node in webview** → Rust `git_capture` command; kimi-code pattern is `node:child_process` `execFile`/`spawnSync` + `resolveCommandPath` + timeouts + `maxBuffer` | `apps/kimi-code/src/utils/git/git-status.ts` (branch/status/diff numstat/PR — **status only, no diff/log patch capture**) |
| `tools.web_tools.web_extract_tool` (firecrawl/exa/tavily/parallel + OpenRouter) | kimi-code `LocalFetchURLProvider`: `undici` + `@mozilla/readability` + `linkedom`, SSRF blocklist (`node:net.BlockList`, `node:dns`), maxBytes 10MB, 10 redirect hops, per-hop re-validation + pinned dispatch | `packages/agent-core/src/tools/providers/local-fetch-url.ts` |
| `orjson` | built-in `JSON` | — |
| `estimate_tokens_rough` | **implement from scratch** — kimi-code has no rough-text token counter (`utils/completion-budget.ts` computes `max_completion_tokens` caps, different purpose) | `packages/agent-core/src/utils/completion-budget.ts` |
| `prompt_toolkit.Completion` | composer popover already exists; optional `fuzzyMatch` from `@moonshot-ai/pi-tui` for scoring | `file-mention-provider.ts` |
| `agent/file_safety.get_read_block_error` | port deny-list to `sensitive.ts` **+** enforce containment in Rust `read_workspace_file` (defense in depth) | Rust: `src/commands/preview.rs` |
| plugin `ContextReferenceProvider` registry | **no kimi-code equivalent** — design a TS registry (see §9 risk) | — |

### 5.1 Network constraint (important)

kimi-code's `local-fetch-url.ts` is **Node-only** (undici + node:dns/net). The desktop webview
runs browser `fetch` with no SSRF control. Decision: implement `http_fetch_safe` as a **Rust**
command (reqwest with DNS re-validation per redirect, IP-literal blocklist, 10MB cap) porting the
kimi-code logic; keep the JS side limited to `composer-url.ts` metadata preview (already
best-effort, no secrets). This is the one place the plan adds a Rust capability rather than a TS lib.

## 6. Integration with existing Hermes-CN-Desktop frontend

> Note: the task brief cites `web/src/routes/chat.tsx` — that file does **not** exist. The chat
> composer lives at `web/src/components/chat/goose-composer.tsx` (types in `composer-types.ts`).

- **Reuse, don't touch**: `composer-mentions.ts` — `getActiveMentionToken`, `MENTION_STARTERS`,
  `classifyMention`, `buildMentionReplacement`, `filterSessionMentions` stay as-is; only
  `getMentionCandidates`' `source.completePath` implementation swaps from WS to local
  `completePathRefs` (same `(word) => Promise<SlashCompletionResult>` shape).
- **`goose-composer.tsx`**: mention picker wiring (lines ~353–366: `mentionToken` memo,
  `dismissedMentionToken`, picker open state) unchanged. Add submit-time hook: call
  `expandContextReferencesAsync` before `onSubmit`; surface `blocked`/warnings inline.
- **`use-gateway.ts`** (`completePath` ≈581–601): keep behind a feature flag during migration;
  delete in Phase D. `complete.slash`/skills remain WS until their own feature plans land.
- **`composer-url.ts`**: keep paste → `@url:` insertion + `fetchLinkMetadata` preview; add
  `url.ts` expansion using `http_fetch_safe` (Rust) + Readability. Note current preview uses
  browser `fetchExternalText` — fine for metadata, not for expansion of untrusted input.
- **Rust**: reuse `read_workspace_file` (`src/commands/preview.rs:388` — root containment,
  binary sniff, 512KB cap) for `@file`; add `git_capture` (`src/commands/git.rs` has repo-level
  worktree/branch/status commands but **no diff/log capture**) and `http_fetch_safe`; add
  `list_workspace_dir`/walk for `@folder` if no existing command covers recursive listing.
- **Legacy prior-art in Core repo** (`D:/hermes-agent-cn/apps/desktop/src/app/chat/composer/`):
  `path-refs.ts` (bare `@path` → `@file:`/`@folder:` promotion + chip commit), `use-at-completions.ts`
  (`complete.path` adapter + `cachedPathCompletion`), `directive-text.tsx` (`formatRefValue`
  mirror) — treat as reference designs; the new repo already re-implemented the picker in
  `composer-mentions.ts`.
- **`packages/protocol`**: `SlashCompletionItem`/`Result` (hermes-api.ts:1314) reused for local
  completion; optionally add `range` for line-range completion.

## 7. Removing the WebSocket dependency (migration path)

Freeze these contracts first — they are the seams the migration swaps behind:

- **C1 completion**: `complete.path {word, session_id?, cwd?} → {items:[{text, display?, meta?}]}`
  (max 30 items, exact text prefixes for `@kind:`).
- **C2 expansion**: `preprocess(message, cwd, context_length, allowed_root) →
  {message, warnings, injected_tokens, expanded, blocked}` with the literal
  `--- Attached Context ---` / `--- Context Warnings ---` markers (the frontend renders chips
  from the `@` tokens left in text + attached blocks).

Phases:

1. **P0 (contract freeze)**: snapshot C1/C2 in `docs/desktop-prd/` (04-backend-contract.md already
   documents `complete.path`); add golden fixtures from Python tests.
2. **P1 (local completion, backend expansion)**: implement `completion.ts` + `tokens.ts` +
   `sensitive.ts`; flip `getMentionCandidates` to local; keep WS expansion at submit. Verify
   completion parity with `test_complete_path_at_filter.py`.
3. **P2 (local expansion)**: implement `expand.ts` + `file.ts` + `git.ts` + `url.ts` + Rust
   commands; run `expandContextReferencesAsync` in the composer before send; keep the gateway
   path for messaging-platform sources (out of scope) and as a fallback flag.
4. **P3 (delete WS path)**: remove desktop `complete.path` calls from `use-gateway.ts`; stop
   desktop gateway message preprocessing for chat sources; delete now-dead desktop RPC plumbing.
5. **P4 (optional)**: plugin provider registry + line-range completion UX.

## 8. Migration phases & task breakdown

| Phase | Tasks | Output / verification |
|---|---|---|
| P0 | Freeze C1/C2; export Python test fixtures | `plans/context-references.md` sign-off; fixture files |
| P1 | `types.ts`, `parse.ts`, `tokens.ts`, `sensitive.ts`, `completion.ts`; cache (`cachedPathCompletion` pattern); swap `getMentionCandidates` | vitest parse/quote/security/completion-filter parity; manual `@` picker smoke |
| P2a | Rust `git_capture` + `http_fetch_safe` (+ `list_workspace_dir` if needed) | Rust unit tests (git timeout, SSRF cases ported from kimi-code) |
| P2b | `file.ts`, `folder.ts`, `git.ts`, `url.ts`, `expand.ts`; composer submit hook | vitest expansion parity vs `test_context_references.py`; E2E send with `@file:…:10-25` |
| P3 | Delete WS `complete.path` + gateway chat-source preprocessing; cleanup | grep for `complete.path` returns desktop-only legacy paths; full `pnpm test` |
| P4 | Line-range completion UI; TS plugin provider registry (design) | playwright E2E; registry unit tests |

## 9. Risks & open questions

- **No TS equivalent found / gaps**:
  1. **Git diff/log capture** — kimi-code only implements git *status* (`git-status.ts`); there is
     no `git diff`/`git log -p` TS implementation to copy. Design: Rust `git_capture` (mirror
     Python subprocess semantics: 30s timeout, UTF-8 replace, `windows_hide_flags` on Windows).
  2. **SSRF-safe URL fetch in a webview** — kimi-code's SSRF guard is Node-only; must be re-implemented
     in Rust (reqwest). Browser `fetch` alone cannot block private/loopback IPs safely.
  3. **Fuzzy repo-wide file scan (bare `@query`)** — kimi-code relies on the `fd` binary or a capped
     fs walk; the desktop has no `fd`. Rust `ignore`-crate walk (respects .gitignore) is the
     recommended replacement; parity on ranking may differ from Python's `_fuzzy_basename_rank`.
  4. **Plugin `ContextReferenceProvider` registry** — no kimi-code equivalent; desktop standalone
     has no plugin system. Keep the TS registry interface minimal and inert until plugins exist.
  5. **Paid web-extraction providers** (firecrawl/exa/tavily + OpenRouter) — no TS equivalent;
     local Readability extraction is strictly weaker for JS-heavy pages. Acceptable for desktop
     standalone; document the gap.
- **Deny-list drift**: the canonical Python deny-list (`file_safety.get_read_block_error`) will be
  frozen into TS; a future Core list change won't auto-propagate. Mitigation: keep the Rust
  containment check as the hard enforcement and treat TS deny-list as UX filtering.
- **Context length source**: expansion needs the model `context_length`; desktop must resolve it
  from session/model config (the `use-gateway` model options already expose context info) — verify
  exact field before P2b.
- **CWD semantics**: `allowed_root` must be the composer's workspace root (today passed as `cwd`
  to `complete.path`); confirm it is always set for send paths to avoid blocking legit absolute paths.
- **Token-estimate parity**: CJK-aware heuristic must match `estimate_tokens_rough` exactly for
  budget parity; port tests with mixed CJK/ASCII strings.
- **Binary file cap**: `read_workspace_file` caps at 512KB while Python inlines full text; decide
  whether `@file:` of a >512KB text file should truncate (with warning) or route through a new
  Rust read with the Python 100KB-equivalent cap — kimi-code `ReadTool` uses `MAX_BYTES=100*1024`,
  so aligning on a ~100KB cap is defensible.

## 10. Test strategy

- **Vitest unit (parity, port Python cases)**:
  - `parse.test.ts`: `test_context_references.py::test_parse_typed_references_ignores_emails_and_handles`
    (email ignored, `@teammate` ignored, kinds/targets/line ranges).
  - `format.test.ts`: `test_format_reference_value_round_trips_through_the_parser` (spaces,
    quotes, parens, Windows paths).
  - `sensitive.test.ts`: deny-list cases from `test_blocks_canonical_read_denylist_credential_stores`
    (auth.json, `.anthropic_oauth.json`, `mcp-tokens/`, project `.env`, fail-closed on guard error).
  - `tokens.test.ts`: CJK/ASCII ceiling-division cases.
  - `completion.test.ts`: `test_at_context_completion_filter.py` (`@folder:` dirs only,
    `@file` files only) + gateway `test_complete_path_at_filter.py` cases (30-cap, `@/foo`, hidden files).
  - `expand.test.ts`: missing-file warning, binary block, folder fallback (no rg → walk),
    25%/50% soft/hard budget, `@git:N` clamp, quoting round-trip through full pipeline.
- **Rust unit**: `git_capture` (timeout, non-zero exit → stderr warning), `http_fetch_safe`
  (loopback/private IP rejection, redirect re-validation, size cap) — port kimi-code
  `local-fetch-url` SSRF tests.
- **Vitest integration (fake Tauri)**: `completePathRefs` parity against golden `complete.path`
  fixtures; `expandContextReferencesAsync` output byte-parity on fixture messages.
- **Playwright E2E**: type `@` → starters; pick `@file:` → fuzzy file; insert chip; submit →
  expanded `--- Attached Context ---` in history; paste URL → `@url:` insert; `@file:secret` →
  blocked warning, message not sent.

## 11. Reference links

- Python: `D:/hermes-agent-cn/agent/context_references.py`,
  `D:/hermes-agent-cn/agent/file_safety.py`,
  `D:/hermes-agent-cn/agent/model_metadata.py` (`estimate_tokens_rough`),
  `D:/hermes-agent-cn/hermes_cli/commands.py` (`_context_completions`),
  `D:/hermes-agent-cn/tui_gateway/methods_complete.py` (`complete.path`),
  `D:/hermes-agent-cn/gateway/run.py` (≈16977–17079), `D:/hermes-agent-cn/tools/web_tools.py`.
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/features/context-references.md`.
- Tests: `D:/hermes-agent-cn/tests/agent/test_context_references.py`,
  `tests/cli/test_cli_codex_context_reference.py`,
  `tests/hermes_cli/test_at_context_completion_filter.py`,
  `tests/gateway/test_complete_path_at_filter.py`, `tests/gateway/test_context_ref_expansion_runtime.py`,
  `tests/agent/test_context_refs_concurrent.py`, `tests/agent/test_plugin_context_references.py`.
- kimi-code TS reference: `apps/kimi-code/src/tui/components/editor/file-mention-provider.ts`,
  `packages/agent-core/src/tools/builtin/file/read.ts`,
  `packages/agent-core/src/tools/support/file-type.ts`,
  `packages/agent-core/src/tools/providers/local-fetch-url.ts`,
  `apps/kimi-code/src/utils/git/git-status.ts`, `packages/agent-core/src/utils/completion-budget.ts`.
- Desktop: `web/src/lib/composer-mentions.ts`, `web/src/lib/composer-url.ts`,
  `web/src/lib/composer-skills.ts`, `web/src/components/chat/goose-composer.tsx`,
  `web/src/components/chat/composer-types.ts`, `web/src/hooks/use-gateway.ts`,
  `packages/protocol/src/hermes-api.ts`, `src/commands/preview.rs`, `src/commands/git.rs`.
- Legacy prior-art: `D:/hermes-agent-cn/apps/desktop/src/app/chat/composer/` (`path-refs.ts`,
  `use-at-completions.ts`, `directive-text.tsx`, `rich-editor.ts`).
