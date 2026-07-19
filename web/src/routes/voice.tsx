import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, Loader2, Mic, Play, Save, Volume2 } from "lucide-react";
import type { ConfigSchemaResponse, ElevenLabsVoicesResponse, EnvVarInfo } from "@hermes/protocol";
import { useConfig, useConfigSchema, useSaveConfig } from "@/hooks/use-config";
import { useEnvVars, useSetEnv } from "@/hooks/use-env";
import { useMicRecorder } from "@/hooks/use-mic-recorder";
import {
  getElevenLabsVoices,
  speakText,
  transcribeAudioBlob,
  voiceErrorMessage,
} from "@/lib/voice";
import {
  VOICE_FIELD_LABELS,
  VOICE_FIELD_PLACEHOLDERS,
  VOICE_SELECT_OPTIONS,
  buildVoiceEnvUpdates,
  buildVoiceSaveConfig,
  envConfigured,
  getVoiceConfigValue,
  voiceProviderEnvKey,
  voiceProviderOptions,
  voiceSettingsDraftFromConfig,
  type VoiceProviderMeta,
  type VoiceSettingsDraft,
} from "@/lib/voice-config";
import { SectionShell } from "./section-shell";
import s from "./voice.module.css";

type FeedbackTone = "info" | "ok" | "error";

interface Feedback {
  tone: FeedbackTone;
  message: string;
}

interface VoiceSettingsViewProps {
  draft: VoiceSettingsDraft;
  schema: ConfigSchemaResponse;
  envVars?: Record<string, EnvVarInfo>;
  sttProviders: VoiceProviderMeta[];
  ttsProviders: VoiceProviderMeta[];
  elevenLabsVoices?: ElevenLabsVoicesResponse | null;
  saving?: boolean;
  sttTesting?: boolean;
  ttsTesting?: boolean;
  feedback?: Feedback | null;
  ttsSampleText?: string;
  onDraftChange?: (draft: VoiceSettingsDraft) => void;
  onSave?: () => void;
  onTestStt?: () => void;
  onTestTts?: () => void;
  onTtsSampleTextChange?: (value: string) => void;
}

function fieldValue(draft: VoiceSettingsDraft, key: string): string | boolean | number {
  return draft.values[key] ?? "";
}

function fieldOptions(key: string, elevenLabsVoices?: ElevenLabsVoicesResponse | null): string[] | undefined {
  if (key === "tts.elevenlabs.voice_id" && elevenLabsVoices?.available && elevenLabsVoices.voices.length > 0) {
    return elevenLabsVoices.voices.map((voice) => voice.voice_id);
  }
  return VOICE_SELECT_OPTIONS[key];
}

function fieldOptionLabel(key: string, value: string, elevenLabsVoices?: ElevenLabsVoicesResponse | null): string {
  if (key === "tts.elevenlabs.voice_id" && elevenLabsVoices?.voices.length) {
    return elevenLabsVoices.voices.find((voice) => voice.voice_id === value)?.label ?? value;
  }
  return value;
}

function selectedProvider(providers: VoiceProviderMeta[], id: string): VoiceProviderMeta | undefined {
  return providers.find((provider) => provider.id === id);
}

function EnvBadge({ envVars, envKey }: { envVars?: Record<string, EnvVarInfo>; envKey?: string }) {
  if (!envKey) return <span className={s.badge} data-tone="ok">无需密钥</span>;
  const configured = envConfigured(envVars, envKey);
  const label = configured ? `${envKey} 已配置` : `需要 ${envKey}`;
  return <span className={s.badge} data-tone={configured ? "ok" : "warn"} title={label}>{label}</span>;
}

