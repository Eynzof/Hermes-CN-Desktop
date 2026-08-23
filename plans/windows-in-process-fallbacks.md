# Windows In-Process Fallbacks — Python → TypeScript Rewrite Plan

## 1. Summary

Port the CN fork's "Windows in-process fallback" behaviors from the Python backend
(`D:/hermes-agent-cn`) into the desktop app (`D:/Hermes-CN-Desktop`), so the
app works on a stock Windows install **without ripgrep / find / grep / POSIX shell
tools and without re-reading PATH from a stale process environment**. Three fallback
families are covered, matching fork notes P-020 / P-030 / P-033 (+ P-033b / P-037 / P-042):

1. **search_files without ripgrep** — pure in-process file-name search (glob) and
   content search (line-oriented regex), mirroring `_search_files_python` /
   `_search_content_python` semantics: prune-list, hidden-dir exclusion, mtime sort,
   pagination, binary sniff, 50k-file / 8MB caps, `\n`-line-oriented rejection.
2. **In-process stdlib file ops** — read/stat/count-lines/list-dir/mkdirs/atomic
   write primitives (P-033 `_prim_*` / `_local_atomic_write`) implemented with Rust
   `std::fs` (in-process) behind a thin Tauri IPC, plus a TS layer owning pagination
   and encoding policy (P-037: UTF-8 → system ANSI/mbcs fallback).
3. **Registry PATH refresh for PowerShell subprocesses** — the desktop already has
   `src/path_resolver.rs` reading HKLM+HKCU `Path`/`PATHEXT` via `winreg`; upgrade it
   with the P-042 last-write-signature cache and a `refresh_windows_path` command, and
   make every PowerShell spawn (`terminal.rs`, dashboard/gateway spawn sites) use the
   refreshed effective PATH.

