# Skills System — Python → TypeScript Rewrite Plan

> Feature: on-demand knowledge docs with progressive disclosure (Level 0 list → Level 1 view → Level 2 reference), agentskills.io-compatible SKILL.md format, skill management (create/edit/patch/delete), linter, Skills Hub search/install, bundled-skill seeding.
> Design-only plan (NO implementation). Follows `plans/README.md` template.

## 1. Summary

Port the Hermes **Skills System** from the Python backend (`D:/hermes-agent-cn`) into the Hermes-CN-Desktop TypeScript stack so it runs in-process in the Tauri webview without the Python runtime / `/api/ws` link. Skills are directories (optionally categorized) containing a `SKILL.md` with YAML frontmatter (`name`, `description`, `platforms`, `prerequisites`, `metadata.hermes.*` — agentskills.io-compatible) plus optional `references/`, `templates/`, `assets/`, `scripts/`.

The port keeps the exact **progressive disclosure** contract: `skills_list()` returns only name/description/category/origin metadata (Level 0, token-cheap), `skill_view(name)` loads the full SKILL.md plus tags, linked-files index and readiness/setup status (Level 1), and `skill_view(name, file_path)` loads an individual reference/template/asset/script (Level 2). It mirrors the Python JSON shapes so the existing `web/src/routes/skills.tsx` UI and `packages/protocol` Zod schemas keep working.

TS modules replace the Python modules 1:1: a frontmatter parser + scanner + registry (evidence: kimi-code `packages/agent-core/src/skill/*`), a viewer with path-traversal guards, a manager (create/edit/patch/delete/write_file/remove_file), a linter, a hub client, and a bundled-manifest seeder. Rust (`src/commands/skills.rs`) owns all filesystem I/O and path security via Tauri IPC; the webview never touches raw FS paths directly. Skills Hub search/install stays a REST proxy during migration, then becomes an in-process HTTP client + local install writer.

## 2. Current Python implementation

Source files (all under `D:/hermes-agent-cn`):

- `tools/skills_tool.py` (2041 lines) — discovery + viewing. Key surface:
  - `skills_list(category, task_id)` (line 823) → JSON `{success, skills:[{name, description, category, origin, source_path, skill_file}], categories[], count, hint}` — Level 0. Creates `~/.hermes/skills/` on first call; merges plugin skill metadata (`hermes_cli/plugins.py` `list_plugin_skill_metadata`); filters by `platforms` (`skill_matches_platform`), environment conditions, and disabled set.
  - `skill_view(name, file_path, task_id, preprocess)` (line 1082) → Level 1 JSON `{success, name, description, tags, related_skills, content, path, skill_dir, org_provenance, linked_files{references[],templates[],assets[],scripts[]}, usage_hint, required_environment_variables[], missing_required_environment_variables[], setup_needed, readiness_status, _source_path}`; Level 2 JSON for `file_path`: `{success, name, file, content, file_type, _source_path}` (binary files get a size stub). Supports qualified plugin names `plugin:skill`, categorized paths `category/skill`, legacy flat `<name>.md`; refuses ambiguous collisions; enforces `tools/path_security.py` (`has_traversal_component`, `validate_within_dir`).
  - Discovery internals: `_find_all_skills(skip_disabled)` (line 696) with a per-session cache keyed by `_skills_scan_signature` (dir/category mtime signature + disabled set) and a 30s TTL (`_SKILLS_CACHE_TTL_SECONDS`, line 103); `_get_category_from_path`, `_skill_origin` (bundled vs external), `_parse_frontmatter`, `_parse_tags`.
  - Readiness/setup: `SkillReadinessStatus` (AVAILABLE/SETUP_NEEDED/UNSUPPORTED, line 240), `_get_required_environment_variables`, `_is_env_var_persisted`, `_gateway_setup_hint`, `check_skills_requirements`; env vars registered to sandboxes via `tools/env_passthrough.py` (out of scope for desktop standalone).
  - `_serve_plugin_skill` (line 899) — plugin-namespaced serving with disable/platform checks, injection-pattern logging (`_INJECTION_PATTERNS`), bundle-context banner.
  - View dedup: `_skill_view_fingerprint` / `_record_skill_view` / `_check_skill_view_dedup` / `reset_skill_view_dedup` (repeat-view suppression with mtime+size fingerprint).
  - `agent/skill_utils.py` — shared helpers: `yaml_load`/`parse_frontmatter`, `skill_matches_platform/list`, `skill_matches_environment`, `get_disabled_skill_names`, `get_external_skills_dirs`, `get_all_skills_dirs`, `iter_skill_index_files`, `is_skill_support_path`, `is_excluded_skill_path`, `parse_qualified_name`/`is_valid_namespace`, org-provenance helpers (`ORG_PROVENANCE_FILE`, `is_org_mirror_path`).