function ProviderPicker({
  kind,
  value,
  providers,
  envVars,
  onChange,
}: {
  kind: "stt" | "tts";
  value: string;
  providers: VoiceProviderMeta[];
  envVars?: Record<string, EnvVarInfo>;
  onChange?: (provider: string) => void;
}) {
  return (
    <div className={s.providerGrid} data-kind={kind}>
      {providers.map((provider) => (
        <button
          key={provider.id}
          type="button"
          className={s.providerCard}
          data-active={provider.id === value ? "true" : undefined}
          data-unsupported={provider.unsupported ? "true" : undefined}
          onClick={() => onChange?.(provider.id)}
        >
          <span className={s.providerName}>
            <span>{provider.label}</span>
            <EnvBadge envVars={envVars} envKey={provider.envKey} />
          </span>
          <p>{provider.description}</p>
        </button>
      ))}
    </div>
  );
}

function ProviderFields({
  provider,
  draft,
  schema,
  elevenLabsVoices,
  onDraftChange,
}: {
  provider?: VoiceProviderMeta;
  draft: VoiceSettingsDraft;
  schema: ConfigSchemaResponse;
  elevenLabsVoices?: ElevenLabsVoicesResponse | null;
  onDraftChange?: (draft: VoiceSettingsDraft) => void;
}) {
  if (!provider || provider.configKeys.length === 0) return null;

  const updateValue = (key: string, value: string | boolean | number) => {
    onDraftChange?.({
      ...draft,
      values: { ...draft.values, [key]: value },
    });
  };

  return (
    <div className={s.formGrid}>
      {provider.configKeys.map((key) => {
        const field = schema.fields[key];
        const value = fieldValue(draft, key);
        const options = fieldOptions(key, elevenLabsVoices);
        const label = VOICE_FIELD_LABELS[key] ?? key;
        if (field?.type === "boolean") {
          return (
            <div key={key} className={s.switchRow}>
              <span className={s.switchText}>
                <strong>{label}</strong>
                <span>{key}</span>
              </span>
              <button
                type="button"
                className={s.toggle}
                data-on={Boolean(value) ? "true" : undefined}
                aria-label={label}
                onClick={() => updateValue(key, !Boolean(value))}
              />
            </div>
          );
        }
        return (
          <div key={key} className={s.field}>
            <label htmlFor={`voice-field-${key}`}>{label}</label>
            {options ? (
              <select
                id={`voice-field-${key}`}
                className={s.select}
                value={String(value ?? "")}
                onChange={(event) => updateValue(key, event.target.value)}
              >
                <option value="">使用 runtime 默认值</option>
                {options.map((option) => (
                  <option key={option} value={option}>{fieldOptionLabel(key, option, elevenLabsVoices)}</option>
                ))}
              </select>
            ) : (
              <input
                id={`voice-field-${key}`}
                className={s.input}
                value={String(value ?? "")}
                placeholder={VOICE_FIELD_PLACEHOLDERS[key] ?? "使用 runtime 默认值"}
                onChange={(event) => {
                  const nextValue = field?.type === "number" && event.target.value.trim()
                    ? Number(event.target.value)
                    : event.target.value;
                  updateValue(key, nextValue);
                }}
              />
            )}
            <span className={s.fieldHint}>{key}</span>
          </div>
        );
      })}
    </div>
  );
}

