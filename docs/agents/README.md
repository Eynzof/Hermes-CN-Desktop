# docs/agents/ — 编码代理文档

本目录存放与编码代理（Codex / Claude / KimiX 等 coding agent）协作方式相关的文档。

## 铁律：编码代理不做任何自动 Git 操作

编码代理**绝不自动执行**任何会改动仓库状态、切换分支或把变更发布出去的 Git 操作：

- ❌ 禁止：`git commit` / `git push` / `git pull` / `git fetch` / `git checkout` / `git branch` / `git worktree add` / `git merge` / `git rebase` / `git tag` / `git stash`
- ❌ 禁止：创建或合并 Pull Request、创建 GitHub Release、打 tag / push tag、同步 landing 仓库、向远端发布任何变更
- ✅ 允许（只读，仅用于验证与报告）：`git status` / `git diff` / `git log` / `git show` / `git rev-parse`

所有仓库同步、分支 / worktree 管理、commit、push、PR、tag、Release 均由**人**执行（或由 CI/CD 流水线触发）。编码代理只负责：把代码改好、本地验证通过、把改动和说明完整交给人来提交。

具体 Git 操作流程见 [git-workflow.md](./git-workflow.md)（供人执行参考，不是给编码代理的操作指引）。

## 目录

- [git-workflow.md](./git-workflow.md) — 双仓同步 / worktree 隔离 / commit / push / PR / tag / Landing 同步的完整人工操作流程
