---
name: desktop-dual-repo-test
description: Use when starting or verifying Hermes Agent CN Desktop with the latest Hermes-CN-Desktop and Hermes-CN-Core branches — dev smoke test (pnpm tauri:dev), packaged beta/release install, runtime badge, WS relay, or regression after merging both repos. Covers syncing both repos, dev-runtime isolation, clean DMG install, and the report table for路线 A/B verification.
---

# Desktop Dual-Repo Test

## Overview

Hermes Agent CN Desktop is a **two-repo** product:

| Repo | Role | Default sibling path |
|------|------|----------------------|
| `Eynzof/Hermes-CN-Desktop` | Tauri shell + React UI | this repo |
| `Eynzof/Hermes-CN-Core` | Managed runtime / kernel / Dashboard | `../Hermes-CN-Core` |

Always sync **both** repos to the intended branch before testing. Never assume a packaged app is wrong just because the UI commit looks short — compare against the desktop tag SHA. Kernel commit comes from Core, not Desktop.

## Guardrails

- Managed runtime port is **9120**. Do **not** use **9119** (user global Hermes Agent).
- Dev and packaged apps share `~/.hermes` profile data but use **separate runtime trees**:
  - Dev (`pnpm tauri:dev`): `…/cn.org.hermesagent.desktop/dev-runtime/`
  - Packaged app: `…/cn.org.hermesagent.desktop/runtime/`
- If packaged tests show kernel `dev-local` / commit `de3b` while UI is current, the production `current.json` was polluted by an old dev session — run migration (below), not a rebuild.
- macOS: detach all stale `Hermes Agent CN Desktop*` DMG volumes before reading or installing a release DMG. Never trust a mounted volume unless `hdiutil info` shows it came from the DMG you just downloaded.

## Step 0 — Sync both repositories

```bash
# Desktop (this repo)
cd /path/to/Hermes-CN-Desktop
git fetch origin
git checkout main && git pull --ff-only origin main
# or: git checkout <integration-branch> && git pull --ff-only

# Core (sibling)
cd /path/to/Hermes-CN-Core
git fetch origin
git checkout main && git pull --ff-only origin main
# or: git checkout <feature-branch> && git pull --ff-only
```

Record SHAs for the report:

```bash
cd /path/to/Hermes-CN-Desktop && git rev-parse --short HEAD
cd /path/to/Hermes-CN-Core && git rev-parse --short HEAD
```

Install deps once per repo after pulling:

```bash
cd /path/to/Hermes-CN-Desktop && pnpm install
```

## Step 1 — One-time cleanup (if packaged tests were ever run on a dev-polluted machine)

Run when production `runtime/current.json` has `"source": "local-source"` or kernel footer shows `dev-local` / `de3b` in the **packaged** app:

```bash
cd /path/to/Hermes-CN-Desktop
node scripts/migrate-runtime-trees.mjs
```

After PR #211 lands, new dev sessions no longer write into production `runtime/`; this step is mainly for machines used before that fix.

## 路线 A — Dev verification (both repos, latest code)

Use before pushing a desktop tag or when validating UI + gateway changes without a signed build.

```bash
cd /path/to/Hermes-CN-Desktop
pnpm tauri:dev -- --source ../Hermes-CN-Core
# optional: --force  to reinstall local kernel into dev-runtime
```

What this does:

1. `install-local-runtime.mjs` copies **Hermes-CN-Core** into `dev-runtime/versions/dev-local-*` and writes `dev-runtime/current.json` (`source: local-source`).
2. `tauri dev` loads WebView from `http://localhost:9545`, dashboard on **9120**, PATH `hermes` disabled.

**Expected dev signals**

| Check | Expected |
|-------|----------|
| Footer kernel line | `v0.16.x · <Core short SHA>` from local source |
| Footer UI line | desktop `package.json` version · `<Desktop short SHA>` |
| 设置 → 03 高级 → 内核 hero 徽章 | `dev-local · <commit>` (not `runtime-v*`) |
| WS 中继 (dev) | Often `未启用（webview 直连）` on macOS dev — record actual value |
| Chat round-trip | Send one message; streaming completes |