- `tools/skill_manager_tool.py` (1808 lines) — `skill_manage(action, name, content, category, file_path, file_content, old_string, new_string, replace_all, absorbed_into)` (line ~1564) dispatching to `_create_skill`, `_edit_skill`, `_patch_skill`, `_delete_skill` (with `absorbed_into` consolidation intent), `_write_file`, `_remove_file`; guards: `_validate_name` (≤64 chars, lowercase/hyphens), `_validate_category`, `_validate_frontmatter`, `_validate_content_size`, `_security_scan_skill`, `_pinned_guard`, `_background_review_*` (curator read-before-write), `_apply_skill_write_gate` (config-gated approval staging), `_find_skill_in_other_profiles`, `_org_mirror_write_guard`, `_maybe_debounced_sync_push`. Registers OpenAI function-calling schema `SKILL_MANAGE_SCHEMA` (actions enum: create/patch/edit/delete/write_file/remove_file).
- `tools/skill_linter.py` (462 lines) — `LintFinding{severity, code, message}`; `lint_content(content, skill_dir=None)` (content-only checks for create path) and `lint_skill(path)` (on-disk checks); checks: `_check_name_format`, `_check_name_matches_dir`, `_check_description`, `_check_metadata_block`, `_check_platform_list_valid`, `_check_shell_utilities`, `_check_sections`, `_check_reference_links` (dangling links), `_check_platforms_gating` (POSIX primitives), `_check_forbidden_files`; `format_findings`/`has_errors`.
- Skills data dirs: `skills/` (bundled catalog, category subdirs, `index-cache/*.json` for hub mirrors) and `optional-skills/` (seed source for profile builder); per-profile `~/.hermes/skills/` + `.bundled_manifest` (read by `tools/skills_sync.py` `_read_manifest`) + `.hub/lock.json` (`tools/skills_hub.py` `HubLockFile`) + `.no-bundled-skills` marker.
- Sibling modules (ported as shims or marked out of scope): `tools/skills_sync.py`, `tools/skills_sync_client.py` (org sync push plane), `tools/skills_hub.py` (hub search/install/uninstall/update/preview/scan), `tools/skill_usage.py` (activity counts, `bump_patch`, `record_created`, `forget`), `tools/skill_provenance.py` (`is_background_review`), `agent/skill_preprocessing.py` (`preprocess_skill_content` — renders `${VAR}`/inline shell), `agent/prompt_builder.py` `clear_skills_system_prompt_cache`.
- REST surface the Desktop talks to today (`hermes_cli/web_routers/skills.py`): `GET /api/skills` (list with `enabled`, `usage`, `provenance`=hub|bundled|agent), `PUT /api/skills/toggle`, `GET /api/skills/content?name=` (raw SKILL.md for editor), `POST /api/skills` (create via `_create_skill`), `PUT /api/skills/content` (edit via `_edit_skill`); hub router: `GET/POST /api/skills/hub/*` (search, install, uninstall, update, sources, preview, scan). `web_server.py` line 14496 documents enable/disable toggle parity.
- Docs: `website/docs/user-guide/features/skills.md` (progressive disclosure L0/L1/L2, SKILL.md format, platform gating, secure env setup, skill bundles, `/learn`, Skills Hub) and `website/docs/reference/skills-catalog.md` (bundled catalog; regenerated by `website/scripts/generate-skill-docs.py`).

## 3. Target TypeScript design

Runs in-process in the Tauri webview; Rust owns FS; no Python after migration.

Module layout (new, under `D:/Hermes-CN-Desktop`):