export function VoiceSettingsView({
  draft,
  schema,
  envVars,
  sttProviders,
  ttsProviders,
  elevenLabsVoices,
  saving = false,
  sttTesting = false,
  ttsTesting = false,
  feedback = null,
  ttsSampleText = "你好，我是 Hermes。语音合成配置已经可以使用。",
  onDraftChange,
  onSave,
  onTestStt,
  onTestTts,
  onTtsSampleTextChange,
}: VoiceSettingsViewProps) {
  const sttProvider = selectedProvider(sttProviders, draft.sttProvider);
  const ttsProvider = selectedProvider(ttsProviders, draft.ttsProvider);
  const sttEnvKey = voiceProviderEnvKey("stt", draft.sttProvider);
  const ttsEnvKey = voiceProviderEnvKey("tts", draft.ttsProvider);

  return (
    <div className={s.page}>
      <section className={s.hero}>
        <div>
          <h2>语音模型配置</h2>
          <p>在这里配置 Composer 语音转文字和助手回复朗读。API Key 会写入当前档案的 .env，模型与开关写入 config.yaml。</p>
        </div>
        <div className={s.heroActions}>
          <button type="button" className={s.primaryButton} onClick={onSave} disabled={saving}>
            {saving ? <Loader2 size={14} /> : <Save size={14} />}
            {saving ? "保存中…" : "保存配置"}
          </button>
        </div>
      </section>

      <div className={s.grid}>
        <section className={s.card}>
          <div className={s.cardHead}>
            <div>
              <div className={s.cardTitle}>
                <Mic size={16} />
                <h3>语音识别 STT</h3>
              </div>
              <p className={s.cardDesc}>选择录音转写提供方。当前 Composer 麦克风按钮会使用这里的配置。</p>
            </div>
            <EnvBadge envVars={envVars} envKey={sttEnvKey} />
          </div>

          <ProviderPicker
            kind="stt"
            value={draft.sttProvider}
            providers={sttProviders}
            envVars={envVars}
            onChange={(provider) => onDraftChange?.({ ...draft, sttProvider: provider })}
          />

          {sttEnvKey ? (
            <div className={s.field}>
              <label htmlFor="voice-stt-api-key">API Key</label>
              <input
                id="voice-stt-api-key"
                className={s.input}
                type="password"
                value={draft.sttApiKey}
                placeholder={envConfigured(envVars, sttEnvKey) ? `已配置 ${sttEnvKey}，留空则保留` : `填写 ${sttEnvKey}`}
                onChange={(event) => onDraftChange?.({ ...draft, sttApiKey: event.target.value })}
              />
              <span className={s.fieldHint}><KeyRound size={12} /> {sttEnvKey}</span>
            </div>
          ) : null}

          <ProviderFields
            provider={sttProvider}
            draft={draft}
            schema={schema}
            onDraftChange={onDraftChange}
          />

          <div className={s.cardActions}>
            <button type="button" className={s.button} onClick={onTestStt} disabled={sttTesting || !draft.sttEnabled}>
              {sttTesting ? <Loader2 size={14} /> : <Mic size={14} />}
              {sttTesting ? "录音测试中…" : "测试识别"}
            </button>
          </div>
        </section>

        <section className={s.card}>
          <div className={s.cardHead}>
            <div>
              <div className={s.cardTitle}>
                <Volume2 size={16} />
                <h3>回复朗读 TTS</h3>
              </div>
              <p className={s.cardDesc}>选择助手回复朗读提供方。消息里的“朗读”按钮会使用这里的配置。</p>
            </div>
            <EnvBadge envVars={envVars} envKey={ttsEnvKey} />
          </div>

          <ProviderPicker
            kind="tts"
            value={draft.ttsProvider}
            providers={ttsProviders}
            envVars={envVars}
            onChange={(provider) => onDraftChange?.({ ...draft, ttsProvider: provider })}
          />

          {ttsEnvKey ? (
            <div className={s.field}>
              <label htmlFor="voice-tts-api-key">API Key</label>
              <input
                id="voice-tts-api-key"
                className={s.input}
                type="password"
                value={draft.ttsApiKey}
                placeholder={envConfigured(envVars, ttsEnvKey) ? `已配置 ${ttsEnvKey}，留空则保留` : `填写 ${ttsEnvKey}`}
                onChange={(event) => onDraftChange?.({ ...draft, ttsApiKey: event.target.value })}
              />
              <span className={s.fieldHint}><KeyRound size={12} /> {ttsEnvKey}</span>
            </div>
          ) : null}

          <ProviderFields
            provider={ttsProvider}
            draft={draft}
            schema={schema}
            elevenLabsVoices={elevenLabsVoices}
            onDraftChange={onDraftChange}
          />

          {ttsProvider?.notice ? (
            <p className={s.providerNotice}>{ttsProvider.notice}</p>
          ) : null}

          <div className={s.field}>
            <label htmlFor="voice-tts-sample">朗读测试文本</label>
            <textarea
              id="voice-tts-sample"
              className={s.textarea}
              value={ttsSampleText}
              onChange={(event) => onTtsSampleTextChange?.(event.target.value)}
            />
          </div>
          <div className={s.cardActions}>
            <button type="button" className={s.button} onClick={onTestTts} disabled={ttsTesting}>
              {ttsTesting ? <Loader2 size={14} /> : <Play size={14} />}
              {ttsTesting ? "朗读测试中…" : "测试朗读"}
            </button>
          </div>
        </section>

        <section className={s.card} data-wide="true">
          <div className={s.cardHead}>
            <div>
              <div className={s.cardTitle}>
                <CheckCircle2 size={16} />
                <h3>体验设置</h3>
              </div>
              <p className={s.cardDesc}>这些设置会影响 Composer 录音体验和新完成助手回复的自动朗读行为。</p>
            </div>
          </div>

          <div className={s.switchRow}>
            <span className={s.switchText}>
              <strong>启用语音识别</strong>
              <span>关闭后 Composer 麦克风按钮不可用。</span>
            </span>
            <button
              type="button"
              className={s.toggle}
              data-on={draft.sttEnabled ? "true" : undefined}
              aria-label="启用语音识别"
              onClick={() => onDraftChange?.({ ...draft, sttEnabled: !draft.sttEnabled })}
            />
          </div>
          <div className={s.switchRow}>
            <span className={s.switchText}>
              <strong>自动朗读助手回复</strong>
              <span>只朗读新完成的助手消息，不会朗读历史消息。</span>
            </span>
            <button
              type="button"
              className={s.toggle}
              data-on={draft.autoTts ? "true" : undefined}
              aria-label="自动朗读助手回复"
              onClick={() => onDraftChange?.({ ...draft, autoTts: !draft.autoTts })}
            />
          </div>
          <div className={s.switchRow}>
            <span className={s.switchText}>
              <strong>最长录音时长</strong>
              <span>到达上限后自动停止并开始转写。</span>
            </span>
            <input
              className={s.input}
              type="number"
              min={1}
              max={600}
              value={draft.maxRecordingSeconds}
              onChange={(event) => onDraftChange?.({ ...draft, maxRecordingSeconds: Number(event.target.value) })}
              aria-label="最长录音时长"
              style={{ width: 120 }}
            />
          </div>
        </section>
      </div>

      {feedback ? (
        <div className={s.feedback} data-tone={feedback.tone === "info" ? undefined : feedback.tone}>
          {feedback.message}
        </div>
      ) : null}
    </div>
  );
}

