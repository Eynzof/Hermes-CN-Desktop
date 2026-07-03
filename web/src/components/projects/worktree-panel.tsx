import { useState } from "react";
import {
  ExternalLink,
  GitBranch as GitBranchIcon,
  Lock,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import type { GitBranch, Worktree } from "@/lib/runtime";
import { useWorktrees } from "@/hooks/use-worktrees";
import { shortenPath } from "@/lib/paths";
import s from "./worktree-panel.module.css";

interface WorktreePanelProps {
  /** The project's directory — treated as the repo root. */
  repoPath: string;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function openInFinder(path: string): void {
  void window.hermesDesktop?.openWorkspacePath?.({ path });
}

// Backend-authoritative git worktree integration for a project (issue #327):
// the repo's live worktrees + branch list, with create / remove / switch /
// checkout, mirroring the upstream desktop "Start work" flow.
export function WorktreePanel({ repoPath }: WorktreePanelProps) {
  const wt = useWorktrees(repoPath);
  const [newName, setNewName] = useState("");

  // The git bridge only exists in the desktop shell; hide the panel in the browser.
  if (typeof window === "undefined" || !window.hermesDesktop?.git) {
    return null;
  }

  const submitCreate = () => {
    const name = newName.trim();
    if (!name || wt.busy) return;
    void wt.addWorktree(name).then((ok) => {
      if (ok) setNewName("");
    });
  };

  const onRemove = (tree: Worktree) => {
    if (tree.isMain) return;
    const confirmed = window.confirm(
      `确认删除工作树「${basename(tree.path)}」？这会移除该 worktree 目录，但不删除其分支。`,
    );
    if (confirmed) void wt.removeWorktree(tree.path);
  };

  // Branches that aren't checked out anywhere can be turned into a worktree.
  const checkoutable = wt.branches.filter((b) => !b.checkedOut);

  return (
    <section className={s.panel}>
      <div className={s.head}>
        <h2 className={s.title}>
          <GitBranchIcon size={15} aria-hidden /> Git 工作树
        </h2>
        {wt.status?.branch ? (
          <span className={s.branchChip} title="当前分支">
            {wt.status.branch}
          </span>
        ) : wt.status?.detached ? (
          <span className={s.branchChip} data-tone="muted">
            游离 HEAD
          </span>
        ) : null}
        {wt.status ? <RepoStatusSummary status={wt.status} /> : null}
        <button
          type="button"
          className={s.iconBtn}
          onClick={wt.refresh}
          title="刷新"
          aria-label="刷新工作树"
        >
          <RefreshCw size={13} aria-hidden className={wt.loading ? s.spin : undefined} />
        </button>
      </div>

      {wt.error ? (
        <div className={s.error} role="alert">
          <span>{wt.error}</span>
          <button type="button" className={s.errorClose} onClick={wt.dismissError} aria-label="关闭">
            <X size={12} aria-hidden />
          </button>
        </div>
      ) : null}

      {!wt.isRepo && !wt.loading ? (
        <p className={s.hint}>
          这个目录还不是 git 仓库。新建工作树会自动为它初始化仓库并提交一个空的初始提交。
        </p>
      ) : null}

      {wt.worktrees.length > 0 ? (
        <ul className={s.list}>
          {wt.worktrees.map((tree) => (
            <li key={tree.path} className={s.row}>
              <span className={s.rowMain}>
                <span className={s.rowBranch}>
                  {tree.branch ?? (tree.detached ? "游离 HEAD" : "—")}
                  {tree.isMain ? <span className={s.badge}>主</span> : null}
                  {tree.locked ? (
                    <span className={s.badge} data-tone="muted" title="已锁定">
                      <Lock size={10} aria-hidden />
                    </span>
                  ) : null}
                </span>
                <span className={s.rowPath} title={tree.path}>
                  {shortenPath(tree.path)}
                </span>
              </span>
              <span className={s.rowActions}>
                <button
                  type="button"
                  className={s.iconBtn}
                  onClick={() => openInFinder(tree.path)}
                  title="在文件管理器打开"
                  aria-label="在文件管理器打开"
                >
                  <ExternalLink size={13} aria-hidden />
                </button>
                <button
                  type="button"
                  className={s.iconBtn}
                  onClick={() => onRemove(tree)}
                  disabled={tree.isMain || wt.busy}
                  title={tree.isMain ? "主工作树不可删除" : "删除工作树"}
                  aria-label="删除工作树"
                  data-tone="danger"
                >
                  <Trash2 size={13} aria-hidden />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className={s.createRow}>
        <input
          className={s.input}
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submitCreate();
            }
          }}
          placeholder="新建工作树（输入名称，将创建 hermes/<名称> 分支）"
          disabled={wt.busy}
        />
        <button
          type="button"
          className={s.createBtn}
          onClick={submitCreate}
          disabled={!newName.trim() || wt.busy}
        >
          <Plus size={13} aria-hidden /> 新建
        </button>
      </div>

      {checkoutable.length > 0 ? (
        <BranchPicker
          branches={checkoutable}
          busy={wt.busy}
          onCheckout={(name) => void wt.checkoutBranch(name)}
          onSwitch={(name) => void wt.switchBranch(name)}
        />
      ) : null}
    </section>
  );
}

function RepoStatusSummary({ status }: { status: import("@/lib/runtime").RepoStatus }) {
  return (
    <span className={s.statusSummary}>
      {status.ahead > 0 ? <span title="领先远端">↑{status.ahead}</span> : null}
      {status.behind > 0 ? <span title="落后远端">↓{status.behind}</span> : null}
      {status.added > 0 ? <span className={s.add}>+{status.added}</span> : null}
      {status.removed > 0 ? <span className={s.del}>−{status.removed}</span> : null}
      {status.changed > 0 ? (
        <span title="改动文件数">{status.changed} 改动</span>
      ) : (
        <span className={s.clean}>干净</span>
      )}
    </span>
  );
}

function BranchPicker({
  branches,
  busy,
  onCheckout,
  onSwitch,
}: {
  branches: GitBranch[];
  busy: boolean;
  onCheckout: (name: string) => void;
  onSwitch: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className={s.branches} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className={s.branchesSummary}>未检出的分支（{branches.length}）</summary>
      <ul className={s.branchList}>
        {branches.map((branch) => (
          <li key={branch.name} className={s.branchRow}>
            <span className={s.branchName} title={branch.name}>
              {branch.name}
              {branch.isDefault ? <span className={s.badge}>默认</span> : null}
            </span>
            <span className={s.rowActions}>
              <button
                type="button"
                className={s.miniBtn}
                onClick={() => onCheckout(branch.name)}
                disabled={busy}
                title="把该分支检出为一个新工作树"
              >
                检出为工作树
              </button>
              <button
                type="button"
                className={s.miniBtn}
                onClick={() => onSwitch(branch.name)}
                disabled={busy}
                title="在主工作树切换到该分支"
              >
                切换
              </button>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