- `packages/protocol/src/skills.ts` — Zod schemas (keep `hermes-api.ts` exports stable): `SkillInfo` (existing, add `tags?`, `readiness_status?`), `SkillsListResponse {skills, categories, count, hint?}`, `SkillViewResponse` (L1), `SkillFileResponse` (L2), `SkillManageResponse`, `LintFinding`, `LintResponse`, `HubSearchResult/Response`, `HubInstallRequest/Response` — evolved from the current `SkillInfo`/`SkillContentResponse`/`SkillsHubSearchResponse`.
- `web/src/lib/skills/frontmatter.ts` — `parseFrontmatter(text)` → `{data, body}` via `js-yaml` (same fence/trailing rules as `agent/skill_utils.py::parse_frontmatter`), `parseTags`, `normalizeName`, `MAX_NAME_LENGTH=64`, `MAX_DESCRIPTION_LENGTH=1024` (listing truncation keeps the 57-char prompt-window convention).
- `web/src/lib/skills/scanner.ts` — `resolveSkillRoots({activeSkillsDir, externalDirs, bundledManifest})`, `findAllSkills({skipDisabled})` with the same signature+TTL cache (per-session in-memory, `scanSignature()` from dir mtimes + disabled set; 30s TTL), platform/env filtering, category/origin classification, dedup by name (local wins over external), sorted by (category, name).
- `web/src/lib/skills/registry.ts` — `SessionSkillRegistry` (pattern from kimi-code `src/skill/registry.ts`): `byName` map, `getSkill`, `listSkills`, `listInvocable`, `renderSkillPrompt(name, args)` with `${...}` placeholder expansion, `getModelSkillListing()` (grouped by source, 250-char description truncation).
- `web/src/lib/skills/viewer.ts` — `skillList({category})` and `skillView({name, filePath})` mirroring the Python JSON contracts; collision detection across local+external roots; `_source_path` fingerprint for view dedup; injection-pattern warning logging (non-fatal, Python parity).
- `web/src/lib/skills/manager.ts` — `skillManage(action, args)` dispatching create/edit/patch/delete/write_file/remove_file with the same validation guards (name/category/frontmatter/size) and `absorbed_into` intent; calls Rust `skill_write_*` commands; returns the same result JSON as Python.
- `web/src/lib/skills/linter.ts` — `lintContent(content, skillDir?)` / `lintSkill(path)` porting the 10 checks above; pure TS (regex + YAML), no Rust needed except reading the file.
- `web/src/lib/skills/hub.ts` — in-process client: search/preview/scan against configured hub APIs (skills.sh / clawhub / index-cache mirrors), plus `install/uninstall/update` that resolve identifiers to tarball/repo URLs, download to a temp dir, validate, and write into the profile skills dir via Rust; maintains `.hub/lock.json` schema parity.
- `web/src/lib/skills/sync.ts` — bundled manifest reader/writer (`.bundled_manifest`), seeding logic (copy `static/bundled-skills/` or repo `skills/` on first run / update), `.no-bundled-skills` marker handling. Org-sync push plane (`skills_sync_client`) marked out of scope for desktop standalone (see §9).
- `web/src/lib/skills/path-security.ts` — TS port of `tools/path_security.py`: `hasTraversalComponent`, `validateWithinDir`, Windows-drive-letter guard; used by the webview viewer/manager before every FS call and enforced again in Rust.
- Rust: `src/commands/skills.rs` (new Tauri commands, ~15): `skill_list(profile)`, `skill_view(name, file_path?, profile)`, `skill_read_manifest()`, `skill_write_file`, `skill_write_skill` (create/edit), `skill_patch_skill`, `skill_delete_skill`, `skill_remove_file`, `skill_lint(path)`, `skill_hub_download(url, dest)` (validated), `skill_seed_bundled()` — each re-validates path containment; profile-scope resolution mirrors `_profile_scope` in `web_routers/skills.py`.

Data flow (in-process): `skills.tsx` → `useSkills`-style hook → `SkillService` (below) → `scanner`/`viewer`/`manager`/`linter` → `invoke("skill_*")` → Rust FS layer → disk under `HERMES_HOME/skills`. During migration the same hooks call the existing REST endpoints (§7).

## 4. Data models & persistence

