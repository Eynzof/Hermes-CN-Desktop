import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  GitPullRequest,
  List,
  ListTree,
  Minus,
  Plus,
  RefreshCw,
  Undo2,
  X,
} from "lucide-react";
import type { ReviewFile } from "@/lib/runtime";
import { buildReviewFlatList, buildReviewTree, type ReviewTreeNode } from "@/lib/review-tree";
import { useReview, type CommitAction } from "@/hooks/use-review";
import s from "./preview-rail.module.css";

interface ReviewTabProps {
  /** Session workspace root — the repo the pane reads as source of truth. */
  workspaceRoot: string;
  /** Whether the review tab is the active rail panel (gates auto-refresh). */
  active: boolean;
}

// Per git status letter: a tone so the file's nature reads at a glance.
const STATUS_TONE: Record<string, string> = {
  A: "added",
  C: "added",
  D: "removed",
  M: "modified",
  R: "renamed",
  U: "conflict",
  "?": "untracked",
};

function statusTone(status: string): string {
  return STATUS_TONE[status] ?? "modified";
}

export function ReviewTab({ workspaceRoot, active }: ReviewTabProps) {
  const review = useReview(workspaceRoot, active);
  const {
    files,
    loading,
    isRepo,
    selectedFile,
    diff,
    diffLoading,
    shipInfo,
    shipBusy,
    actionError,
    treeMode,
    commitDefault,
  } = review;

  // Revert is destructive (no undo), so it always routes through a confirm. The
  // target is `{ path }` where `path === null` means "revert all".
  const [revertTarget, setRevertTarget] = useState<{ path: string | null } | null>(null);
  const [message, setMessage] = useState("");

  const nodes = useMemo(
    () => (treeMode === "tree" ? buildReviewTree(files) : buildReviewFlatList(files)),
    [files, treeMode],
  );

  const hasFiles = files.length > 0;

  if (!workspaceRoot) {
    return (
      <div className={s.empty}>
        <GitPullRequest size={24} aria-hidden />
        <p>本会话还没有关联工作区，无法审查改动。</p>
      </div>
    );
  }

  if (!isRepo && !loading) {
    return (
      <div className={s.empty}>
        <GitPullRequest size={24} aria-hidden />
        <p>当前工作区不是 git 仓库，没有可审查的改动。</p>
      </div>
    );
  }

  return (
    <div className={s.reviewLayout}>
      <div className={s.reviewToolbar}>
        <span className={s.reviewToolbarTitle}>改动</span>
        <button
          type="button"
          className={s.iconBtn}
          onClick={() => review.setTreeMode(treeMode === "tree" ? "list" : "tree")}
          disabled={!hasFiles}
          title={treeMode === "tree" ? "切换为列表视图" : "切换为树状视图"}
          aria-label={treeMode === "tree" ? "切换为列表视图" : "切换为树状视图"}
        >
          {treeMode === "tree" ? <List size={13} aria-hidden /> : <ListTree size={13} aria-hidden />}
        </button>
        <button
          type="button"
          className={s.iconBtn}
          onClick={review.stageAll}
          disabled={!hasFiles}
          title="暂存全部"
          aria-label="暂存全部"
        >
          <Plus size={13} aria-hidden />
        </button>
        <button
          type="button"
          className={s.iconBtn}
          onClick={() => setRevertTarget({ path: null })}
          disabled={!hasFiles}
          title="还原全部改动"
          aria-label="还原全部改动"
        >
          <Undo2 size={13} aria-hidden />
        </button>
        <button
          type="button"
          className={s.iconBtn}
          onClick={review.refresh}
          title="刷新改动列表"
          aria-label="刷新改动列表"
        >
          <RefreshCw size={13} aria-hidden className={loading ? s.spin : undefined} />
        </button>
      </div>

      {actionError ? (
        <div className={s.reviewError} role="alert">
          <span>{actionError}</span>
          <button type="button" className={s.reviewErrorClose} onClick={review.dismissError} aria-label="关闭">
            <X size={12} aria-hidden />
          </button>
        </div>
      ) : null}

      <div className={s.reviewTree}>
        {hasFiles ? (
          <ReviewNodeList
            nodes={nodes}
            depth={0}
            selectedPath={review.selectedPath}
            onSelect={review.selectFile}
            onStage={review.stage}
            onUnstage={review.unstage}
            onRevert={(path) => setRevertTarget({ path })}
          />
        ) : loading ? (
          <div className={s.reviewHint}>读取改动中…</div>
        ) : (
          <div className={s.reviewHint}>没有未提交的改动。</div>
        )}
      </div>

      {selectedFile ? (
        <div className={s.reviewDiffPane}>
          <div className={s.reviewDiffHeader}>
            <span className={s.reviewDiffPath} title={selectedFile.path}>
              {selectedFile.path}
            </span>
            <DiffCount added={selectedFile.added} removed={selectedFile.removed} />
            <button
              type="button"
              className={s.iconBtn}
              onClick={() =>
                selectedFile.staged
                  ? review.unstage(selectedFile.path)
                  : review.stage(selectedFile.path)
              }
              title={selectedFile.staged ? "取消暂存" : "暂存"}
              aria-label={selectedFile.staged ? "取消暂存" : "暂存"}
            >
              {selectedFile.staged ? <Minus size={13} aria-hidden /> : <Plus size={13} aria-hidden />}
            </button>
            <button
              type="button"
              className={s.iconBtn}
              onClick={review.clearSelection}
              title="关闭"
              aria-label="关闭差异"
            >
              <X size={13} aria-hidden />
            </button>
          </div>
          <div className={s.reviewDiffBody}>
            {diffLoading ? (
              <div className={s.reviewHint}>读取差异中…</div>
            ) : diff ? (
              <DiffView diff={diff} />
            ) : (
              <div className={s.reviewHint}>没有差异内容。</div>
            )}
          </div>
        </div>
      ) : null}

      {hasFiles ? (
        <ReviewShipBar
          ghReady={shipInfo.ghReady}
          hasPr={Boolean(shipInfo.pr?.url)}
          busy={shipBusy}
          message={message}
          commitDefault={commitDefault}
          onMessageChange={setMessage}
          onCommit={(action) => {
            void review.commit(message, action === "commitPush").then((ok) => {
              if (ok) setMessage("");
            });
          }}
          onSetCommitDefault={review.setCommitDefault}
          onPr={review.createOrOpenPr}
        />
      ) : null}

      {revertTarget ? (
        <RevertConfirm
          target={revertTarget}
          onCancel={() => setRevertTarget(null)}
          onConfirm={() => {
            const target = revertTarget;
            setRevertTarget(null);
            if (target.path === null) {
              review.revertAll();
            } else {
              review.revert(target.path);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function ReviewNodeList({
  nodes,
  depth,
  selectedPath,
  onSelect,
  onStage,
  onUnstage,
  onRevert,
}: {
  nodes: ReviewTreeNode[];
  depth: number;
  selectedPath: string | null;
  onSelect: (file: ReviewFile) => void;
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
  onRevert: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.isDir ? (
          <ReviewDirRow
            key={node.id}
            node={node}
            depth={depth}
            selectedPath={selectedPath}
            onSelect={onSelect}
            onStage={onStage}
            onUnstage={onUnstage}
            onRevert={onRevert}
          />
        ) : (
          <ReviewFileRow
            key={node.id}
            node={node}
            depth={depth}
            selected={node.file?.path === selectedPath}
            onSelect={onSelect}
            onStage={onStage}
            onUnstage={onUnstage}
            onRevert={onRevert}
          />
        ),
      )}
    </>
  );
}

function ReviewDirRow({
  node,
  depth,
  selectedPath,
  onSelect,
  onStage,
  onUnstage,
  onRevert,
}: {
  node: ReviewTreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (file: ReviewFile) => void;
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
  onRevert: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button
        type="button"
        className={s.reviewRow}
        style={{ paddingLeft: depth * 12 + 8 }}
        onClick={() => setOpen((value) => !value)}
        title={node.name}
      >
        {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        <span className={s.reviewRowName}>{node.name}</span>
        <DiffCount added={node.added} removed={node.removed} />
      </button>
      {open && node.children ? (
        <ReviewNodeList
          nodes={node.children}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onStage={onStage}
          onUnstage={onUnstage}
          onRevert={onRevert}
        />
      ) : null}
    </>
  );
}

function ReviewFileRow({
  node,
  depth,
  selected,
  onSelect,
  onStage,
  onUnstage,
  onRevert,
}: {
  node: ReviewTreeNode;
  depth: number;
  selected: boolean;
  onSelect: (file: ReviewFile) => void;
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
  onRevert: (path: string) => void;
}) {
  const file = node.file;
  if (!file) return null;

  return (
    <div
      className={s.reviewRow}
      data-selected={selected ? "true" : undefined}
      style={{ paddingLeft: depth * 12 + 8 }}
      onClick={() => onSelect(file)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(file);
        }
      }}
      role="button"
      tabIndex={0}
      title={file.path}
    >
      <span className={s.reviewStatus} data-tone={statusTone(file.status)} aria-hidden>
        {file.status}
      </span>
      <span className={s.reviewRowName}>{node.name}</span>
      {node.dir ? <span className={s.reviewRowDir}>{node.dir}</span> : null}
      <span className={s.reviewRowActions}>
        <button
          type="button"
          className={s.reviewRowBtn}
          onClick={(event) => {
            event.stopPropagation();
            file.staged ? onUnstage(file.path) : onStage(file.path);
          }}
          title={file.staged ? "取消暂存" : "暂存"}
          aria-label={file.staged ? "取消暂存" : "暂存"}
        >
          {file.staged ? <Minus size={12} aria-hidden /> : <Plus size={12} aria-hidden />}
        </button>
        <button
          type="button"
          className={s.reviewRowBtn}
          onClick={(event) => {
            event.stopPropagation();
            onRevert(file.path);
          }}
          title="还原"
          aria-label="还原"
        >
          <Undo2 size={12} aria-hidden />
        </button>
      </span>
      <DiffCount added={node.added} removed={node.removed} className={s.reviewRowCount} />
      {file.staged ? <span className={s.reviewStagedDot} title="已暂存" aria-hidden /> : null}
    </div>
  );
}

function DiffCount({
  added,
  removed,
  className,
}: {
  added: number;
  removed: number;
  className?: string;
}) {
  return (
    <span className={className ? `${s.diffCount} ${className}` : s.diffCount}>
      {added > 0 ? <span className={s.diffCountAdd}>+{added}</span> : null}
      {removed > 0 ? <span className={s.diffCountDel}>−{removed}</span> : null}
    </span>
  );
}

// Classify one unified-diff line so it can be tinted. Order matters: file/meta
// headers and the hunk marker are checked before the bare +/- content lines.
function diffLineKind(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("rename ") ||
    line.startsWith("similarity ") ||
    line.startsWith("Binary files")
  ) {
    return "meta";
  }
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

function DiffView({ diff }: { diff: string }) {
  // Drop a trailing empty line so the view doesn't end on a blank row.
  const lines = useMemo(() => diff.replace(/\n$/, "").split("\n"), [diff]);
  return (
    <pre className={s.diffPre}>
      {lines.map((line, index) => (
        <span key={index} className={s.diffLine} data-kind={diffLineKind(line)}>
          {line || " "}
        </span>
      ))}
    </pre>
  );
}

function ReviewShipBar({
  ghReady,
  hasPr,
  busy,
  message,
  commitDefault,
  onMessageChange,
  onCommit,
  onSetCommitDefault,
  onPr,
}: {
  ghReady: boolean;
  hasPr: boolean;
  busy: boolean;
  message: string;
  commitDefault: CommitAction;
  onMessageChange: (value: string) => void;
  onCommit: (action: CommitAction) => void;
  onSetCommitDefault: (action: CommitAction) => void;
  onPr: () => void;
}) {
  const canCommit = message.trim().length > 0 && !busy;
  const prLabel = hasPr ? "打开 PR" : "创建 PR";

  return (
    <div className={s.reviewShip}>
      <textarea
        className={s.reviewCommitInput}
        value={message}
        onChange={(event) => onMessageChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            if (canCommit) onCommit(commitDefault);
          }
        }}
        placeholder="提交说明（⌘/Ctrl+Enter 提交）"
        rows={1}
        spellCheck={false}
      />
      <div className={s.reviewShipActions}>
        <button
          type="button"
          className={s.reviewCommitBtn}
          disabled={!canCommit}
          onClick={() => onCommit(commitDefault)}
        >
          {commitDefault === "commitPush" ? "提交并推送" : "提交"}
        </button>
        <select
          className={s.reviewCommitMode}
          value={commitDefault}
          disabled={busy}
          onChange={(event) => onSetCommitDefault(event.target.value as CommitAction)}
          aria-label="提交方式"
          title="默认提交方式"
        >
          <option value="commit">提交</option>
          <option value="commitPush">提交并推送</option>
        </select>
        <button
          type="button"
          className={s.iconBtn}
          disabled={!ghReady || busy}
          onClick={onPr}
          title={ghReady ? prLabel : "需要安装并登录 GitHub CLI（gh）"}
          aria-label={prLabel}
        >
          <GitPullRequest size={14} aria-hidden />
        </button>
      </div>
    </div>
  );
}

function RevertConfirm({
  target,
  onCancel,
  onConfirm,
}: {
  target: { path: string | null };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const all = target.path === null;
  return (
    <div className={s.reviewModalBackdrop} onClick={onCancel}>
      <div
        className={s.reviewModal}
        role="dialog"
        aria-modal="true"
        aria-label={all ? "还原全部改动" : "还原文件"}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={s.reviewModalTitle}>{all ? "还原全部改动" : "还原文件"}</div>
        <div className={s.reviewModalBody}>
          这会丢弃工作区里的改动，且不可撤销。
          {!all && target.path ? <span className={s.reviewModalPath}>{target.path}</span> : null}
        </div>
        <div className={s.reviewModalActions}>
          <button type="button" className={s.reviewModalBtn} onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className={s.reviewModalBtn}
            data-variant="danger"
            onClick={onConfirm}
          >
            {all ? "还原全部" : "还原"}
          </button>
        </div>
      </div>
    </div>
  );
}
