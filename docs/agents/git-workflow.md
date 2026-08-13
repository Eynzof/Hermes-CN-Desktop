# Git 工作流（人工执行）

> 本文档内容从 `AGENTS.md` / `CLAUDE.md` 及 `.codex/skills/` 抽取，用于**人**（或 CI/CD 流水线）执行。
> 编码代理（Codex / Claude / KimiX 等）**不执行**本节任何命令；代理只做只读检查（`git status` / `git diff` / `git log` / `git rev-parse`）用于验证与报告。详见 [README.md](./README.md) 的铁律。

## 1. 开发前预检（双仓同步 + Worktree 隔离）

Hermes CN 的需求与 bug 修复通常**同时横跨 Desktop 与 Core 两个仓库**。正式动手写代码前，两个仓库都必须先过这道预检，**不要直接在 `main` 上改**：

1. **确认主分支已与远端同步**。对 Desktop 与 Core 分别 `git fetch origin`，确认本地 `main` 与 `origin/main` 一致（`git rev-list --left-right --count main...origin/main` 应为 `0  0`）；落后就先快进，工作区脏就先收拾干净。
2. **为每个仓库开独立的功能分支 + git worktree**，让 Desktop 与 Core 的改动互不干扰、可并行：
   ```bash
   git -C <repo> fetch origin
   git -C <repo> worktree add ../wt/<repo>-<topic> -b <branch> origin/main
   ```
   分支命名沿用 Conventional 风格（`feat/` `fix/` `docs/` `chore/` …）。同一任务在两仓用同名分支，方便对应。
3. 不要在同一个工作目录里来回 `git checkout` 切分支——双仓并行时极易串味；每条线一个 worktree。

## 2. 收尾流程（每个仓库都要走完，缺一不可）

改完 → `pnpm typecheck && pnpm test:unit && cargo check` → commit → push → 开 PR → **盯 PR 上 GitHub Actions 的构建与测试全绿**（`rust-test.yml` / `web-test.yml`），没过就回去修，别把任务当完成。

## 3. Commit 风格

- Conventional commit：`feat` / `fix` / `style` / `docs` / `refactor` / `chore`
- 标题用英文短句、命令式（"add ...", "fix ...", "rework ..."）
- 描述可中英混用，写"为什么"而不是"做了什么"

## 4. 测试前仓库同步（dual-repo-test 用）

开始双仓库测试前，先把两个仓库同步到目标分支（由人执行）：

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

记录 SHA 用于测试报告（只读，编码代理可做）：

```bash
cd /path/to/Hermes-CN-Desktop && git rev-parse --short HEAD
cd /path/to/Hermes-CN-Core && git rev-parse --short HEAD
```

## 5. 发版 / Landing 同步（release 流程用）

- 打 tag、push tag 触发 `release-desktop.yml` / `release-runtime.yml`（例如 `git tag runtime-v0.16.0-cn.5; git push origin runtime-v0.16.0-cn.5`；桌面端 `git tag v0.8.0-rc4; git push origin v0.8.0-rc4`）。
- stable/正式公开版本发完后同步 landing 仓库：为 `Eynzof/hermes-agent-cn-desktop-landing` 开独立分支（例如 `codex/update-desktop-latest-json`）→ 更新官网版本与 `https://desktop.hermesagent.org.cn/latest.json` 清单 → commit → 为 Desktop 与 Landing 两个仓库分别开 PR，并在 Desktop release PR 中提及 landing PR（或明确说明 landing 无需变更）。
- RC / beta / alpha / canary 等预发布或内测版本**禁止**创建 landing 分支 / worktree、禁止更新官网、禁止让 `latest.json` 指向预发布版本。