- On-disk layout (unchanged, so Python-created and Desktop-created skills are interchangeable):
  - `<HERMES_HOME>/skills/` — primary dir; `<category>/<name>/SKILL.md` + `references/|templates/|assets/|scripts/`; flat legacy `<name>.md`.
  - `skills/.bundled_manifest` — JSON list of bundled skill names (origin classification + seeding diff).
  - `skills/.hub/lock.json` — hub-install registry (`HubLockFile` schema: identifier → installed path/version/source).
  - `.no-bundled-skills` marker — opt-out of bundled seeding (profile-scoped).
  - `optional-skills/` — seed catalog for the profile-builder step (read-only source).
  - External skill dirs from config `skills.external_dirs` — scanned read-only after local dir.
- Config (persisted in `config.yaml` by Rust config commands, schema parity with `hermes_cli/config.py` `skills` block): `disabled[]`, `platform_disabled.{platform}[]`, `external_dirs[]`, `write_approval` gate flag.
- In-memory: per-session discovery cache `{signature, timestamp, skills[]}` with 30s TTL and per-call shallow copies (Python poisons-guard parity: callers may mutate); view-dedup LRU keyed by `_source_path` fingerprint (mtime+size).
- No SQLite/IndexedDB needed: skill content is file-backed; only usage telemetry (`skill_usage.py` activity counts) needs persistence — store as JSON under `HERMES_HOME/cache/skill_usage.json` (same schema as Python `load_usage`), or defer to a future telemetry service. No schema migration required because the filesystem layout is unchanged.

## 5. Third-party library strategy

| Python dependency | TS equivalent | kimi-code evidence | Notes |
|---|---|---|---|
| PyYAML / `yaml.safe_load` (frontmatter) | `js-yaml` (`load`) | `packages/agent-core/package.json` dep `"js-yaml": "^4.1.1"`; used in `packages/agent-core/src/skill/parser.ts` `parseFrontmatter` | Direct port; same dump/safe semantics |
| `pathlib.Path` / `PurePosixPath` (skill-relative logical paths, forward slashes) | `pathe` | `packages/agent-core/package.json` dep `"pathe": "^2.0.3"`; `src/skill/scanner.ts` imports `path from 'pathe'` | Cross-platform join/relative; Rust uses `std::path` for real FS |
| `orjson` / `json` (tool JSON) | native `JSON.stringify` / zod `.safeParse` | protocol layers use zod (`packages/protocol/src/skill.ts`) | Python returns JSON strings; TS returns typed objects |
| `re` (`agent/re_compat.py` regex) | native `RegExp` | `src/skill/parser.ts` uses `regexp.escape` npm package for arg expansion | Linter regexes port directly |
| Skill discovery/scan (custom, `_find_all_skills` + cache) | **implement from scratch** — no npm package needed | kimi-code `packages/agent-core/src/skill/scanner.ts` (`resolveSkillRoots`, `discoverSkills`, MAX_SKILL_SCAN_DEPTH=8) + `registry.ts` (`SessionSkillRegistry`, `getModelSkillListing`) proves the exact TS pattern | Reuse kimi-code architecture; add Hermes signature+TTL cache and category/origin classification |
| Skill activation/prompt render (custom) | **implement from scratch** (thin) | kimi-code `src/agent/skill/index.ts` (`SkillManager.activate`, `recordActivation`), `prompt.ts` (`renderSkillLoadedBlock`, `<kimi-skill-loaded>` wrapper), `src/services/skill/skillService.ts` (`ISkillService.list/activate`, `toProtocolSkill`) | Desktop already has `web/src/lib/skill-invocation.ts` parsing the runtime-injected banner; keep that surface |
| Slash-command builder (custom) | **implement from scratch** (thin) | kimi-code `apps/kimi-code/src/tui/commands/skills.ts` (`buildSkillSlashCommands`, `isUserActivatableSkill`) | Desktop already has `web/src/lib/composer-skills.ts` (`/skill <name>` namespace); keep |
| Path security (`tools/path_security.py`) | **implement from scratch** (`web/src/lib/skills/path-security.ts` + Rust `std::path` canonicalization) | no kimi-code equivalent found | Critical: traversal, `..`, drive-letter handling |
| Skills Hub search/install/uninstall/update | **implement from scratch** (HTTP client + tarball extraction) | **no kimi-code equivalent found** — kimi-code has no skill install/hub; grep of `apps/kimi-code/src` and `packages/agent-core/src` for `installSkill|install-skill` → 0 hits | Use Node `fetch` in webview via Rust `skill_hub_download`; tar extraction in Rust (`tar`/`flate2` crates) |
| Skill authoring/manage (create/edit/patch/delete) | **implement from scratch** | **no kimi-code equivalent found** (kimi-code skills are read-only registry items) | Mirror `skill_manager_tool.py` validation guards in TS + Rust |
| Skill linter | **implement from scratch** | **no kimi-code equivalent found** | Pure TS port of `skill_linter.py` checks |
| Bundled sync / seeding (`skills_sync.py`, manifest) | **implement from scratch** | no kimi-code equivalent found | Simple JSON manifest + copy-on-first-run |
| Env var passthrough / secret capture (`env_passthrough.py`, gateway capture) | **no TS equivalent; out of scope for desktop standalone** | none | Desktop has no sandboxed execution envs; `setup_needed` status is still computed from `HERMES_HOME/.env` (Rust reads env file) |

