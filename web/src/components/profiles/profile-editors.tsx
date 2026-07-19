import { useEffect, useState } from "react";
import { Button, Field, Textarea } from "@hermes/shared-ui";
import { Sparkles } from "lucide-react";
import type { ProfileSummary } from "@hermes/protocol";
import {
  useDescribeProfileAuto,
  useProfileSoul,
  useSetProfileModel,
  useUpdateProfileDescription,
  useUpdateProfileSoul,
} from "@/hooks/use-profiles";
import { ProfileDialogShell } from "./profile-dialog-shell";
import {
  modelChoiceKey,
  parseModelChoiceKey,
  ProfileModelSelect,
  useModelChoices,
} from "./profile-model-select";
import s from "./profiles.module.css";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : "操作失败";
}

// ── 改模型 ───────────────────────────────────────────────────
export function ProfileModelDialog({
  profile: p,
  onClose,
}: {
  profile: ProfileSummary;
  onClose: () => void;
}) {
  const { choices, loading } = useModelChoices();
  const setModel = useSetProfileModel();
  const currentKey = p.provider && p.model ? modelChoiceKey(p.provider, p.model) : "";
  const [sel, setSel] = useState(currentKey);

  // choices 异步到达后，若用户还没选且当前模型在列表里，预选它。
  useEffect(() => {
    if (!sel && currentKey && choices.some((c) => c.key === currentKey)) {
      setSel(currentKey);
    }
  }, [choices, currentKey, sel]);

  const parsed = parseModelChoiceKey(sel);
  const save = () => {
    if (!parsed) return;
    setModel.mutate(
      { name: p.name, provider: parsed.provider, model: parsed.model },
      { onSuccess: onClose },
    );
  };

  const noChoices = !loading && choices.length === 0;

  return (
    <ProfileDialogShell
      open
      title="改模型"
      titleSub={p.name}
      busy={setModel.isPending}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={setModel.isPending}>
            取消
          </Button>
          <Button
            variant="solid"
            tone="accent"
            onClick={save}
            loading={setModel.isPending}
            disabled={!parsed}
          >
            保存
          </Button>
        </>
      }
    >
      {noChoices ? (
        <p className={s.modelEmpty}>
          还没有已授权的服务商 —— 先在 <code>/models</code> 配置一个 API Key 再来选模型。
        </p>
      ) : (
        <Field label="模型" hint="选择服务商和模型，应用到这个档案。">
          <ProfileModelSelect
            value={sel}
            onChange={setSel}
            choices={choices}
            noneLabel={loading ? "加载中…" : "选择模型"}
            disabled={loading || setModel.isPending}
          />
        </Field>
      )}
      {setModel.isError && <div className={s.formError}>{errText(setModel.error)}</div>}
    </ProfileDialogShell>
  );
}

// ── 改描述（含 AI 自动生成）─────────────────────────────────────
export function ProfileDescriptionDialog({
  profile: p,
  onClose,
}: {
  profile: ProfileSummary;
  onClose: () => void;
}) {
  const update = useUpdateProfileDescription();
  const describe = useDescribeProfileAuto();
  const [text, setText] = useState(p.description ?? "");
  const [genReason, setGenReason] = useState<string | null>(null);

  const busy = update.isPending || describe.isPending;

  const save = () =>
    update.mutate({ name: p.name, description: text.trim() }, { onSuccess: onClose });

  const autoGen = () => {
    setGenReason(null);
    describe.mutate(
      { name: p.name, overwrite: true },
      {
        onSuccess: (r) => {
          if (r.ok && r.description) setText(r.description);
          else setGenReason(r.reason || "自动生成失败");
        },
      },
    );
  };

  return (
    <ProfileDialogShell
      open
      title="改描述"
      titleSub={p.name}
      busy={busy}
      onClose={onClose}
      footerSpread
      footer={
        <>
          <Button
            variant="soft"
            leadingIcon={<Sparkles size={13} />}
            onClick={autoGen}
            loading={describe.isPending}
            disabled={busy}
          >
            AI 自动生成
          </Button>
          <span style={{ display: "inline-flex", gap: 8 }}>
            <Button variant="outline" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button variant="solid" tone="accent" onClick={save} loading={update.isPending}>
              保存
            </Button>
          </span>
        </>
      }
    >
      <Field
        label="描述"
        hint="一两句话说明这个档案的角色（用于看板分派和选择档案）。手动填写后，不会再被自动生成覆盖。"
      >
        <Textarea
          className={s.descArea}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="例如：专注前端的全栈开发档案，负责代码生成与调试。"
          disabled={busy}
          autoFocus
        />
      </Field>
      {genReason && <div className={s.descGenReason}>自动生成未成功：{genReason}</div>}
      {update.isError && <div className={s.formError}>{errText(update.error)}</div>}
      {describe.isError && <div className={s.formError}>{errText(describe.error)}</div>}
    </ProfileDialogShell>
  );
}

// ── 编辑 SOUL.md ─────────────────────────────────────────────
export function ProfileSoulDialog({
  profile: p,
  onClose,
}: {
  profile: ProfileSummary;
  onClose: () => void;
}) {
  const soul = useProfileSoul(p.name);
  const update = useUpdateProfileSoul();
  const [content, setContent] = useState<string | null>(null);

  // 内容到达后灌入一次；之后由用户编辑，不再被 refetch 覆盖。
  useEffect(() => {
    if (content === null && soul.data) setContent(soul.data.content);
  }, [soul.data, content]);

  const save = () => {
    if (content === null) return;
    update.mutate({ name: p.name, content }, { onSuccess: onClose });
  };

  const loading = soul.isLoading && content === null;

  return (
    <ProfileDialogShell
      open
      title="编辑 SOUL.md"
      titleSub={p.name}
      busy={update.isPending}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={update.isPending}>
            取消
          </Button>
          <Button
            variant="solid"
            tone="accent"
            onClick={save}
            loading={update.isPending}
            disabled={loading || content === null}
          >
            保存
          </Button>
        </>
      }
    >
      {loading ? (
        <p className={s.modelEmpty}>加载中…</p>
      ) : (
        <Field
          label="SOUL.md"
          hint={
            soul.data && !soul.data.exists
              ? "该档案尚未创建 SOUL.md，保存后将新建。"
              : "档案的首要身份 / 系统提示。"
          }
        >
          <Textarea
            className={s.soulArea}
            value={content ?? ""}
            onChange={(e) => setContent(e.target.value)}
            disabled={update.isPending}
            spellCheck={false}
            autoFocus
          />
        </Field>
      )}
      {soul.isError && <div className={s.formError}>无法读取 SOUL.md：{errText(soul.error)}</div>}
      {update.isError && <div className={s.formError}>{errText(update.error)}</div>}
    </ProfileDialogShell>
  );
}