export function VoiceRoute() {
  const { data: config, isLoading: configLoading } = useConfig();
  const { data: schema, isLoading: schemaLoading } = useConfigSchema();
  const { data: envVars } = useEnvVars();
  const saveConfig = useSaveConfig();
  const setEnv = useSetEnv();
  const { handle: micRecorder } = useMicRecorder();
  const [draft, setDraft] = useState<VoiceSettingsDraft | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [sttTesting, setSttTesting] = useState(false);
  const [ttsTesting, setTtsTesting] = useState(false);
  const [ttsSampleText, setTtsSampleText] = useState("你好，我是 Hermes。语音合成配置已经可以使用。");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (config) setDraft(voiceSettingsDraftFromConfig(config));
  }, [config]);

  const elevenLabsVoices = useQuery({
    queryKey: ["audio-elevenlabs-voices", draft?.ttsProvider],
    queryFn: getElevenLabsVoices,
    enabled: draft?.ttsProvider === "elevenlabs",
    retry: false,
  });

  const sttProviders = useMemo(
    () => draft && schema ? voiceProviderOptions("stt", schema, draft.sttProvider) : [],
    [draft, schema],
  );
  const ttsProviders = useMemo(
    () => draft && schema ? voiceProviderOptions("tts", schema, draft.ttsProvider) : [],
    [draft, schema],
  );

  const save = async () => {
    if (!config || !draft) return;
    setFeedback(null);
    try {
      await saveConfig.mutateAsync(buildVoiceSaveConfig(config, draft));
      for (const update of buildVoiceEnvUpdates(draft)) {
        await setEnv.mutateAsync(update);
      }
      setDraft((current) => current ? { ...current, sttApiKey: "", ttsApiKey: "" } : current);
      setFeedback({ tone: "ok", message: "语音配置已保存。API Key 已写入当前档案的 .env，语音模型设置已写入 config.yaml。" });
    } catch (error) {
      setFeedback({ tone: "error", message: voiceErrorMessage(error, "保存语音配置失败") });
    }
  };

  const testStt = async () => {
    if (!draft) return;
    setSttTesting(true);
    setFeedback({ tone: "info", message: `请开始说话，录音将在 ${Math.max(1, Math.trunc(draft.maxRecordingSeconds || 120))} 秒内自动停止。` });
    try {
      await micRecorder.start();
      await new Promise((resolve) => window.setTimeout(resolve, Math.min(5, Math.max(1, draft.maxRecordingSeconds)) * 1000));
      const recording = await micRecorder.stop();
      if (!recording?.audio) throw new Error("录音为空，请重新测试。");
      const result = await transcribeAudioBlob(recording.audio);
      setFeedback({
        tone: "ok",
        message: result.transcript
          ? `识别成功：${result.transcript}`
          : "识别请求完成，但没有返回文字。请确认语音内容清晰或切换识别提供方。",
      });
    } catch (error) {
      micRecorder.cancel();
      setFeedback({ tone: "error", message: voiceErrorMessage(error, "语音识别测试失败") });
    } finally {
      setSttTesting(false);
    }
  };

  const testTts = async () => {
    const text = ttsSampleText.trim();
    if (!text) {
      setFeedback({ tone: "error", message: "请先填写朗读测试文本。" });
      return;
    }
    setTtsTesting(true);
    setFeedback(null);
    try {
      audioRef.current?.pause();
      const result = await speakText(text);
      const audio = new Audio(result.data_url);
      audioRef.current = audio;
      await audio.play();
      setFeedback({ tone: "ok", message: "朗读测试已开始播放。" });
    } catch (error) {
      setFeedback({ tone: "error", message: voiceErrorMessage(error, "朗读测试失败") });
    } finally {
      setTtsTesting(false);
    }
  };

  if (configLoading || schemaLoading || !config || !schema || !draft) {
    return (
      <SectionShell title="语音" sub="配置语音转文字和回复朗读。">
        <div className={s.feedback}>正在加载语音配置…</div>
      </SectionShell>
    );
  }

  const existingStt = getVoiceConfigValue(config, "stt.provider");
  const existingTts = getVoiceConfigValue(config, "tts.provider");
  const sub = `当前 STT：${typeof existingStt === "string" ? existingStt : "local"} · 当前 TTS：${typeof existingTts === "string" ? existingTts : "edge"}`;

  return (
    <SectionShell title="语音" sub={sub}>
      <VoiceSettingsView
        draft={draft}
        schema={schema}
        envVars={envVars}
        sttProviders={sttProviders}
        ttsProviders={ttsProviders}
        elevenLabsVoices={elevenLabsVoices.data ?? null}
        saving={saveConfig.isPending || setEnv.isPending}
        sttTesting={sttTesting}
        ttsTesting={ttsTesting}
        feedback={feedback}
        ttsSampleText={ttsSampleText}
        onDraftChange={setDraft}
        onSave={() => void save()}
        onTestStt={() => void testStt()}
        onTestTts={() => void testTts()}
        onTtsSampleTextChange={setTtsSampleText}
      />
    </SectionShell>
  );
}
