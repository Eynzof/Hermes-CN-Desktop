import { useState } from "react";
import { Button, Field, Input, Select, Textarea } from "@hermes/shared-ui";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ProfileSummary } from "@hermes/protocol";
import {
  useCreateProfile,
  useDeleteProfile,
  useRenameProfile,
} from "@/hooks/use-profiles";
import { ProfileDialogShell } from "./profile-dialog-shell";
import {
  parseModelChoiceKey,
  ProfileModelSelect,
  useModelChoices,
} from "./profile-model-select";
import s from "./profiles.module.css";

// 对齐上游创建端点的归一化规则：小写字母/数字/-/_，字母或数字开头，最长 64。
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : "操作失败";
}

// ── 创建档案 ─────────────────────────────────────────────────
export function ProfileCreateDialog({
  profiles,
  onClose,
}: {
  profiles: ProfileSummary[];
  onClose: () => void;
}) {
  const create = useCreateProfile();
  const { choices, loading: modelLoading } = useModelChoices();
  const [name, setName] = useState("");
  const [cloneFrom, setCloneFrom] = useState("");
  const [description, setDescription] = useState("");
  const [modelKey, setModelKey] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [cloneAll, setCloneAll] = useState(false);
  const [noSkills, setNoSkills] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cloning = cloneFrom.length > 0;

  const submit = () => {
    setError(null);
    const trimmed = name.trim();
    if (!NAME_RE.test(trimmed)) {
      setError("只允许小写字母 / 数字 / - / _，以字母或数字开头，最长 64 字符");
      return;
    }
    if (profiles.some((p) => p.name === trimmed)) {
      setError("已存在同名档案");
      return;
    }
    const picked = parseModelChoiceKey(modelKey);
    create.mutate(
      {
        name: trimmed,
        clone_from: cloning ? cloneFrom : undefined,
        clone_all: cloning && cloneAll ? true : undefined,
        no_skills: !cloning && noSkills ? true : undefined,
        description: description.trim() || undefined,
        provider: picked?.provider,
        model: picked?.model,
      },
      {
        onSuccess: onClose,
        onError: (err) => setError(errText(err)),
      },
    );
  };

  return (
    <ProfileDialogShell
      open
      title="新建档案"
      busy={create.isPending}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>
            取消
          </Button>
          <Button
            variant="solid"
            tone="accent"
            onClick={submit}
            loading={create.isPending}
            disabled={name.trim().length === 0}
          >
            创建
          </Button>
        </>
      }
    >
      <Field label="名称" required hint="小写字母 / 数字 / - / _">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如 work / sandbox"
          mono
          autoFocus
          disabled={create.isPending}
        />
      </Field>

      <Field label="克隆来源" hint="从某个档案复制配置、密钥、人格和技能；留空则新建空白档案。">
        <Select
          value={cloneFrom}
          onChange={(e) => setCloneFrom(e.target.value)}
          disabled={create.isPending}
        >
          <option value="">空白（之后再配置）</option>
          {profiles.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="描述（可选）">
        <Textarea
          className={s.descArea}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="一两句话说明这个档案的角色。"
          disabled={create.isPending}
        />
      </Field>

      <Field label="模型（可选）">
        <ProfileModelSelect
          value={modelKey}
          onChange={setModelKey}
          choices={choices}
          noneLabel={modelLoading ? "加载中…" : "默认（不单独设置）"}
          disabled={create.isPending}
        />
      </Field>

      <button
        type="button"
        className={s.advancedToggle}
        onClick={() => setShowAdvanced((v) => !v)}
      >
        {showAdvanced ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        高级选项
      </button>
      {showAdvanced && (
        <div className={s.checks}>
          <label>
            <input
              type="checkbox"
              checked={cloneAll}
              onChange={(e) => setCloneAll(e.target.checked)}
              disabled={!cloning || create.isPending}
            />
            <span>连同记忆和会话一并克隆（仅在选了克隆来源时生效）</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={noSkills}
              onChange={(e) => setNoSkills(e.target.checked)}
              disabled={cloning || create.isPending}
            />
            <span>不预置内置技能（克隆时由来源决定，此项失效）</span>
          </label>
        </div>
      )}

      {error && <div className={s.formError}>{error}</div>}
    </ProfileDialogShell>
  );
}

// ── 重命名档案 ───────────────────────────────────────────────
export function ProfileRenameDialog({
  profile: p,
  existingNames,
  onClose,
}: {
  profile: ProfileSummary;
  existingNames: string[];
  onClose: () => void;
}) {
  const rename = useRenameProfile();
  const [newName, setNewName] = useState(p.name);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    const trimmed = newName.trim();
    if (trimmed === p.name) {
      onClose();
      return;
    }
    if (!NAME_RE.test(trimmed)) {
      setError("只允许小写字母 / 数字 / - / _，以字母或数字开头，最长 64 字符");
      return;
    }
    if (existingNames.some((n) => n === trimmed)) {
      setError("已存在同名档案");
      return;
    }
    rename.mutate(
      { name: p.name, newName: trimmed },
      { onSuccess: onClose, onError: (err) => setError(errText(err)) },
    );
  };

  return (
    <ProfileDialogShell
      open
      title="重命名档案"
      titleSub={p.name}
      busy={rename.isPending}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={rename.isPending}>
            取消
          </Button>
          <Button
            variant="solid"
            tone="accent"
            onClick={submit}
            loading={rename.isPending}
            disabled={newName.trim().length === 0}
          >
            保存
          </Button>
        </>
      }
    >
      <Field label="新名称" hint="重命名会自动同步相关配置引用。">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          mono
          autoFocus
          disabled={rename.isPending}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
      </Field>
      {error && <div className={s.formError}>{error}</div>}
    </ProfileDialogShell>
  );
}

// ── 删除档案 ─────────────────────────────────────────────────
export function ProfileDeleteDialog({
  profile: p,
  onClose,
}: {
  profile: ProfileSummary;
  onClose: () => void;
}) {
  const del = useDeleteProfile();
  const [error, setError] = useState<string | null>(null);

  const confirm = () => {
    setError(null);
    del.mutate(p.name, {
      onSuccess: onClose,
      onError: (err) => setError(errText(err)),
    });
  };

  return (
    <ProfileDialogShell
      open
      title="删除档案"
      titleSub={p.name}
      busy={del.isPending}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={del.isPending}>
            取消
          </Button>
          <Button variant="solid" tone="danger" onClick={confirm} loading={del.isPending}>
            确认删除
          </Button>
        </>
      }
    >
      <p className={s.deleteWarn}>
        将<span className={s.deleteWarnStrong}>永久删除</span>档案 <code>{p.name}</code> 的整个目录
        —— 配置、密钥、人格、会话、技能、记忆等全部数据，<strong>无法恢复</strong>。
      </p>
      {p.gateway_running && (
        <p className={s.deleteWarn}>
          该档案的网关正在运行，删除时会一并停止。
        </p>
      )}
      {error && <div className={s.formError}>{error}</div>}
    </ProfileDialogShell>
  );
}
