---
name: desktop-release-sync-landing
description: Use only for stable/public Hermes Agent CN Desktop releases that should be visible to all users. Ensures the desktop repo version is synchronized and the separate landing repository updates its website version and https://desktop.hermesagent.org.cn/latest.json manifest for the same stable release. Do not use for rc, beta, alpha, canary, or other internal prereleases.
---

# Desktop Release Sync Landing

## Overview

Use this skill only when a **stable/public** desktop release is prepared, published, fixed, or documented. A stable release is not complete until the landing repository has been updated so `/latest.json` points at the same version and users can download the matching installers.

## Prerelease Rule

**RC / beta / alpha / canary and any other prerelease or internal-test version must not touch the landing repository.** Do not open a landing branch, do not update website copy, and do not point `https://desktop.hermesagent.org.cn/latest.json` at a prerelease. Prerelease builds are distributed through GitHub Release, manual download, or a dedicated internal channel only; the public website and update manifest must continue to represent the latest stable release.

## Release workflow

1. Treat `package.json` in this repository as the desktop version source of truth. After changing it, run `pnpm run version:sync` and verify `Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, workspace package versions, READMEs, and release docs are synchronized.
2. Run the desktop checks that match the change, at minimum `pnpm typecheck`, `pnpm test:unit`, and `cargo check`. For release PRs also run `cargo fmt --check`, `cargo clippy --all-features -- -D warnings`, and `cargo test --all-features` when practical.
3. After the GitHub Release exists, get the authoritative release and asset metadata with:

   ```bash
   gh release view v$VERSION -R Eynzof/Hermes-CN-Desktop --json tagName,publishedAt,url,assets
   ```

   Do not invent `size`, `sha256`, `publishedAt`, or installer URLs. If the release job has not produced assets yet, stop and state that the landing sync is blocked on release assets.
   If `$VERSION` contains a prerelease suffix such as `-rc`, `-beta`, `-alpha`, or `-canary`, stop here and report that landing sync is intentionally forbidden for prereleases.
4. The **human** opens a separate branch for `Eynzof/hermes-agent-cn-desktop-landing`, for example `codex/update-desktop-latest-json`. The coding agent only prepares the landing file edits below and never runs git operations — branch / commit / push / PR are executed by the human (see `docs/agents/git-workflow.md` §5).
5. In the landing repo, update the public release state for the same desktop version:

   - `src/site.config.ts`: set `VERSION` to the bare semver, for example `0.3.0`.
   - `public/_worker.js`: update `MANIFEST.version`, `MANIFEST.semver`, `publishedAt`, `sourceUrl`, `updatedAt`, asset `fileName`, `size`, `sha256`, `versionedUrl`, `sourceUrl`, and `/releases/v...` redirect entries.
   - `src/i18n/zh.ts` and `src/i18n/en.ts`: update visible Alpha/current-version copy when it names the old version.
   - `docs/PRD.md`: update the associated product version if it names the old version.

   Keep `https://desktop.hermesagent.org.cn/latest.json` as the update manifest endpoint and `https://desktop.hermesagent.org.cn/#download` as the manual download entry.
6. Validate the landing change with `pnpm build`. Also directly exercise the worker manifest path when possible:

   ```bash
   node -e "import('./public/_worker.js').then(async (m) => { const r = await m.default.fetch(new Request('https://desktop.hermesagent.org.cn/latest.json'), {}); console.log(r.status, await r.text()); })"
   ```

   Confirm the response contains the same `version`, `semver`, asset names, sizes, hashes, and release URLs as the GitHub Release.
7. The **human** commits and opens PRs for both repositories when both changed (the coding agent must not do this). Mention the landing PR from the desktop release PR, or clearly state when landing did not need changes.

## Guardrails

- Coding agents never run git operations (commit / push / pull / checkout / branch / worktree / PR). Landing repo changes are prepared by the agent and committed, pushed, and PRed by the human; see `docs/agents/git-workflow.md`.

Do not close a stable/public release task by only updating this desktop repository when the public version changed. Either update landing in the same work session or explicitly report that landing sync is pending and why.

For prerelease tasks, the correct outcome is the opposite: explicitly state that landing/latest.json was not changed because prereleases must not be visible through the public website or public update manifest.

Do not change the release repository identity in landing just because GitHub redirects between `Eynzof/hermes-agent-cn-desktop` and `Eynzof/Hermes-CN-Desktop`; trust `gh release view` and preserve the canonical repository used by the current landing manifest unless live release metadata proves otherwise.