## 6. Integration with existing Hermes-CN-Desktop frontend

Existing assets to reuse (do not rewrite):

- `web/src/routes/skills.tsx` (+ `skills.module.css`, `skills.test.tsx`) — the Skills page: tabs builtin/market/stats/user, search/filter, detail drawer with `useSkillMarkdown` + `MarkdownText` (`markdownWithoutFrontmatter` strips the frontmatter), profile-management scope (`?profile=` + `useManagementProfile`), usage stats (`components/skills/skill-usage-stats`).
- `web/src/hooks/use-skills.ts` — `useSkills` (GET `/api/skills` → `SkillsResponse`), `useToggleSkill` (PUT `/api/skills/toggle`), `useSkillsHubSearch` (GET `/api/skills/hub/search`), `useSkillMarkdown` (GET `/api/skills/content`). These become the seam: keep hook signatures, swap queryFn to the in-process `SkillService` (or keep REST during migration).
- `web/src/lib/composer-skills.ts` — `/skill <name>` composer namespace, ranking/filtering (`filterComposerSkills`), slash-token parsing; stays as-is, only its data source changes.
- `web/src/lib/skill-origin.ts` (`resolveSkillOrigin`, `isUserSkill`, `skillDirectory`), `web/src/lib/skill-translations.ts` (zh/en labels), `web/src/lib/skill-invocation.ts` (runtime-injected banner detection).
- `packages/protocol/src/hermes-api.ts` — `SkillInfo`, `SkillsResponse`, `SkillContentResponse`, `SkillHubResult`, `SkillsHubSearchResponse` (lines 677-723); extend with L1/L2 view + lint + manage schemas.
- `web/src/lib/transport.ts` (`fetchJSON`/`putJSON` auth-injection) — used by hooks until the WS/REST path is removed; the in-process service calls Rust IPC directly (`tauri-bridge.ts` `invoke`).
- Rust: new `src/commands/skills.rs` + `state.rs` profile-scope resolution; existing `src/commands/api_proxy.rs` (HTTP proxy) reused for hub network calls during migration.

## 7. Removing the WebSocket dependency (migration path)

Frozen API surface (keep byte-compatible during all phases so both transports can coexist):

- `GET /api/skills` → `{skills[], categories[], count, hint}` (list w/ `enabled`, `usage`, `provenance`)
- `PUT /api/skills/toggle` `{name, enabled}`
- `GET /api/skills/content?name=&profile=` → `{name, content, path}` (editor)
- `POST /api/skills` `{name, content, category}` / `PUT /api/skills/content` `{name, content}` (create/edit)
- `GET /api/skills/hub/search|preview|scan|sources`, `POST /api/skills/hub/install|uninstall|update`

Phases:

1. **Phase 1 (keep backend call):** no change to the transport; add TS-side Zod schemas for L1/L2 and validate REST payloads with them. Add `SkillService` interface in `web/src/lib/skills/service.ts` with a `RestSkillService` implementation that calls the current REST endpoints through `transport.ts`.
2. **Phase 2 (in-process behind same interface):** implement `LocalSkillService` (scanner/viewer/manager/linter over Rust IPC). Swap hooks to use it behind a feature flag; run parity tests side-by-side (REST vs local) with the same fixtures; freeze the JSON contracts from Phase 1.
3. **Phase 3 (delete WS/REST path):** when every consumer (skills route, composer, profile builder, hub panel) uses `LocalSkillService`, remove the REST calls for skills from `use-skills.ts` and delete the backend route handling from the desktop's expected runtime surface. The `/api/ws` dependency disappears together with the rest of the runtime link (per repo-wide plan). Hub network calls move to `hub.ts` (Rust `skill_hub_download`), not REST.

