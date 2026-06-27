import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, Button, Field, Input, Textarea } from "@hermes/shared-ui";
import { ArrowLeft, ArrowRight, Plus, Search, X } from "lucide-react";
import type { McpServerCreate, SkillHubResult } from "@hermes/protocol";
import { useCreateProfile, useProfiles } from "@/hooks/use-profiles";
import { useSkills, useSkillsHubSearch } from "@/hooks/use-skills";
import {
  parseModelChoiceKey,
  ProfileModelSelect,
  useModelChoices,
} from "@/components/profiles/profile-model-select";
import { SectionShell } from "./section-shell";
import s from "@/components/profiles/profile-builder.module.css";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const STEPS = [
  { id: "identity", label: "身份" },
  { id: "model", label: "模型" },
  { id: "skills", label: "技能" },
  { id: "mcp", label: "MCP" },
  { id: "review", label: "预览" },
] as const;
type StepId = (typeof STEPS)[number]["id"];

export function ProfileBuilderRoute() {
  const navigate = useNavigate();
  const profilesQuery = useProfiles();
  const create = useCreateProfile();
  const { choices, loading: modelLoading } = useModelChoices();
  const skillsQuery = useSkills();
  const hubSearch = useSkillsHubSearch();

  const [step, setStep] = useState<StepId>("identity");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [modelKey, setModelKey] = useState("");

  const [keepAll, setKeepAll] = useState(true);
  const [keptSkills, setKeptSkills] = useState<Set<string>>(new Set());
  const [skillFilter, setSkillFilter] = useState("");

  const [hubQuery, setHubQuery] = useState("");
  const [hubResults, setHubResults] = useState<SkillHubResult[]>([]);
  const [hubSkills, setHubSkills] = useState<SkillHubResult[]>([]);

  const [mcpServers, setMcpServers] = useState<McpServerCreate[]>([]);
  const [mcpDraft, setMcpDraft] = useState({ name: "", url: "", command: "", args: "" });

  const [error, setError] = useState<string | null>(null);

  const skills = skillsQuery.data ?? [];
  const nameTrimmed = name.trim();
  const nameValid = NAME_RE.test(nameTrimmed);
  const duplicate = (profilesQuery.data ?? []).some((p) => p.name === nameTrimmed);
  const picked = parseModelChoiceKey(modelKey);

  // 技能列表到达后，默认勾选当前所有启用的技能（REPLACE 语义的初值）。
  useEffect(() => {
    if (skillsQuery.data && keptSkills.size === 0) {
      setKeptSkills(new Set(skillsQuery.data.filter((sk) => sk.enabled).map((sk) => sk.name)));
    }
  }, [skillsQuery.data, keptSkills.size]);

  const filteredSkills = useMemo(() => {
    const f = skillFilter.trim().toLowerCase();
    if (!f) return skills;
    return skills.filter(
      (sk) =>
        sk.name.toLowerCase().includes(f) ||
        (sk.description || "").toLowerCase().includes(f) ||
        (sk.category || "").toLowerCase().includes(f),
    );
  }, [skills, skillFilter]);

  const toggleKept = (skillName: string) => {
    setKeptSkills((prev) => {
      const next = new Set(prev);
      if (next.has(skillName)) next.delete(skillName);
      else next.add(skillName);
      return next;
    });
  };

  const runHubSearch = () => {
    const q = hubQuery.trim();
    if (!q) return;
    hubSearch.mutate({ q }, { onSuccess: (r) => setHubResults(r.results) });
  };

  const addHubSkill = (sk: SkillHubResult) => {
    setHubSkills((prev) =>
      prev.some((h) => h.identifier === sk.identifier) ? prev : [...prev, sk],
    );
  };
  const removeHubSkill = (identifier: string) =>
    setHubSkills((prev) => prev.filter((h) => h.identifier !== identifier));

  const addMcpDraft = () => {
    const n = mcpDraft.name.trim();
    if (!n) {
      setError("MCP server 需要一个名字");
      return;
    }
    if (!mcpDraft.url.trim() && !mcpDraft.command.trim()) {
      setError("给 MCP server 一个 URL 或 command");
      return;
    }
    setError(null);
    const entry: McpServerCreate = { name: n };
    if (mcpDraft.url.trim()) entry.url = mcpDraft.url.trim();
    if (mcpDraft.command.trim()) {
      entry.command = mcpDraft.command.trim();
      const args = mcpDraft.args.trim();
      if (args) entry.args = args.split(/\s+/);
    }
    setMcpServers((prev) => [...prev.filter((srv) => srv.name !== n), entry]);
    setMcpDraft({ name: "", url: "", command: "", args: "" });
  };

  const submit = () => {
    setError(null);
    if (!nameValid) {
      setStep("identity");
      setError("名称只允许小写字母 / 数字 / - / _，以字母或数字开头，最长 64 字符");
      return;
    }
    if (duplicate) {
      setStep("identity");
      setError("已存在同名档案");
      return;
    }
    create.mutate(
      {
        name: nameTrimmed,
        description: description.trim() || undefined,
        provider: picked?.provider,
        model: picked?.model,
        mcp_servers: mcpServers.length ? mcpServers : undefined,
        keep_skills: keepAll ? undefined : Array.from(keptSkills),
        hub_skills: hubSkills.length ? hubSkills.map((h) => h.identifier) : undefined,
      },
      {
        onSuccess: () => navigate("/profiles"),
        onError: (err) => setError(err instanceof Error ? err.message : "创建失败"),
      },
    );
  };

  const stepIndex = STEPS.findIndex((st) => st.id === step);
  const goNext = () => {
    if (step === "identity" && (!nameValid || duplicate)) {
      setError(
        duplicate
          ? "已存在同名档案"
          : "名称只允许小写字母 / 数字 / - / _，以字母或数字开头，最长 64 字符",
      );
      return;
    }
    setError(null);
    const next = STEPS[Math.min(stepIndex + 1, STEPS.length - 1)];
    setStep(next.id);
  };
  const goBack = () => {
    setError(null);
    setStep(STEPS[Math.max(stepIndex - 1, 0)].id);
  };

  const modelLabel = picked
    ? choices.find((c) => c.key === modelKey)?.label ?? `${picked.provider} · ${picked.model}`
    : "默认（稍后再设）";

  return (
    <SectionShell
      title="新建档案"
      sub="分步创建"
      right={
        <Button variant="outline" size="sm" leadingIcon={<ArrowLeft size={14} />} onClick={() => navigate("/profiles")}>
          返回档案
        </Button>
      }
    >
      <div className={s.wrap}>
        <div className={s.stepper}>
          {STEPS.map((st, i) => (
            <span key={st.id} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {i > 0 && <span className={s.stepSep} />}
              <button
                type="button"
                className={s.stepBtn}
                data-active={st.id === step ? "true" : undefined}
                disabled={i > 0 && !nameValid}
                onClick={() => setStep(st.id)}
              >
                <span className={s.stepNum}>{i + 1}</span>
                {st.label}
              </button>
            </span>
          ))}
        </div>

        {step === "identity" && (
          <div className={s.panel}>
            <Field label="名称" required hint="小写字母 / 数字 / - / _">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如 work / sandbox"
                mono
                autoFocus
                invalid={Boolean(name) && (!nameValid || duplicate)}
              />
            </Field>
            <Field label="描述（可选）">
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="一两句话说明这个档案的角色。"
                style={{ minHeight: 80 }}
              />
            </Field>
          </div>
        )}

        {step === "model" && (
          <div className={s.panel}>
            <p className={s.panelHint}>给这个档案选 provider · model；留空用默认，稍后再设。</p>
            <Field label="模型">
              <ProfileModelSelect
                value={modelKey}
                onChange={setModelKey}
                choices={choices}
                noneLabel={modelLoading ? "加载中…" : "默认（稍后再设）"}
              />
            </Field>
          </div>
        )}

        {step === "skills" && (
          <div className={s.panel}>
            <label className={s.skillRow} style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={keepAll} onChange={(e) => setKeepAll(e.target.checked)} />
              <span className={s.skillMain}>
                <span className={s.skillName}>从完整默认技能包开始（推荐）</span>
                <span className={s.skillDesc}>取消勾选可只保留下方选中的技能（其余在新档案里禁用）。</span>
              </span>
            </label>

            {!keepAll && (
              <>
                <Input
                  value={skillFilter}
                  onChange={(e) => setSkillFilter(e.target.value)}
                  placeholder="过滤技能（名称 / 描述 / 分类）"
                  controlSize="sm"
                />
                <div className={s.list}>
                  {skillsQuery.isLoading ? (
                    <div className={s.emptyHint}>加载中…</div>
                  ) : filteredSkills.length === 0 ? (
                    <div className={s.emptyHint}>没有匹配的技能</div>
                  ) : (
                    filteredSkills.map((sk) => (
                      <label key={sk.name} className={s.skillRow}>
                        <input
                          type="checkbox"
                          checked={keptSkills.has(sk.name)}
                          onChange={() => toggleKept(sk.name)}
                        />
                        <span className={s.skillMain}>
                          <span className={s.skillName}>
                            {sk.name}
                            {sk.category && (
                              <Badge variant="outline" size="sm">
                                {sk.category}
                              </Badge>
                            )}
                          </span>
                          {sk.description && <span className={s.skillDesc}>{sk.description}</span>}
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </>
            )}

            <Field label="从技能 hub 添加" hint="搜索后台安装的 hub 技能（如 linear、hyperliquid）。">
              <div className={s.searchRow}>
                <Input
                  value={hubQuery}
                  onChange={(e) => setHubQuery(e.target.value)}
                  placeholder="搜索 hub…"
                  controlSize="sm"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      runHubSearch();
                    }
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  leadingIcon={<Search size={13} />}
                  onClick={runHubSearch}
                  loading={hubSearch.isPending}
                >
                  搜索
                </Button>
              </div>
            </Field>
            {hubResults.length > 0 && (
              <div className={s.list}>
                {hubResults.map((r) => (
                  <div key={r.identifier} className={s.hubResult}>
                    <span className={s.skillMain}>
                      <span className={s.skillName}>
                        {r.name}
                        <Badge variant="outline" size="sm">
                          {r.source}
                        </Badge>
                      </span>
                      {r.description && <span className={s.skillDesc}>{r.description}</span>}
                    </span>
                    <Button variant="soft" size="xs" onClick={() => addHubSkill(r)}>
                      添加
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {hubSkills.length > 0 && (
              <div className={s.chips}>
                {hubSkills.map((h) => (
                  <span key={h.identifier} className={s.chip}>
                    {h.name}
                    <button
                      type="button"
                      className={s.chipRemove}
                      onClick={() => removeHubSkill(h.identifier)}
                      aria-label={`移除 ${h.name}`}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {step === "mcp" && (
          <div className={s.panel}>
            <p className={s.panelHint}>给这个档案加 MCP server。HTTP 用 URL；stdio 用 command + args。可留空跳过。</p>
            <div className={s.mcpGrid}>
              <Field label="名称">
                <Input
                  value={mcpDraft.name}
                  onChange={(e) => setMcpDraft((d) => ({ ...d, name: e.target.value }))}
                  controlSize="sm"
                />
              </Field>
              <Field label="URL（HTTP）">
                <Input
                  value={mcpDraft.url}
                  onChange={(e) => setMcpDraft((d) => ({ ...d, url: e.target.value }))}
                  controlSize="sm"
                  mono
                />
              </Field>
              <Field label="command（stdio）">
                <Input
                  value={mcpDraft.command}
                  onChange={(e) => setMcpDraft((d) => ({ ...d, command: e.target.value }))}
                  controlSize="sm"
                  mono
                />
              </Field>
              <Field label="args（空格分隔）">
                <Input
                  value={mcpDraft.args}
                  onChange={(e) => setMcpDraft((d) => ({ ...d, args: e.target.value }))}
                  controlSize="sm"
                  mono
                />
              </Field>
            </div>
            <div>
              <Button variant="outline" size="sm" leadingIcon={<Plus size={13} />} onClick={addMcpDraft}>
                添加 server
              </Button>
            </div>
            {mcpServers.length > 0 && (
              <div className={s.mcpList}>
                {mcpServers.map((srv) => (
                  <div key={srv.name} className={s.mcpItem}>
                    <span className={s.mcpItemMain}>
                      <span className={s.mcpItemName}>{srv.name}</span>{" "}
                      <span className={s.mcpItemMeta}>
                        {srv.url ?? `${srv.command ?? ""} ${(srv.args ?? []).join(" ")}`.trim()}
                      </span>
                    </span>
                    <button
                      type="button"
                      className={s.chipRemove}
                      onClick={() => setMcpServers((prev) => prev.filter((p) => p.name !== srv.name))}
                      aria-label={`移除 ${srv.name}`}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {step === "review" && (
          <div className={s.panel}>
            <ReviewRow label="名称" value={nameTrimmed || "—"} />
            <ReviewRow label="描述" value={description.trim() || "—"} />
            <ReviewRow label="模型" value={modelLabel} />
            <ReviewRow
              label="技能"
              value={
                keepAll
                  ? "完整默认技能包"
                  : `保留 ${keptSkills.size} 个内置/可选技能`
              }
            />
            {hubSkills.length > 0 && (
              <ReviewRow label="hub 技能" value={hubSkills.map((h) => h.name).join("、")} />
            )}
            <ReviewRow
              label="MCP"
              value={mcpServers.length ? mcpServers.map((m) => m.name).join("、") : "无"}
            />
          </div>
        )}

        {error && <div className={s.formError}>{error}</div>}

        <div className={s.nav}>
          <Button
            variant="outline"
            leadingIcon={<ArrowLeft size={14} />}
            onClick={goBack}
            disabled={stepIndex === 0 || create.isPending}
          >
            上一步
          </Button>
          <div className={s.navRight}>
            {step === "review" ? (
              <Button
                variant="solid"
                tone="accent"
                onClick={submit}
                loading={create.isPending}
                disabled={!nameValid || duplicate}
              >
                创建档案
              </Button>
            ) : (
              <Button
                variant="solid"
                tone="accent"
                trailingIcon={<ArrowRight size={14} />}
                onClick={goNext}
              >
                下一步
              </Button>
            )}
          </div>
        </div>
      </div>
    </SectionShell>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={s.reviewRow}>
      <span className={s.reviewLabel}>{label}</span>
      <span className={s.reviewValue}>{value}</span>
    </div>
  );
}