**Do not** use dev footer commits to judge a GHA release package. Route A only gates "merge + tag" readiness.

Pre-flight checks:

```bash
pnpm typecheck
pnpm test:unit
cargo check
```

## 路线 B — Packaged verification (GHA signed build)

Use after a desktop prerelease tag exists (e.g. `v0.3.3-beta.2`). Requires network for download unless `--dmg` is provided.

### Install (macOS arm64 example)

```bash
cd /path/to/Hermes-CN-Desktop
node scripts/migrate-runtime-trees.mjs   # if machine ever ran dev on same profile
node scripts/install-release-dmg.mjs \
  --tag v0.3.3-beta.2 \
  --expected-runtime 0.16.0-cn.6
open -a "Hermes Agent CN Desktop"
```

Verify the installed bundle before testing UI:

```bash
defaults read "/Applications/Hermes Agent CN Desktop.app/Contents/Info.plist" CFBundleShortVersionString
cat "/Applications/Hermes Agent CN Desktop.app/Contents/Resources/bundled-runtime/README.generated.txt"
```

`README.generated.txt` must show `repo=Eynzof/Hermes-CN-Core`, `tag=runtime-v0.16.0-cn.6` (or the tag under test), and `runtimeVersion=` matching `--expected-runtime`.

Intel Mac: asset name uses `_x64.dmg`. Windows: use the release `.exe` from the same GitHub tag page.

### Packaged checks (UI only — no devtools in release)

Wait for kernel ready (dashboard **9120** returns 200), then:

1. **03 高级 → 内核** hero badge: `runtime-v0.16.0-cn.6` (full release tag form), hover explains Core release tag.
2. **WS 中继**: `连接中（中继路径）` with hover text; then one chat round-trip. If `未启用（webview 直连）`, record it — still valid data.
3. Quick regression: session switch (no flash), soul page revisit, turn stats bar, approval + interrupt once.

**Expected packaged signals**

| Check | Expected |
|-------|----------|
| Footer UI | `v0.3.x · <tag short SHA>` — e.g. `40b2` for beta.2 tag HEAD |
| Footer kernel | `v0.16.x · a63e` (bundled Core commit), **not** `de3b` |
| Hero badge | `runtime-v0.16.0-cn.6` |

## Report table (fill and return)

| # | Item | Result |
|---|------|--------|
| 0 | Machine arch / OS · Desktop SHA · Core SHA | |
| 1 | Route (A dev / B packaged) · tag if B | |
| 2 | Kernel hero badge text | |
| 3 | WS relay value / hover / chat OK | |
| 4 | Session switch / soul page / stats / approval-interrupt | |
| 5 | Other anomalies | |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Packaged kernel shows `de3b` | `runtime/current.json` still `local-source` | `node scripts/migrate-runtime-trees.mjs`, reinstall or restart app |
| Installed app `0.2.x` / bundled `0.15.x` | Read wrong DMG volume | `hdiutil detach "/Volumes/Hermes Agent CN Desktop"*`, rerun `install-release-dmg.mjs` |
| Dev works, packaged chat dead | Port 9119 global agent conflict | Confirm desktop uses 9120 only |
| `pnpm tauri:dev` uses stale Core | Forgot `--source` or old dev-runtime | `pnpm tauri:dev -- --source ../Hermes-CN-Core --force` |
| UI `40b2` looks "old" | Misread — it matches desktop tag SHA | Compare `git rev-parse --short HEAD` on tagged desktop commit |

## When to run which route

- **PR merged, considering tag** → 路线 A on both repos' latest `main` (or integration branch).
- **Tag pushed, GHA green** → 路线 B on release asset; 路线 A results do not replace B for runtime badge or macOS relay.
- **Formal public release** → also run `.codex/skills/desktop-release-sync-landing/SKILL.md` for landing / `latest.json`.