## 8. Migration phases & task breakdown

1. **Protocol & types** — extend `packages/protocol/src/hermes-api.ts` (or new `skills.ts`): `SkillsListResponse`, `SkillViewResponse` (L1), `SkillFileResponse` (L2), `LintResponse`, `ManageResponse`; keep existing exports re-exported. Vitest for schema round-trips.
2. **TS core, read path** — `frontmatter.ts`, `path-security.ts`, `scanner.ts`, `viewer.ts`; unit parity tests vs `test_skills_tool.py` fixtures (list/view/filter/collision/traversal/plugin-qualified-name).
3. **Rust FS commands** — `src/commands/skills.rs`: list/read/write/delete/lint with path re-validation; integration tests using `tempfile::TempDir` (per AGENTS.md).
4. **TS core, write path** — `manager.ts` + `linter.ts`; parity vs `test_skill_manager_tool.py`, `test_skill_linter.py`, `test_skill_size_limits.py`, `test_skill_bundles.py`.
5. **Hub + sync** — `hub.ts`, `sync.ts` (manifest + seeding + `.no-bundled-skills`); parity vs `test_skills_hub.py`, `test_skills_sync.py`.
6. **Service seam + hooks** — `service.ts` (Rest/Local impls), swap `use-skills.ts`; keep `skills.tsx`/`composer-skills.ts` unchanged.
7. **Profile/usage/telemetry** — `skill_usage.ts` (JSON activity counts) + profile-scope support; parity vs `test_skill_usage.py`, `test_skill_provenance.py` (subset).
8. **E2E** — Playwright: skills list→view→edit→delete, hub search→install→uninstall against fake hub; update `skills.test.tsx` for any new tabs/fields.

## 9. Risks & open questions

- **No kimi-code equivalent for install/hub, authoring, lint, sync**: kimi-code covers only discovery/registry/activation; every write-path capability (hub install/uninstall/update, create/edit/patch/delete, linter, bundled seeding, `.hub/lock.json`) must be implemented from scratch in TS+Rust. Highest-risk area is hub install (network download, tarball extraction, identifier→URL resolution) — prototype early.
- **Path security on Windows**: Python handles `C:\...` drive letters vs plugin `namespace:skill` disambiguation (`skill_view` line 1104 comment) and forward-slash logical paths. TS+Rust must reproduce both; Rust canonicalization must not break on non-existent paths (use `weakly_canonical`), and tests must cover `..`, `%2e%2e`, drive-letter names.
- **Readiness/setup capture has no TS equivalent**: `_capture_required_environment_variables`, gateway secret capture, and `tools/env_passthrough.py` registration are CLI/gateway concerns; desktop should compute `setup_needed` from `HERMES_HOME/.env` only and surface a "configure in .env" hint (or mark out of scope).
- **Skill preprocessing** (`agent/skill_preprocessing.py`): renders `${VAR}`/inline shell in SKILL.md at view time. Port as a conservative `${VAR}`-only renderer; shell-command substitution is a security risk in the webview and should be omitted or gated.
- **Org sync/provenance plane** (`skills_sync_client.py`, `_maybe_debounced_sync_push`, org mirror guards): desktop standalone has no org identity; either drop these guards or stub them (read-only display of `org_provenance` in L1 response, no push).
- **Repeat-view dedup parity**: the Python view-dedup uses `_source_path` + mtime/size; TS must persist fingerprints across renders (module-level LRU) and match test expectations in `test_skill_view_dedup.py`/`test_skill_view_*`.
- **Cache signature parity**: `_skills_scan_signature` semantics (dir + immediate-children mtimes, platform in signature) must be ported exactly or discovery cache tests (`test_skills_tool_discovery_cache.py`, `test_skills_list_modified_diff.py`) will diverge.
- **Open question**: should the Skills page keep the four-tab UI (builtin/market/stats/user) after the rewrite, or merge Level-0/1/2 into a single "browse → detail → reference" flow? Recommend keeping the tab structure to avoid churn; revisit in a later UX plan.