The ported surface freezes the current `search_files` / `read_file` / `write_file` /
`patch` tool JSON contracts so the migration can switch backends behind one interface
(§7). Primary runtime is TypeScript in the webview; Rust provides OS-level capabilities
(fs IPC, registry, child spawn) as the end-state architecture requires.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`.

- **Tool registry / schemas** — `tools/file_tools.py`:
  - `SEARCH_FILES_SCHEMA` (line 2681): `pattern`, `target ∈ {content, files}`,
    `path`, `file_glob`, `limit` (default 50), `offset`, `output_mode ∈
    {content, files_only, count}`, `context`.
  - `search_tool()` (line 2480): pagination clamp (`normalize_search_pagination`),
    repeated-search guard (≥4 identical calls blocked, ≥3 warns), read-block filter
    (`_filter_read_blocked_search_results`), redaction (`redact_sensitive_text`),
    negative-result cache for missing roots, `to_dict(densify=True)` path-grouped
    output + `[Hint: Results truncated…]`.
  - `read_file_tool` (1622) / `write_file_tool` (2180) / `patch_tool` — path
    resolution via `_resolve_path_for_task` (366) which translates MSYS `/c/...`
    → `C:\...` on Windows; sensitive-path, protected-instruction and cross-profile
    gates; read-tracker dedup/loop caps (`_READ_HISTORY_CAP=500`, `_DEDUP_CAP=1000`,
    `_READ_TIMESTAMPS_CAP=1000`, `_NOT_FOUND_CAP=500`).
- **Search engine** — `tools/file_operations.py` (`ShellFileOperations`):
  - Routing `search()` (3280): local backend → rg via `ripgrepy` when `_find_rg()`
    succeeds, else **pure-Python fallback**; remote backends keep shell rg/grep/find.
  - `_search_files_python` (4193): bare names wrapped as `*pattern` (match at any
    depth), `os.walk` + `fnmatch`, prune `_FALLBACK_PRUNE_DIRS` (node_modules,
    __pycache__, .git, .hg, .svn, .venv, venv, dist, build, target, .mypy_cache,
    .pytest_cache, .ruff_cache, .tox, .idea, .gradle, .next, .cache), hidden dirs/files
    skipped unless the root itself is hidden, mtime sort newest-first, cap
    `_FALLBACK_MAX_FILES_SCANNED = 50_000`, pagination, `limit_reason` on cap hit.
  - `_search_content_python` (4232): line-oriented; `_pattern_has_regex_newline`
    rejects `\n` regexes (0 results + explanatory warning); `re.compile` errors →
    `Invalid search pattern: …`; skips `BINARY_EXTENSIONS` (from
    `tools/binary_extensions.py`), files > `_FALLBACK_MAX_CONTENT_BYTES = 8 MiB`,
    and files with NUL in first 8 KiB; decodes UTF-8 with `errors="replace"`;
    content mode emits matched + context lines deduped in line order; supports
    content / files_only / count.
  - `_zero_match_probe` (3388): cheap case-insensitive / hidden / fixed-string
    probes to attach near-miss warnings on 0-match local searches.
  - `SearchMatch` / `SearchResult` dataclasses (421–504) and `to_dict(densify=True)`
    path-grouped rendering — the exact JSON contract to freeze.
- **In-process file primitives (P-033 / P-033b / P-037)** — same file:
  `_prim_stat_size`, `_prim_read_sample`, `_prim_read_all`, `_prim_read_page`,
  `_prim_count_lines`, `_prim_list_dir`, `_prim_mkdirs`, `_local_atomic_write`
  (temp + `os.replace`), gated by `_use_inproc_io()` = `_IS_WINDOWS and
  _is_local_env()`; `_decode_file_bytes` + `_INPROC_FALLBACK_ENCODINGS = ("mbcs",)`;
  `_exec()` translates `/dev/null` redirects to PowerShell `*>$null` on win32 (1217).
- **Registry PATH refresh (P-020 / P-042)** — `tools/environments/windows_env.py`:
  `refresh_env_from_registry(force)` reads HKLM
  `SYSTEM\CurrentControlSet\Control\Session Manager\Environment` + HKCU
  `Environment` `Path`/`PATHEXT`, expands `REG_EXPAND_SZ` via ctypes
  `ExpandEnvironmentStringsW`, merge-dedup case-insensitively; P-042 cache keyed on
  the two keys' last-write FILETIME signature (`QueryInfoKey`) with 30s max age;
  `ps_with_utf8()` PowerShell UTF-8 preamble; `set_file_temporary()` /
  `mark_as_temporary()` (FILE_ATTRIBUTE_TEMPORARY, P-042 #5).
- **PTY / SSH runtime helpers**:
  - `hermes_cli/win_pty_bridge.py` — pywinpty `PtyProcess.spawn`, interface
    `spawn/read/write/resize/close/is_available` + `PtyUnavailableError`, poll-based
    read (no selectable fd), 64 KiB read chunks.
  - `hermes_cli/windows_ssh_runtime.py` — native Windows JSON-RPC-on-stdio helper:
    `probe`, `upload-token`, `read/write/remove-lock`, `remove-token`, `read-log`,
    `remove-log`, `spawn`, `inspect`, `process-state`, `terminate`; pywin32
    security descriptors (owner + SYSTEM SIDs, protected DACL), token/log files under
    `<hermes-root>/desktop-ssh/<ownership>/<nonce>.{token,log}`, subprocess
    creation flags `0x00000008 | 0x00000200 | 0x01000000`, `psutil` create_time.
- **Regex compat** — `agent/re_compat.py`: defaults to stdlib `re`; third-party
  `regex` is opt-in (`HERMES_ENABLE_REGEX_REPLACEMENT=1`) because engines differ
  (e.g. provider-error shape pattern matches stdlib only).
- **Docs** — `FORK_NOTES.zh-CN.md` rows P-020, P-030, P-033, P-033b, P-037, P-042
  (P-020/P-030/P-033 explicitly cited in scope; the others are the natural extension).
- **Tests (parity sources)** — `tests/test_re_compat.py`; `tests/tools/test_search_python_fallback.py`
  (the actual file; repo has no `test_search_files*.py` — nearest names are
  `test_search_hidden_dirs.py`, `test_search_auto_multiline.py`,
  `test_search_zero_match_and_multipath.py`, `test_search_error_guard.py`,
  `test_search_budget_truncation.py`, `test_file_ops_windows_inprocess.py`);
  `tests/hermes_cli/test_windows_native_docs.py` (installer PATH doc guard).

## 3. Target TypeScript design

### 3.1 Module layout (TS webview + Rust IPC)

```
web/src/lib/file-search.ts        # search_files in-process engine (TS)
web/src/lib/file-ops.ts           # file-op client: invokes Rust fs primitives
web/src/lib/windows-path.ts       # MSYS /c/... ⇄ C:\..., ~ expansion, base-dir resolution
packages/protocol/src/file-ops.ts # Zod: SearchFilesRequest/Response, FileRead/Write, PathInfo
src/commands/file_ops.rs          # Rust Tauri commands (NEW; registered in mod.rs + main.rs)
src/commands/windows_env.rs       # registry PATH refresh command (NEW or fold into path_resolver)
src/search/                       # Rust in-process search backend (NEW; optional accelerator)
src/path_resolver.rs              # enhanced: P-042 signature cache + force refresh
```

`file-search.ts` runs entirely in the webview: it walks the tree through a small
Rust IPC primitive (`list_dir_recursive` returning entry kind + rel path + mtime) or
calls the Rust search backend, then does glob/regex/pagination in JS. This keeps
tool-level logic in TS (end-state architecture) while all actual file I/O is
in-process Rust (`std::fs`), never a shell.

### 3.2 search_files engine (TS)

Interface (frozen tool contract, §7):

```ts
interface SearchFilesRequest {
  pattern: string;
  target: 'content' | 'files';
  path: string;            // default '.'
  file_glob?: string;      // content mode
  limit?: number;          // default 50
  offset?: number;         // default 0
  output_mode?: 'content' | 'files_only' | 'count';
  context?: number;        // default 0
}
interface SearchMatch { path: string; line: number; content: string }
interface SearchResult {
  total_count: number;
  matches?: SearchMatch[];
  matches_format?: string;   // path-grouped densify marker
  matches_text?: string;     // densified block when >=5 matches
  files?: string[];
  counts?: Record<string, number>;
  truncated?: boolean;
  limit_reason?: string;
  warning?: string;
  error?: string;
  _omitted?: string;         // read-blocked results
}
```

Algorithm mirrors Python exactly:

- **Path resolution**: resolve `~`, MSYS `/c/...` → `C:\...`; absolute roots stay;
  relative roots anchor to the session workspace root (the desktop already tracks it
  via `connection.rs` / runtime config); reject sentinel `TERMINAL_CWD` values
  (`''`, `.`, `auto`, `cwd`).
- **files mode**: bare name without `/` is wrapped `*pattern`; walk prunes the
  `_FALLBACK_PRUNE_DIRS` set and hidden entries unless the root itself is hidden;
  basename match via `picomatch` (or from-scratch `globToRegExp`); sort by mtime
  desc; slice `[offset, offset+limit]`; set `truncated` + `limit_reason` when the
  50k walk cap was hit.
- **content mode**: reject `\n`-containing patterns (line-oriented, 0 results +
  warning); compile JS `RegExp` (error → `Invalid search pattern: …`); skip
  `BINARY_EXTENSIONS` and >8 MiB files; NUL sniff on first 8 KiB; decode UTF-8
  (TS `TextDecoder('utf-8', {fatal:false})`); match per line; content mode emits
  matched ± context lines deduped in line order, capped 500 chars/line; supports
  `files_only` / `count` output modes.
- **Zero-match probe**: optional cheap case-insensitive + fixed-string second pass to
  attach "case may be wrong" / "hidden files excluded" warnings (parity with
  `_zero_match_probe`).
- **Densify**: when ≥5 matches, render path-grouped `matches_text` with
  `matches_format` marker, same shape as Python `to_dict(densify=True)`.

### 3.3 In-process file ops (Rust primitives + TS policy)

Rust `src/commands/file_ops.rs` exposes these commands (std::fs only, no shell):

- `file_stat(path) -> { size, mtime_ns, kind, exists }` (mirror `_prim_stat_size`)
- `file_read_page(path, offset_bytes, max_bytes) -> { bytes_base64 | text, truncated }`
  (mirror `_prim_read_page`; TS owns line/char pagination)
- `file_write_atomic(path, content, opts) -> { verified }` (temp file +
  `std::fs::rename`, mirror `_local_atomic_write`; optional CRC-32 verify, P-042 #4)
- `file_list_dir(path) -> entries[]` (mirror `_prim_list_dir`)
- `file_mkdirs(path)` (mirror `_prim_mkdirs`)
- `file_count_lines(path)` (mirror `_prim_count_lines`)

TS `file-ops.ts` builds the tool results: `read_file` gutter rendering
(`LINE_NUM|CONTENT`), 100K-char read budget, write verification messaging, patch
diff — reusing `packages/protocol` schemas where they exist today.

### 3.4 Registry PATH refresh (Rust)

- Enhance `src/path_resolver.rs` (already reads registry via `winreg 0.55`,
  `read_registry_environment()` at line 537, cache with `MIN_REFRESH_INTERVAL = 20s`):
  add `refresh_windows_path(force)` that (a) computes the two Environment keys'
  last-write FILETIME signature (`RegKey::query_info` / `QueryInfoKey`), (b) skips
  the read when signature unchanged and cache < 30s old (P-042), (c) otherwise
  re-reads HKLM+HKCU `Path`/`PATHEXT`, expands `%VAR%` placeholders (existing
  `expand_windows_placeholders`), merge-dedup case-insensitively, updates cache and
  the `applied_to_runtime` marker.
- Expose `refresh_windows_path` Tauri command; `terminal.rs` calls it (or a cheap
  `is_windows_path_stale()` check) before every PowerShell spawn, and injects the
  refreshed `effective_path_os()` (existing lines 501–537) + `PATHEXT` into the
  child env — this is the desktop equivalent of P-020's "refresh before each
  PowerShell subprocess".

## 4. Data models & persistence

- **SearchResult / SearchMatch**: Zod schemas in `packages/protocol/src/file-ops.ts`,
  matching Python `SearchResult.to_dict()` field-for-field (keys: `total_count`,
  `matches`/`matches_format`/`matches_text`, `files`, `counts`, `truncated`,
  `limit_reason`, `warning`, `error`, `_omitted`). No DB persistence — results are
  ephemeral tool outputs.
- **Session read/search tracker** (in-memory, Jotai atom or Rust `AppState` field):
  per-session dedup map `(resolved_path, offset, limit) → mtime`, read history cap
  500, dedup cap 1000, not-found cache cap 500 with 60s TTL, consecutive-search
  counter (block at 4, warn at 3) — mirrors `_read_tracker` caps in
  `tools/file_tools.py`. Survives only the session; no schema migration.
- **Write verification**: per-path mtime cache (read-then-write external-edit
  detection) and optional CRC-32 post-write verify result `{ verified: boolean }`.
  Persisted in-memory per session; nothing written to disk beyond the target file.
- **PATH cache**: in-memory `EffectivePath` snapshot + last-write signature (existing
  `path_resolver.rs` structures); not persisted (re-resolved at app start).

## 5. Third-party library strategy

| Python dependency | TS/Rust equivalent | Evidence (kimi-code) |
|---|---|---|
| `re` (stdlib via `agent.re_compat`) | JS native `RegExp` + `regexp.escape` for fixed strings | `packages/agent-core/src/services/fs/fsSearchService.ts` `compileGrepPattern`/`escapeRegExp`; `regexp.escape` is a dependency of `packages/agent-core/package.json` |
| `fnmatch` (glob) | `picomatch` (or from-scratch `globToRegExp` shown below) | `picomatch` in agent-core package.json; `globToRegExp()` in fsSearchService.ts handles `**`, `*`, `?`, escapes |
| `os.walk` | `fs.promises.readdir({withFileTypes:true})` recursive walk | `FsSearchService.walk()` (fsSearchService.ts) — depth cap 64, `.git` skip, symlink classification, `ignore` matcher |
| rg's `.gitignore` semantics | `ignore` npm package (fallback only, see §9 risk) | `FsSearchService.matcher()` builds `ignore()` from `.gitignore`; `ignore` is an agent-core dependency |
| `ripgrepy` / shell `rg` | `run-rg.ts` + `rg-locator.ts` (PATH → vendored → cached → CDN download, SHA-256 pinned) | `packages/agent-core/src/tools/support/run-rg.ts`, `rg-locator.ts` (Windows zip via `yauzl`) |
| `winreg` (P-020/P-042) | Rust `winreg` crate — **no TS equivalent** (Node has no registry API); already in desktop `Cargo.toml` (`winreg = "0.55"`) | kimi-code has no registry code; desktop `src/path_resolver.rs` already uses it |
| `ctypes ExpandEnvironmentStringsW` | Rust `windows-sys` (already in Cargo.toml) or winreg expand; **no TS equivalent** | — |
| `orjson` | native `JSON.stringify` | — |
| `os.replace` atomic write | Rust `std::fs::rename`; TS `fs.rename` behind IPC | kimi-code `write.ts` does mkdir-parents + write (no atomic temp+rename — design from scratch) |
| `pywinpty` (ConPTY) | **no TS equivalent in tree**; kimi-code uses `node-pty` (agent-core dep); Rust option: `portable-pty` crate (not yet in Cargo.toml) | `node-pty` in agent-core package.json; `apps/kimi-code/src/native` |
| `psutil` create_time | Rust `sysinfo` / windows-sys `GetProcessTimes` (**no TS equivalent**) | — |
| pywin32 ACL/security (windows_ssh_runtime) | Rust `windows-sys` security APIs (**no TS equivalent**) | — |

No TS equivalent found (must live in Rust IPC): `winreg` registry access,
`ExpandEnvironmentStringsW`, ConPTY/pty, `psutil` create-time, pywin32 security
descriptors. These are exactly the "Rust stays for OS-level capabilities" items in
the plans README — the TS layer calls them via `tauri-bridge.ts` invoke.

## 6. Integration with existing Hermes-CN-Desktop frontend

- **IPC**: `web/src/lib/tauri-bridge.ts` (invoke wrapper + `window.hermesDesktop`
  shim) is the single entry point; new commands are wrapped there (e.g.
  `hermesDesktop.searchFiles`, `hermesDesktop.fileStat`).
- **Protocol**: add `packages/protocol/src/file-ops.ts`; re-export through
  `packages/protocol/src/index.ts`; wire Zod validation at the IPC boundary (align
  with existing `hermes-api.ts` conventions).
- **Rust registration**: new `src/commands/file_ops.rs` + `windows_env.rs` are added
  to `src/commands/mod.rs` and `generate_handler!` in `src/main.rs` (60 → ~66
  commands). Rust unit tests inline (`#[cfg(test)]`), integration in `tests/`.
