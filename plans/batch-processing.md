# Batch Processing — Python → TypeScript Rewrite Plan

## 1. Summary

Batch processing runs the Hermes agent across a JSONL dataset of prompts **in parallel**,
generating **ShareGPT-format trajectories** (`from`/`value`) with tool-usage statistics for
training-data generation and model evaluation. It supports **toolset distributions**
(probabilistic per-prompt tool sampling), **checkpointing with content-based resume**,
**quality filtering** (no-reasoning discard + corrupted-tool-name filter), and
**per-prompt container images** (`image`/`docker_image` row fields).

Today the feature is a Python CLI (`batch_runner.py` + `toolset_distributions.py` +
`trajectory_compressor.py`) reachable only through the managed Python runtime over the
Dashboard WS/REST link. The target is an **in-process TypeScript BatchRunner** in the
Tauri webview (same process as the TS agent core), with Rust only doing OS-level work:
atomic file writes, Docker image probing, and read-only run-history serving. The desktop
gains a "Batch Runs" UI: create/import dataset, pick distribution/model/concurrency,
watch progress, resume after interruption, and export `trajectories.jsonl`.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn` (root-level modules, not a package).

- `batch_runner.py` (1330 lines) — CLI + library:
  - `BatchRunner` (init at ~L529): loads JSONL dataset (`_load_dataset`, skips lines
    without `prompt`), truncates via `--max_samples`, slices batches
    (`_create_batches` → `[(idx, entry), …]`), validates distribution.
  - `_process_single_prompt` (L244): per-row `image`/`docker_image` override —
    `docker image inspect`/`docker pull` probe, then
    `register_task_env_overrides(task_id, …)` for Docker/Modal/Singularity/Daytona;
    samples toolsets via `sample_toolsets_from_distribution`; runs `AIAgent(...).run_conversation(prompt, task_id=...)`
    with `skip_context_files=True`, `skip_memory=True`; converts messages via
    `agent._convert_to_trajectory_format`.
  - `_extract_tool_stats` (L125): counts per-tool `{count, success, failure}` from
    assistant `tool_calls` + `tool` responses (JSON error-field heuristics).
  - `_extract_reasoning_stats` (L208): `<REASONING_SCRATCHPAD>` or native `reasoning`
    field per assistant turn.
  - `_process_batch_worker` (L400): writes each successful trajectory line to
    `batch_<n>.jsonl` with `flush()` + `os.fsync()` (durability), discards zero-reasoning
    samples, aggregates batch stats, returns completed indices.
  - `run(resume)` (L812): `multiprocessing.Pool` + `pool.imap_unordered`, rich Progress
    bar, **incremental checkpoint after each batch result** (parent process, `Lock` +
    `utils.atomic_json_write`), terminate/join on `KeyboardInterrupt`/exception;
    final merge of all `batch_*.jsonl` into `trajectories.jsonl` with corrupted-tool-name
    filter; writes `statistics.json`; prints tool/reasoning coverage tables.
  - Checkpoint (L690–776): `checkpoint.json` = `{run_name, completed_prompts, batch_stats,
    last_updated}`; resume scans existing batch files and matches **completed prompts by
    prompt text content** (`_scan_completed_prompts_by_content`), not by index;
    `_filter_dataset_by_completed` re-batches only remaining prompts; failed prompts are
    retried (only successfully saved trajectories are marked done).
- `toolset_distributions.py` (358 lines): `DISTRIBUTIONS` (default/image_gen/research/
  science/development/safe/balanced/minimal/terminal_only/terminal_web/creative/reasoning/
  browser_use/browser_only/browser_tasks/terminal_tasks/mixed_tasks); each distribution
  maps toolset → probability%; `sample_toolsets_from_distribution` flips each toolset
  independently (`random.random()*100 < prob`) and guarantees ≥1 toolset by picking the
  highest-probability one; `validate_distribution`, `list_distributions`,
  `print_distribution_info`.
- `trajectory_compressor.py` (1598 lines): `CompressionConfig` (tokenizer
  `moonshotai/Kimi-K2-Thinking`, target 15250 tokens, protected first/last turns,
  summarization model config, `num_workers`, `max_concurrent_requests`); `TrajectoryCompressor`
  — `_find_protected_indices` (protect first system/human/gpt/tool + last N),
  `_is_boundary_clean`/`_snap_boundary` (never split a gpt→tool pair), token counting via
  HuggingFace `AutoTokenizer`, middle-region summarization via LLM (`_generate_summary` /
  `_generate_summary_async`, `[CONTEXT SUMMARY]:` prefix), `TrajectoryMetrics`/
  `AggregateMetrics`, YAML config, `process_directory`.
- Docs: `D:/hermes-agent-cn/website/docs/user-guide/features/batch-processing.md`
  (dataset format, CLI table, output layout `data/<run_name>/`, trajectory JSON example,
  checkpoint/resume semantics, quality filtering, statistics, use cases).
- Tests (parity anchors): `tests/test_batch_runner_checkpoint.py` (atomic JSON writes, no
  `.tmp` leftovers, run-name isolation, no duplicate completed indices);
  `tests/test_batch_runner_durability.py` (fsync before completion, pool terminate+join);
  `tests/integration/test_batch_runner.py` (output shape: checkpoint/statistics/batch files);
  `tests/integration/test_checkpoint_resumption.py` (incremental checkpoint updates,
  interrupt → resume to completion); `tests/test_trajectory_compressor.py` (protected
  indices, tool-pair integrity, net-savings guard); `test_trajectory_compressor_async.py`
  (lazy async client, temperature omission per model); `tests/conformance/test_vector_generator.py`
  (ShareGPT `from`/`value` renderer oracles — trajectory format conformance).

## 3. Target TypeScript design

Module layout under `D:/Hermes-CN-Desktop/web/src/batch/` (runs in the webview,
same process as the TS agent core) plus Rust helpers in `D:/Hermes-CN-Desktop/src/`.

- `web/src/batch/types.ts` — zod schemas (Section 4) + TS types.
- `web/src/batch/distributions.ts` — port of `DISTRIBUTIONS`; `getDistribution`,
  `listDistributions`, `validateDistribution`, `sampleToolsetsFromDistribution(rng)`;
  injected seeded RNG (default `crypto`-based) for reproducibility.
- `web/src/batch/dataset.ts` — streaming JSONL parser (read via Tauri fs or File API),
  `maxSamples`, `createBatches` (keeps original `promptIndex`).
- `web/src/batch/scheduler.ts` — **port of kimi-code `SubagentBatch<T>`**:
  `BatchScheduler<T>` with normal ramp (initial 5, +1 per 700 ms), optional
  `maxConcurrency`, rate-limit phase (exponential backoff via `retry` npm), per-task
  timeout + AbortSignal, ordered results by input slot. Launcher interface:
  `{ spawn(task): Promise<RunHandle>, resume(agentId, opts), retry(agentId, opts) }`.
- `web/src/batch/runner.ts` — `BatchRunner` facade: dataset → batches → scheduler →
  per-prompt agent run → trajectory entry → append batch JSONL → incremental checkpoint.
  Mirrors `BatchRunner.run(resume)` semantics but is **async and in-process**; the agent
  per task is the in-process TS agent core (`runConversation`-equivalent) instead of
  `AIAgent` in a worker process.
- `web/src/batch/worker.ts` — per-prompt task: container-image override registration,
  distribution sampling, agent run, `extractToolStats`/`extractReasoningStats`,
  `normalizeToolStats`, `toTrajectoryEntry` (ShareGPT).
- `web/src/batch/checkpoint.ts` — `loadCheckpoint`/`saveCheckpoint` (atomic via Rust
  `atomic_write` command or temp+rename+`fsync`), `scanCompletedPromptsByContent`,
  `filterDatasetByCompleted`, checkpoint versioning.
- `web/src/batch/quality.ts` — no-reasoning discard + corrupted-tool-name filter (needs
  the valid-tool registry from the TS tool catalog, mirroring `ALL_POSSIBLE_TOOLS`).
- `web/src/batch/stats.ts` — aggregate tool stats, reasoning coverage, success rates,
  duration; builds `statistics.json` payload and UI view models.
- `web/src/batch/compressor.ts` — port of `TrajectoryCompressor`: protected indices,
  clean-boundary snapping, token estimation shim (Section 5), summarization via the
  desktop's model client (kosong), metrics.
- `web/src/batch/container-images.ts` — per-prompt image probe: calls Rust
  `batch_probe_image` (docker inspect/pull via `child_process`), registers sandbox
  overrides for the task's terminal session.

Data flow (in-process): dataset file → `dataset.ts` → task list → `scheduler.ts` ramps N
concurrent `worker.ts` runs → each appends its trajectory to `batch_<n>.jsonl` (fsync
through Rust) → parent updates `checkpoint.json` after each batch settles → on completion
`mergeTrajectories` filters corrupted entries → `trajectories.jsonl` + `statistics.json`.
Resume: `checkpoint.ts` scans batch files, matches prompt content, re-batches remainder.

## 4. Data models & persistence

Zod schemas in `D:/Hermes-CN-Desktop/packages/protocol/src/hermes-api.ts` (following
the `CronRun`/`CronRunsResponse` pattern at hermes-api.ts:982):

- `BatchRun` — `{ run_id, profile, run_name, distribution, model, batch_size,
  num_workers, status: 'running'|'completed'|'failed'|'interrupted', created_at,
  updated_at, total_prompts, completed_prompts, discarded_no_reasoning,
  artifacts_dir }`.
- `BatchRunsResponse` — `{ runs: BatchRun[] }`; `BatchRunDetail` extends with
  `statistics` and artifact listing (like `CronRunDetail` adds `content`).
- `TrajectoryEntry` — Python parity: `{ prompt_index, conversations: Array<{from:
  'human'|'gpt'|'tool'|'system', value: string}>, metadata: {batch_num, timestamp,
  model}, completed, partial, api_calls, toolsets_used, tool_stats:
  Record<string,{count,success,failure}>, tool_error_counts: Record<string,number> }`.
- `CheckpointData` — `{ schema_version: 1, run_name, completed_prompts: number[],
  completed_prompt_texts: string[], batch_stats: Record<string,{processed,skipped,
  discarded_no_reasoning}>, last_updated }`.
- `ToolsetDistribution` — `{ name, description, toolsets: Record<string, number> }`.

Persistence strategy (no SQLite needed initially):
- Artifacts under app-data `batch_runs/<run_id>/`: `batch_<n>.jsonl` (append-only, fsync
  before checkpoint marks completion — mirrors durability test), `checkpoint.json`
  (atomic temp+rename), `trajectories.jsonl`, `statistics.json`, `compression_metrics.json`.
- Run metadata (list UI) in a small JSON index (`batch_runs/index.json`) written by Rust
  `batch_runs.rs`, same read-only pattern as `src/cron_runs.rs` for
  `{HERMES_HOME}/cron/output/{job_id}/`; optionally later index trajectories in
  `@moonshot-ai/minidb` (kimi-code `packages/minidb` has WAL/snapshot/recovery — evidence
  for an embedded index if users need trajectory query/search).
- Migrations: `schema_version` in `checkpoint.json`; loader migrates v0 (Python-era
  `completed_prompts`-only) to v1 by scanning batch files, exactly like Python
  `_load_checkpoint` handles missing/corrupt files.

## 5. Third-party library strategy

| Python dependency | TS equivalent | Evidence / design |
|---|---|---|
| `multiprocessing.Pool` + `imap_unordered` | Promise-based `BatchScheduler` (port of `SubagentBatch<T>`) | kimi-code `packages/agent-core/src/session/subagent-batch.ts` — ordered slots, ramp launch, rate-limit backoff, per-task timeout; `packages/agent-core/src/agent/background/index.ts` BackgroundManager for lifecycle statuses |
| `orjson` | native `JSON.parse/stringify` + `zod` validation | kimi-code uses `zod` (`packages/agent-core/package.json`); zod v4 |
| `openai` / `AsyncOpenAI` | `@moonshot-ai/kosong` client | kimi-code agent-core depends on `@moonshot-ai/kosong`; used by background/loop for model calls |
| `retry` (Python jittered_backoff) | `retry` npm `0.13.1` | `packages/agent-core/package.json`; `subagent-batch.ts` imports `* as retry from 'retry'` |
| `utils.atomic_json_write` | temp+rename via Rust `atomic_write` or `proper-lockfile` | kimi-code uses `proper-lockfile` (agent-core deps) and atomic per-id JSON stores (`background/persist.ts` → `createPerIdJsonStore`) |
| `random` (distributions) | seeded PRNG from scratch (mulberry32) | **no kimi-code equivalent**; kimi-code only uses `crypto.randomBytes` for task ids. Implement `SeededRng` in `distributions.ts`; unseeded fallback `crypto.randomInt` |
| `transformers.AutoTokenizer` | token-estimation shim (see Risks) | **no TS equivalent in kimi-code**; implement `countTokens(text)` with `gpt-tokenizer` or char/4 fallback matching Python's exception path |
| `yaml` (CompressionConfig) | `js-yaml` | kimi-code agent-core dep `js-yaml` |
| `rich` Progress | React progress UI (shared-ui/spinners + recharts) | desktop `web/src/routes/analytics.tsx` chart patterns |
| `fire` CLI | React UI + Tauri commands | desktop has no CLI; commands mirror `web/src/hooks/use-cron.ts` mutation hooks |
| `docker`/Modal/Singularity CLI | Rust `batch_probe_image` via `child_process` | **no TS Docker-equivalent in kimi-code**; kimi-code shells out to native processes (native utils); Modal/Daytona backends out of scope for desktop standalone |
| `utils.base_url_host_matches` (provider detect) | `web/src/lib/provider-*` helpers | desktop already has `provider-catalog.ts`, `provider-id.ts`, `provider-probe.ts` |

## 6. Integration with existing Hermes-CN-Desktop frontend

- Reuse transport: `web/src/lib/transport.ts` (`fetchJSON`/`postJSON`), `web/src/lib/tauri-bridge.ts`
  for Rust IPC, `web/src/lib/gateway-client.ts` only during the transitional phase.
- New hooks modeled on `web/src/hooks/use-cron.ts`: `useBatchRuns()`,
  `useCreateBatchRun()`, `useBatchRunDetail()`, `useResumeBatchRun()`,
  `useBatchRunArtifacts()`; TanStack Query keys scoped by profile like
  `["cron-runs", profile, id]`.
- New Rust read-only command `src/batch_runs.rs` mirroring `src/cron_runs.rs`
  (route prefix `/__hermes_batch_runs/`, regex path validation, `canonical_starts_with`,
  size caps, JSON `run_json` shape) — serves run list/detail/artifact preview without
  exposing the Python backend.
- Reuse analytics UI stack: `web/src/lib/analytics.ts` view-model builders and
  `web/src/routes/analytics.tsx` recharts (Bar/Pie) for a "Batch" page — tool usage,
  reasoning coverage, success/failure rates, discarded counts, duration.
- Rust `src/commands/*` pattern for new commands: `batch_runs.rs` (read history),
  `batch_worker.rs` (spawn isolated child process per task when OS isolation needed),
  `atomic_write` helper; register in `src/lib.rs` next to existing commands.
- Protocol schemas added in `packages/protocol/src/hermes-api.ts` (Section 4), then
  imported by hooks exactly like `CronRunsResponse` is today.

## 7. Removing the WebSocket dependency (migration path)

1. **Today**: batch runs exist only in Python; Dashboard invokes them over the WS/REST
   link (`/api/ws` + REST). No desktop UI.
2. **Phase A (proxied)**: add Rust `batch_runs.rs` read-only endpoints serving Python-run
   artifacts from `HERMES_HOME` (`data/<run_name>/`), plus desktop UI reading them —
   keeps the Python execution path but freezes the artifact/API surface
   (`/__hermes_batch_runs/…`).
3. **Phase B (in-process behind same interface)**: implement `web/src/batch/*` with the
   TS agent core; the UI switches to in-process runs; keep the read-only Rust endpoints
   so old artifacts remain viewable. Same hook/API shape — only the transport target
   changes.
4. **Phase C (delete WS path)**: remove Python batch endpoints from the managed-runtime
   route table; the WS link for batch features is gone. Frozen surface during migration:
   `BatchRun`/`BatchRunsResponse`/`BatchRunDetail` shapes, artifact layout
   (`batch_*.jsonl`, `checkpoint.json`, `trajectories.jsonl`, `statistics.json`), and
   `BatchRun.status` enum.

## 8. Migration phases & task breakdown

- **Phase 0 — Parity fixtures**: convert Python batch fixtures (JSONL dataset + expected
  trajectory/checkpoint shapes) into `packages/protocol` zod schemas and vitest fixtures;
  port `tests/test_batch_runner_checkpoint.py` cases to `batch/checkpoint.test.ts`.
- **Phase 1 — Distributions + dataset**: `web/src/batch/distributions.ts` (seeded RNG),
  `dataset.ts`; vitest parity for sampling guarantees (≥1 toolset, independence) and
  JSONL parsing edge cases (missing `prompt`, invalid JSON, `maxSamples`).
- **Phase 2 — Scheduler**: port `SubagentBatch` → `BatchScheduler<T>`; tests for ramp,
  rate-limit backoff, cancellation, ordered results (mirror `subagent-batch.ts` contract
  comments).
- **Phase 3 — Runner + checkpoint**: `worker.ts`, `runner.ts`, `checkpoint.ts`;
  durability (flush-before-checkpoint), incremental checkpoint, content-based resume,
  no-duplicate completed list (port `test_batch_runner_durability.py` +
  `test_checkpoint_resumption.py`).
- **Phase 4 — Quality + stats + merge**: `quality.ts`, `stats.ts`, merge/filter
  corrupted entries; parity with `statistics.json` structure.
- **Phase 5 — Compressor**: port `compressor.ts` (protected indices, boundary snapping,
  summary prefix, net-savings guard; port `test_trajectory_compressor.py` +
  async-client tests).
- **Phase 6 — UI + Rust**: `batch_runs.rs`, `useBatchRuns` hooks, Batch page (create/
  progress/resume/export), zod schema additions; Playwright E2E.
- **Phase 7 — WS removal**: flip transport, delete Python batch REST/WS routes.

## 9. Risks & open questions

- **Tokenizer parity**: Python uses HuggingFace `AutoTokenizer`
  (`moonshotai/Kimi-K2-Thinking`). No TS equivalent in kimi-code; token counts will drift
  unless we adopt a WASM tokenizer (`@huggingface/transformers`) or accept the char/4
  fallback. Open: is exact token parity required for compression output?
- **Multiprocessing semantics**: Python uses process isolation per batch; TS in-process
  shares one event loop. Concurrency must be bounded by the model provider's rate limits
  (SubagentBatch handles this) and long-running tasks must yield. Rust child-process
  isolation remains an option for truly hostile tasks.
- **Per-prompt container images**: Docker CLI may be absent; Modal/Daytona backends are
  server-side and don't exist in desktop standalone. Decide: probe-and-fail-fast (Python
  parity) vs graceful degradation to local terminal.
- **Content-based resume with duplicate prompts**: Python matches by prompt text, so
  identical prompts collapse into one completed item. TS should adopt the same behavior
  but record ambiguity in `checkpoint.json` (`completed_prompt_texts` counts).
- **ShareGPT conversion parity**: `_convert_to_trajectory_format` lives in the Python
  agent; the TS agent core must reproduce `from`/`value`, `tool_calls` embedding, and
  `partial` flags exactly for HF-dataset compatibility.
- **Provider routing**: Python supports OpenRouter provider allow/ignore/order/sort;
  kimi-code model catalog covers some of this — verify the desktop's provider layer
  exposes the same knobs before dropping them.

## 10. Test strategy

- Vitest unit (port pytest parity, keep names mapped):
  - `batch/checkpoint.test.ts` ← `test_batch_runner_checkpoint.py`: atomic valid JSON,
    `last_updated`, overwrite, lock/queue, parent-dir creation, no `.tmp` leftovers,
    corrupt-file tolerance, run-name isolation, no duplicate completed indices.
  - `batch/durability.test.ts` ← `test_batch_runner_durability.py`: batch file flushed
    before checkpoint marks completion; cancellation/error path cleans up active tasks.
  - `batch/resume.test.ts` ← `test_checkpoint_resumption.py` + `test_batch_runner.py`:
    incremental checkpoint updates observable mid-run; interrupt → resume completes all
    prompts; output directory contains checkpoint/statistics/batch files.
  - `batch/distributions.test.ts` ← sampling contract from `toolset_distributions.py`:
    deterministic with seed, ≥1 toolset, invalid distribution error.
  - `batch/compressor.test.ts` ← `test_trajectory_compressor.py` +
    `test_trajectory_compressor_async.py`: protected indices, tool-pair boundary
    integrity, summary prefix, net-savings guard, lazy client creation, temperature
    omission contracts.
  - `batch/conformance.test.ts` ← `test_vector_generator.py`: ShareGPT `from`/`value`
    renderer invariants (first human message extraction used by resume scanning).
- Integration: drive `BatchRunner` against fixture JSONL with a mocked agent (no live
  API), assert `trajectories.jsonl` merge + corrupted-entry filtering.
- E2E (Playwright): create batch from sample dataset, observe progress, interrupt and
  resume, export artifacts; Rust endpoint tests for `/__hermes_batch_runs/` path
  validation (mirror `cron_runs.rs` unit tests).

## 11. Reference links

- Python: `D:/hermes-agent-cn/batch_runner.py`,
  `D:/hermes-agent-cn/toolset_distributions.py`,
  `D:/hermes-agent-cn/trajectory_compressor.py`,
  `D:/hermes-agent-cn/website/docs/user-guide/features/batch-processing.md`
- Python tests: `tests/test_batch_runner_checkpoint.py`, `test_batch_runner_durability.py`,
  `tests/integration/test_batch_runner.py`, `tests/integration/test_checkpoint_resumption.py`,
  `tests/test_trajectory_compressor.py`, `tests/test_trajectory_compressor_async.py`,
  `tests/conformance/test_vector_generator.py`
- kimi-code TS: `packages/agent-core/src/agent/background/index.ts`,
  `background/task.ts`, `background/agent-task.ts`, `background/persist.ts`,
  `packages/agent-core/src/session/subagent-batch.ts`, `session/subagent-host.ts`,
  `packages/agent-core/src/agent/records/persistence.ts`,
  `packages/kap-server/src/services/transcript/transcriptService.ts`,
  `packages/minidb` (embedded DB), `packages/agent-core/package.json` (retry, zod, js-yaml,
  proper-lockfile, ulid)
- Desktop: `web/src/hooks/use-cron.ts`, `web/src/lib/transport.ts`,
  `web/src/lib/analytics.ts`, `web/src/routes/analytics.tsx`,
  `src/cron_runs.rs`, `src/commands/api_proxy.rs`, `packages/protocol/src/hermes-api.ts`
  (CronRun/CronRunsResponse/CronRunDetail)