## 10. Test strategy

- **Vitest unit (parity vs Python tests)** — for each Python test file under `D:/hermes-agent-cn/tests/`:
  - `test_skills_tool.py` → frontmatter parsing, `skills_list` shape/sort/category filter, `skill_view` L1/L2 payloads, platform gating, disabled filtering, ambiguous-collision refusal, traversal rejection.
  - `test_skill_manager_tool.py` + `test_skill_size_limits.py` → create/edit/patch/delete/write_file/remove_file validation, name/category/frontmatter/size limits, `absorbed_into` intent, pinned guard (subset).
  - `test_skill_linter.py` → all 10 lint checks with error/warning severities.
  - `test_skills_hub.py`, `test_skills_sync.py` → hub search/install/uninstall against mocked HTTP, manifest read/seeding/opt-out marker.
  - `test_skill_provenance.py`, `test_skill_usage.py` → usage JSON counts + provenance classification (subset).
  - `test_external_skills.py`, `test_ghost_skill_pruning.py`, `test_skill_bundles.py`, `test_skill_commands.py` → external-dir scan precedence, ghost-skill sweep, bundle manifest, slash-command load semantics (subset ported to composer tests).
- **Rust integration** (`tests/`, per AGENTS.md): TempDir-based `skill_list/view/write/delete/lint` commands; wiremock for hub HTTP; `#[serial]` for env-dependent tests; path-traversal fuzz (include `..`, absolute, drive-letter).
- **Vitest hook/UI** — extend `web/src/routes/skills.test.tsx` (already mocks `use-skills`); add `web/src/lib/skills/*.test.ts` for scanner/viewer/manager/linter.
- **Playwright E2E** — real Core backend today: skills list → open detail (L1) → open reference (L2) → edit/delete; hub search → install → uninstall with fake hub; after Phase 3, same E2E runs against the in-process service with no backend.

## 11. Reference links

- Python source: `D:/hermes-agent-cn/tools/skills_tool.py`, `tools/skill_manager_tool.py`, `tools/skill_linter.py`, `tools/skills_hub.py`, `tools/skills_sync.py`, `tools/skill_usage.py`, `tools/skill_provenance.py`, `tools/path_security.py`, `agent/skill_utils.py`, `agent/skill_preprocessing.py`, `hermes_cli/web_routers/skills.py`, `hermes_cli/web_server.py` (`/api/skills` + line 14496).
- Python docs: `D:/hermes-agent-cn/website/docs/user-guide/features/skills.md`, `website/docs/reference/skills-catalog.md`.
- Python tests: `D:/hermes-agent-cn/tests/tools/test_skills_tool.py`, `test_skill_manager_tool.py`, `test_skill_linter.py`, `test_skills_hub.py`, `test_skills_sync.py`, `test_skill_provenance.py`, `test_skill_usage.py`, `test_skill_size_limits.py`, `test_skills_tool_discovery_cache.py`, `test_skill_view_dedup.py`, `test_skill_view_traversal.py`, `tests/agent/test_external_skills.py`, `test_ghost_skill_pruning.py`, `test_skill_bundles.py`, `test_skill_commands.py`.
- kimi-code TS reference: `D:/kimi-code/packages/agent-core/src/skill/{scanner,parser,registry,types,builtin}.ts`, `src/agent/skill/{index,prompt,types}.ts`, `src/services/skill/{skill,skillService}.ts`, `packages/protocol/src/skill.ts`, `apps/kimi-code/src/tui/commands/skills.ts`; deps `js-yaml`/`pathe` in `packages/agent-core/package.json`.
- Desktop existing: `D:/Hermes-CN-Desktop/web/src/routes/skills.tsx` (+ `skills.module.css`, `skills.test.tsx`), `web/src/hooks/use-skills.ts`, `web/src/lib/{composer-skills,skill-origin,skill-translations,skill-invocation}.ts`, `packages/protocol/src/hermes-api.ts` (lines 677-723), `web/src/lib/transport.ts`, `web/src/lib/tauri-bridge.ts`.