- **Reuse**: `src/path_resolver.rs` (registry PATH — extend, don't replace);
  `src/commands/terminal.rs` env injection (lines 501–537) already the integration
  point for refreshed PATH; `src/process/dashboard.rs` / `gateway.rs` `CREATE_NO_WINDOW`
  flags are the pattern for the pty/ssh spawn ports.
- **Not reused (removed later)**: any `search_files` calls that go over the REST/WS
  gateway to the Python runtime get routed to the in-process module instead (§7).

## 7. Removing the WebSocket dependency (migration path)

- **Freeze the API surface now**: `search_files`, `read_file`, `write_file`, `patch`
  request/response JSON as produced by Python (`SearchResult.to_dict`, `read_file`
  `LINE_NUM|CONTENT` gutter, write `verified:true` shape) become the canonical IPC
  types in `packages/protocol/src/file-ops.ts`. Parity tests lock this surface.
- **Phase A (today)**: desktop keeps calling Core via REST/WS; in-process module
  exists behind the same TS interface but is only used for offline fallback.
- **Phase B**: route `search_files` / file tools to the in-process module by default
  on Windows; keep REST/WS path behind a `HERMES_USE_CORE_FILE_TOOLS` env flag for
  A/B.
- **Phase C**: delete the WS/REST file-tool path and the Python tool dispatch for
  these tools; the dashboard remains only for other features until they are ported.
- The frozen surface is small and versioned in `packages/protocol`; bumping it must
  happen in lockstep with the Python schema (documented in the same plan review).

## 8. Migration phases & task breakdown

1. **Protocol freeze** — add `packages/protocol/src/file-ops.ts` Zod schemas;
   golden JSON fixtures from Python `SearchResult.to_dict` outputs.
2. **TS search_files module** (`web/src/lib/file-search.ts`) — pure-TS engine behind
   a Rust `list_dir_recursive` primitive; port all `test_search_python_fallback.py`
   cases as vitest parity tests.
3. **Rust fs primitives** (`src/commands/file_ops.rs`) — stat/read-page/atomic
   write/list-dir/mkdirs/count-lines; tempfile-based Rust tests; CRC verify (P-042 #4).
4. **Rust search accelerator** (`src/search/`) — optional `ignore`+`walkdir`
   backend used via IPC when the webview walk is too slow; identical result shape.
5. **Registry PATH refresh** (`src/path_resolver.rs` + `src/commands/windows_env.rs`
   + `terminal.rs`) — signature cache, `refresh_windows_path` command, force-refresh
   before PowerShell spawns; winreg unit tests with a mock `RegistryEnvironment`.
6. **read/write/patch tool port** (`web/src/lib/file-ops.ts`) — gutter rendering,
   read budget, write verify, patch diff; reuse existing `file_dialogs.rs` guards.
7. **PTY / SSH runtime port (Rust)** — reimplement `win_pty_bridge.py` and
   `windows_ssh_runtime.py` surfaces with `portable-pty`/`windows-sys`; keep the
   Python helper callable during transition.
8. **A/B + E2E** — Playwright search-from-UI test; env-flag comparison vs Core.

## 9. Risks & open questions

- **Regex engine parity**: JS `RegExp` ≠ Python `re` (lookbehind OK in modern V8,
  but `\A`/`\Z`, `(?(...))`, possessive quantifiers, and Unicode classes differ; the
  Python fallback itself uses stdlib `re`, not `regex` — `agent/re_compat.py` warns
  they are not drop-in). Mitigation: document the supported subset; parity tests on
  the patterns Hermes actually ships (provider-error sanitizer etc.).
- **`.gitignore` divergence**: Python `_search_content_python` does **not** honor
  `.gitignore` (prune-list only). kimi-code's `grepWithNode` does honor it via
  `ignore`. To match Python exactly, the TS fallback must default to prune-list-only;
  `ignore` support is an opt-in flag (or Rust `ignore` backend) — record the
  divergence in tool docs.
- **Encoding**: P-037's `("mbcs",)` ANSI fallback has no direct TS equivalent;
  `TextDecoder('gbk')` exists in browsers but the Rust fs layer should return raw
  bytes and let TS decode UTF-8 → gbk. Rust needs `encoding_rs` for non-UTF-8 if the
  Rust backend decodes. Open question: keep decode in TS only.
- **Binary detection parity**: must copy `tools/binary_extensions.py` exactly
  (incl. `.pdf` excluded from binary list). kimi-code's `file-type.ts` `NON_TEXT_SUFFIXES`
  differs — use the Python list as source of truth.
- **No TS equivalent risks** (all land in Rust): `winreg`, `ExpandEnvironmentStringsW`,
  ConPTY (pywinpty → `portable-pty`), `psutil` create_time, pywin32 ACLs. These are
  the highest-effort ports; the plan keeps the Python `windows_ssh_runtime.py` helper
  callable during transition rather than blocking the file-tool work on it.
- **Performance**: JS recursive walk of wide trees (node_modules pruned) may still
  lag rg; the 50k-file cap bounds worst case; the Rust `ignore`/`walkdir` backend is
  the mitigation. kimi-code caps walk depth at 64 — Python has no depth cap, so keep
  parity by not adding one (or document the divergence).
- **PATH cache staleness**: P-042 uses key last-write signature; desktop's current
  `MIN_REFRESH_INTERVAL=20s` is time-based — the signature cache removes the staleness
  window; verify `QueryInfoKey` FILETIME semantics match Python's `winreg.QueryInfoKey`.

## 10. Test strategy

- **vitest unit (parity)**: port `tests/tools/test_search_python_fallback.py` 1:1 —
  name match, bare-name-at-depth, hidden/vendored exclusion, hidden root inclusion,
  mtime sort + pagination, unicode filenames, content line match, file_glob filter,
  count/files_only modes, context lines, binary skip (NUL + extension), unicode
  content, `\n` line-oriented zero-result, invalid-regex error, no-rg routing (mock
  the rg probe absent, assert no shell path). Plus `tests/test_re_compat.py`-style
  RegExp compatibility cases for the documented subset.
- **Rust unit/integration**: `file_ops.rs` inline tests with `tempfile::TempDir`;
  `tests/` integration for `search_files` command (walkdir + regex vs fixture tree);
  registry refresh tests with `#[serial_test::serial]` (env-dependent, per AGENTS.md
  Rust conventions) and a mock registry for signature-cache logic.
- **Parity harness**: run the same corpus through Python fallback (via Core's
  `_search_files_python` / `_search_content_python`) and the TS/Rust fallback; diff
  the frozen `SearchResult` JSON. Env-flag A/B (Phase B) reuses this harness.
- **Playwright E2E**: open a fixture workspace, run search from the UI, assert
  matches/densified output; run with ripgrep absent from PATH on the test machine.
- **Windows-specific**: `tests/hermes_cli/test_windows_native_docs.py` analog for
  the Rust PATH injection (assert `effective_path_os()` + PATHEXT reach the spawned
  PowerShell env); manual smoke: install a tool via `winget` mid-session and verify a
  fresh PowerShell subprocess finds it without app restart.

## 11. Reference links

- `D:/hermes-agent-cn/tools/file_tools.py` (schemas/handlers/path resolution)
- `D:/hermes-agent-cn/tools/file_operations.py` (`ShellFileOperations`, P-030
  `_search_*_python`, P-033 `_prim_*`, `_local_atomic_write`, `SearchResult`)
- `D:/hermes-agent-cn/tools/binary_extensions.py` (`BINARY_EXTENSIONS`)
- `D:/hermes-agent-cn/agent/re_compat.py` (regex compat policy)
- `D:/hermes-agent-cn/tools/environments/windows_env.py` (P-020/P-042 registry
  refresh + cache, `ps_with_utf8`, FILE_ATTRIBUTE_TEMPORARY)
- `D:/hermes-agent-cn/hermes_cli/win_pty_bridge.py`, `hermes_cli/windows_ssh_runtime.py`
- `D:/hermes-agent-cn/FORK_NOTES.zh-CN.md` (P-020/P-030/P-033/P-033b/P-037/P-042)
- `D:/hermes-agent-cn/tests/test_re_compat.py`,
  `tests/tools/test_search_python_fallback.py`,
  `tests/tools/test_file_ops_windows_inprocess.py`,
  `tests/hermes_cli/test_windows_native_docs.py`
- `D:/kimi-code/packages/agent-core/src/services/fs/fsSearchService.ts`
  (pure-Node grep fallback: `grepWithNode`, `walk`, `matcher`, `globToRegExp`)
- `D:/kimi-code/packages/agent-core/src/tools/support/rg-locator.ts` /
  `run-rg.ts` (rg resolution/download), `support/file-type.ts`, `builtin/file/glob.ts`,
  `builtin/file/grep.ts`, `builtin/file/read.ts`, `builtin/file/write.ts`
- `D:/kimi-code/packages/agent-core/package.json` (`ignore`, `picomatch`,
  `pathe`, `regexp.escape`, `node-pty`)
- `D:/Hermes-CN-Desktop/src/path_resolver.rs` (existing winreg PATH/PATHEXT,
  `effective_path_os`, 20s cache)
- `D:/Hermes-CN-Desktop/src/commands/terminal.rs` (PowerShell env injection),
  `src/commands/file_dialogs.rs`, `src/process/dashboard.rs` / `gateway.rs`
  (`CREATE_NO_WINDOW`), `Cargo.toml` (`winreg`, `windows-sys`, `regex`)
- `D:/Hermes-CN-Desktop/web/src/lib/tauri-bridge.ts`, `packages/protocol/src/hermes-api.ts`
