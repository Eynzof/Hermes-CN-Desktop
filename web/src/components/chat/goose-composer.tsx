import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { useAtomValue } from "jotai";
import { useNavigate } from "react-router-dom";
import {
  AtSign,
  Cpu,
  FileText,
  GitBranch,
  Globe,
  Folder,
  Loader2,
  MessageSquare,
  Mic,
  Plus,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import type { ModelOptionsResult } from "@hermes/protocol";
import { fileNameFromPath } from "@/lib/composer-prompt";
import {
  buildSkillCommandText,
  extractBodyAfterLeadingSlashToken,
  filterComposerSkills,
  getLeadingSlashToken,
  getSkillNamespaceToken,
  replaceLeadingSlashToken,
  type ComposerSkillCandidate,
} from "@/lib/composer-skills";
import {
  filterComposerCommands,
  isBuiltinComposerCommandToken,
  type ComposerCommandCandidate,
} from "@/lib/builtin-commands";
import {
  buildMentionReplacement,
  getActiveMentionToken,
  getMentionCandidates,
  type MentionCandidate,
  type MentionKind,
} from "@/lib/composer-mentions";
import { contextUsageRisk } from "@/lib/context-usage";
import {
  composerSubmitShortcutHint,
  shouldSubmitComposerKey,
  type ComposerSubmitShortcut,
} from "@/lib/composer-submit-shortcut";
import { composerSubmitShortcutAtom } from "@/stores/ui";
import { useMicRecorder } from "@/hooks/use-mic-recorder";
import {
  isVoiceSetupErrorMessage,
  sttEnabledFromConfig,
  transcribeAudioBlob,
  voiceErrorMessage,
  voiceMaxRecordingSecondsFromConfig,
} from "@/lib/voice";
import {
  normalizeWorkspacePath,
  readWorkspacePath,
  rememberWorkspaceProject,
  writeWorkspacePath,
} from "@/lib/workspaces";
import {
  ComposerAttachmentError,
  type ComposerAttachment,
  type ComposerContextUsage,
  type ComposerMentionPickerProps,
  type ComposerModelPickerProps,
  type ComposerModelSelection,
  type ComposerReasoningPickerProps,
  type ComposerSkillPickerProps,
  type ComposerSubmitControls,
  type ComposerSubmitPayload,
} from "./composer-types";
import {
  AttachmentTray,
  attachmentIdentity,
  createFileAttachment,
  createPathAttachment,
  isAttachmentBusy,
  MAX_ATTACHMENT_BYTES,
  revokeAttachmentPreview,
  uniquePaths,
} from "./goose-composer-attachments";
import { ContextIndicator, contextRiskText } from "./goose-composer-context";
import { SendIcon, StopIcon } from "./goose-composer-icons";
import {
  ModelPickerModal,
  modelButtonText,
} from "./goose-composer-model-picker";
import { WorkspacePickerModal } from "@/components/composer/workspace-picker";
import { UrlDialog } from "@/components/composer/url-dialog";
import { isSingleUrl, urlReferenceText } from "@/lib/composer-url";
import { ReasoningEffortMenu } from "@/components/composer/reasoning-effort-menu";
import s from "./goose-composer.module.css";

export interface ComposerHint {
  kbd?: string;
  label: string;
}

interface GooseComposerProps {
  onSend?: (
    payload: ComposerSubmitPayload,
    controls: ComposerSubmitControls,
  ) => void | Promise<void>;
  onStop?: () => void | Promise<void>;
  placeholder?: string;
  initial?: string;
  initialNonce?: number;
  autoFocus?: boolean;
  disabled?: boolean;
  loading?: boolean;
  showMeta?: boolean;
  compact?: boolean;
  /** "big" makes the composer the page hero: shows a header bar (label + char count
   * + context ring) and a row of empty-state hints; textarea is taller. */
  variant?: "default" | "big";
  /** Label shown on the left of the big-variant header bar. Default "新任务". */
  headerLabel?: string;
  /** Empty-state hints shown only in big variant when textarea is empty. */
  hints?: ComposerHint[];
  /** Keyboard shortcut for submitting; defaults to the global composer setting. */
  submitShortcut?: ComposerSubmitShortcut;
  loadingPlaceholder?: string;
  modelPicker?: ComposerModelPickerProps;
  reasoningPicker?: ComposerReasoningPickerProps;
  skillPicker?: ComposerSkillPickerProps;
  mentionPicker?: ComposerMentionPickerProps;
  contextUsage?: ComposerContextUsage | null;
  initialWorkspacePath?: string;
  voiceConfig?: Record<string, unknown> | null;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "发送失败");
}

function MentionIcon({ kind }: { kind: MentionKind }) {
  switch (kind) {
    case "folder":
      return <Folder aria-hidden="true" />;
    case "url":
      return <Globe aria-hidden="true" />;
    case "git":
      return <GitBranch aria-hidden="true" />;
    case "session":
      return <MessageSquare aria-hidden="true" />;
    case "file":
      return <FileText aria-hidden="true" />;
    default:
      return <AtSign aria-hidden="true" />;
  }
}

function formatVoiceElapsed(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

export function ComposerErrorMessage({
  message,
  onConfigureVoice,
}: {
  message: string;
  onConfigureVoice?: () => void;
}) {
  const showVoiceSetup = isVoiceSetupErrorMessage(message);
  return (
    <div className={s.errorText}>
      <span>{message}</span>
      {showVoiceSetup && onConfigureVoice ? (
        <button type="button" className={s.errorAction} onClick={onConfigureVoice}>
          去配置语音
        </button>
      ) : null}
    </div>
  );
}

export function GooseComposer({
  onSend,
  onStop,
  placeholder,
  initial = "",
  initialNonce = 0,
  autoFocus = false,
  disabled = false,
  loading = false,
  showMeta = true,
  compact = false,
  variant = "default",
  headerLabel = "新任务",
  loadingPlaceholder,
  hints,
  submitShortcut,
  modelPicker,
  reasoningPicker,
  skillPicker,
  mentionPicker,
  contextUsage,
  initialWorkspacePath = "",
  voiceConfig = null,
}: GooseComposerProps) {
  const navigate = useNavigate();
  const configuredSubmitShortcut = useAtomValue(composerSubmitShortcutAtom);
  const effectiveSubmitShortcut = submitShortcut ?? configuredSubmitShortcut;
  const submitHint = composerSubmitShortcutHint(effectiveSubmitShortcut);
  const isBig = variant === "big";
  const [value, setValue] = useState(initial);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [selectionStart, setSelectionStart] = useState(initial.length);
  const [selectionEnd, setSelectionEnd] = useState(initial.length);
  const [workspacePath, setWorkspacePath] = useState(
    () => normalizeWorkspacePath(initialWorkspacePath) || readWorkspacePath(),
  );
  const [submitError, setSubmitError] = useState("");
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelOptions, setModelOptions] = useState<ModelOptionsResult | null>(
    modelPicker?.initialOptions ?? null,
  );
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [switchingModel, setSwitchingModel] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<ComposerSkillCandidate | null>(null);
  const [skillActiveIndex, setSkillActiveIndex] = useState(0);
  const [dismissedSlashToken, setDismissedSlashToken] = useState("");
  const [mentionCandidates, setMentionCandidates] = useState<MentionCandidate[]>([]);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [dismissedMentionToken, setDismissedMentionToken] = useState("");
  const [urlDialog, setUrlDialog] = useState<{ url: string; start: number; end: number } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const mentionReqIdRef = useRef(0);
  const [voiceStatus, setVoiceStatus] = useState<"idle" | "recording" | "transcribing">("idle");
  const [voiceElapsedSeconds, setVoiceElapsedSeconds] = useState(0);
  const { handle: micRecorder, level: voiceLevel } = useMicRecorder();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const valueRef = useRef(initial);
  const voiceStatusRef = useRef(voiceStatus);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const modelLoadPromiseRef = useRef<Promise<ModelOptionsResult> | null>(null);
  const selectedModelRef = useRef<ComposerModelSelection | null>(modelPicker?.selected ?? null);
  const dragDepthRef = useRef(0);
  const voiceStartedAtRef = useRef(0);
  const voiceIntervalRef = useRef<number | null>(null);
  const voiceTimeoutRef = useRef<number | null>(null);
  const hasProcessingAttachment = attachments.some(isAttachmentBusy);
  const sttEnabled = sttEnabledFromConfig(voiceConfig);
  const maxRecordingSeconds = voiceMaxRecordingSecondsFromConfig(voiceConfig);
  const contextRisk = contextUsageRisk(contextUsage);
  const contextWarning = contextRiskText(contextRisk, loading);
  const controlsDisabled = disabled || loading;
  const modelPickerDisabled = controlsDisabled || Boolean(modelPicker?.disabled);
  const submitText = selectedSkill
    ? buildSkillCommandText(selectedSkill.skill.name, value)
    : value.trim();
  const displayedTextLength = value.length;
  const canSend =
    (submitText.length > 0 || attachments.length > 0) &&
    !controlsDisabled &&
    !hasProcessingAttachment;
  // Two-tier slash palette: typing "/" lists top-level commands (/skill,
  // /compress) via slashToken (command mode); typing "/skill <name>" lists the
  // skill catalog via skillToken (skill mode). The two tokens are disjoint by
  // caret position, so at most one is active at a time.
  const slashToken = useMemo(
    () => selectedSkill ? null : getLeadingSlashToken(value, selectionStart, selectionEnd),
    [selectionEnd, selectionStart, selectedSkill, value],
  );
  const skillToken = useMemo(
    () => selectedSkill ? null : getSkillNamespaceToken(value, selectionStart, selectionEnd),
    [selectionEnd, selectionStart, selectedSkill, value],
  );
  const activeToken = skillToken ?? slashToken;
  // A built-in slash command (e.g. /compress) is handled client-side on submit,
  // so keep the picker out of its way — otherwise Enter could select a fuzzy
  // match instead of running the command.
  const builtinSlash = useMemo(
    () => Boolean(slashToken && isBuiltinComposerCommandToken(slashToken.token)),
    [slashToken],
  );
  const skillsAvailable = Boolean(skillPicker && !skillPicker.disabled);
  const skillCandidates = useMemo(
    () => skillToken && skillPicker
      ? filterComposerSkills(skillPicker.skills, skillToken.query)
      : [],
    [skillPicker, skillToken],
  );
  // Command mode only: rank top-level commands (skill namespace shown only where
  // a skill picker is wired). A fully-typed "/compress" sets builtinSlash, the
  // panel closes, and Enter runs the command immediately.
  const commandCandidates = useMemo(
    () => !skillToken && slashToken && !builtinSlash
      ? filterComposerCommands(slashToken.query, { skillsAvailable })
      : [],
    [builtinSlash, skillsAvailable, skillToken, slashToken],
  );
  const totalCandidates = commandCandidates.length + skillCandidates.length;
  const skillPanelOpen = Boolean(
    activeToken &&
    !builtinSlash &&
    !controlsDisabled &&
    dismissedSlashToken !== activeToken.token &&
    (commandCandidates.length > 0 || (skillToken && skillsAvailable)),
  );

  // `@` inline references (files / folders / url / past sessions). The token may
  // appear mid-text, so it is tracked independently of the leading slash command
  // and stays available even while a skill chip is selected.
  const mentionToken = useMemo(
    () => mentionPicker && !mentionPicker.disabled && selectionStart === selectionEnd
      ? getActiveMentionToken(value, selectionStart)
      : null,
    [mentionPicker, selectionEnd, selectionStart, value],
  );
  const mentionTokenKey = mentionToken ? `${mentionToken.start}:${mentionToken.query}` : "";
  const mentionPanelOpen = Boolean(
    mentionToken &&
    !controlsDisabled &&
    dismissedMentionToken !== mentionTokenKey &&
    (mentionCandidates.length > 0 || mentionLoading),
  );

  const resolvedPlaceholder = selectedSkill
    ? `继续描述给 ${selectedSkill.displayName} 的任务…`
    : placeholder ?? `发送消息，${submitHint}…`;

  const clearVoiceTimers = useCallback(() => {
    if (voiceIntervalRef.current !== null) {
      window.clearInterval(voiceIntervalRef.current);
      voiceIntervalRef.current = null;
    }
    if (voiceTimeoutRef.current !== null) {
      window.clearTimeout(voiceTimeoutRef.current);
      voiceTimeoutRef.current = null;
    }
  }, []);

  const focusTextareaAt = useCallback((cursor: number) => {
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
      setSelectionStart(cursor);
      setSelectionEnd(cursor);
    });
  }, []);

  const insertTranscript = useCallback((transcript: string) => {
    const text = transcript.trim();
    if (!text) return;

    const current = valueRef.current;
    const textarea = textareaRef.current;
    const rawStart = textarea?.selectionStart ?? selectionStart;
    const rawEnd = textarea?.selectionEnd ?? selectionEnd;
    const start = Math.max(0, Math.min(rawStart, current.length));
    const end = Math.max(start, Math.min(rawEnd, current.length));
    const before = current.slice(0, start);
    const after = current.slice(end);
    const prefix = before && !/\s$/.test(before) ? " " : "";
    const suffix = after && !/^\s/.test(after) ? " " : "";
    const next = `${before}${prefix}${text}${suffix}${after}`;
    const cursor = before.length + prefix.length + text.length;

    valueRef.current = next;
    setValue(next);
    setDismissedSlashToken("");
    focusTextareaAt(cursor);
  }, [focusTextareaAt, selectionEnd, selectionStart]);

  const stopVoiceRecording = useCallback(async () => {
    if (voiceStatusRef.current !== "recording") return;
    clearVoiceTimers();
    voiceStatusRef.current = "transcribing";
    setVoiceStatus("transcribing");
    try {
      const result = await micRecorder.stop();
      if (!result) {
        voiceStatusRef.current = "idle";
        setVoiceStatus("idle");
        return;
      }
      const response = await transcribeAudioBlob(result.audio);
      const transcript = response.transcript.trim();
      if (!transcript) {
        setSubmitError("未识别到语音，请再试一次。");
      } else {
        setSubmitError("");
        insertTranscript(transcript);
      }
    } catch (error) {
      setSubmitError(voiceErrorMessage(error, "语音转写失败"));
    } finally {
      voiceStatusRef.current = "idle";
      setVoiceStatus("idle");
      setVoiceElapsedSeconds(0);
    }
  }, [clearVoiceTimers, insertTranscript, micRecorder]);

  const startVoiceRecording = useCallback(async () => {
    if (controlsDisabled || voiceStatus !== "idle") return;
    if (!sttEnabled) {
      setSubmitError("语音识别（STT）已在设置中关闭，请先启用 stt.enabled。");
      return;
    }

    setSubmitError("");
    try {
      await micRecorder.start({
        onError: (error) => setSubmitError(voiceErrorMessage(error, "录音失败")),
      });
      voiceStartedAtRef.current = Date.now();
      setVoiceElapsedSeconds(0);
      voiceStatusRef.current = "recording";
      setVoiceStatus("recording");
      voiceIntervalRef.current = window.setInterval(() => {
        setVoiceElapsedSeconds((Date.now() - voiceStartedAtRef.current) / 1000);
      }, 250);
      voiceTimeoutRef.current = window.setTimeout(() => {
        void stopVoiceRecording();
      }, maxRecordingSeconds * 1000);
    } catch (error) {
      clearVoiceTimers();
      voiceStatusRef.current = "idle";
      setVoiceStatus("idle");
      setSubmitError(voiceErrorMessage(error, "录音失败"));
    }
  }, [clearVoiceTimers, controlsDisabled, maxRecordingSeconds, micRecorder, stopVoiceRecording, sttEnabled, voiceStatus]);

  const toggleVoiceRecording = useCallback(() => {
    if (voiceStatus === "recording") {
      void stopVoiceRecording();
      return;
    }
    if (voiceStatus === "idle") {
      void startVoiceRecording();
    }
  }, [startVoiceRecording, stopVoiceRecording, voiceStatus]);

  // Make `initial` reactive so external prefill (e.g. quick-start recipes) takes
  // effect after mount. We focus the textarea on non-empty external pushes so
  // the user can keep typing without an extra click.
  useEffect(() => {
    setValue(initial);
    setSelectedSkill(null);
    setSelectionStart(initial.length);
    setSelectionEnd(initial.length);
    if (initial) {
      window.requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, initialNonce]);

  useEffect(() => {
    if (autoFocus) {
      textareaRef.current?.focus();
    }
  }, [autoFocus]);

  useEffect(() => {
    const nextPath = normalizeWorkspacePath(initialWorkspacePath);
    if (!nextPath) return;
    setWorkspacePath(nextPath);
    writeWorkspacePath(nextPath);
    rememberWorkspaceProject(nextPath);
  }, [initialWorkspacePath]);

  useEffect(() => {
    valueRef.current = value;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 196)}px`;
  }, [value]);

  useEffect(() => {
    voiceStatusRef.current = voiceStatus;
  }, [voiceStatus]);

  useEffect(() => () => clearVoiceTimers(), [clearVoiceTimers]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    selectedModelRef.current = modelPicker?.selected ?? null;
  }, [modelPicker?.selected]);

  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach(revokeAttachmentPreview);
    };
  }, []);

  useEffect(() => {
    if (!controlsDisabled) return;
    setWorkspacePickerOpen(false);
    setModelOpen(false);
    setDismissedSlashToken("");
    setDismissedMentionToken("");
    setDragActive(false);
    dragDepthRef.current = 0;
  }, [controlsDisabled]);

  useEffect(() => {
    setSkillActiveIndex(0);
  }, [activeToken?.token, commandCandidates.length, skillCandidates.length]);

  // Keep the latest mentionPicker in a ref so the fetch effect can depend only
  // on the token (the parent recreates the picker object every render).
  const mentionPickerRef = useRef(mentionPicker);
  useEffect(() => {
    mentionPickerRef.current = mentionPicker;
  });

  // Fetch `@` completion candidates for the active token (debounced; stale
  // responses dropped via a monotonically increasing request id).
  useEffect(() => {
    setMentionActiveIndex(0);
    const picker = mentionPickerRef.current;
    if (!mentionTokenKey || !picker || picker.disabled) {
      setMentionCandidates([]);
      setMentionLoading(false);
      return;
    }
    const reqId = (mentionReqIdRef.current += 1);
    setMentionLoading(true);
    // mentionTokenKey is `${start}:${query}`; the query may itself contain ":".
    const query = mentionTokenKey.slice(mentionTokenKey.indexOf(":") + 1);
    const source = {
      completePath: picker.completePath,
      sessions: picker.sessions,
      profile: picker.profile,
    };
    const timer = setTimeout(() => {
      void getMentionCandidates(query, source).then((candidates) => {
        if (mentionReqIdRef.current !== reqId) return;
        setMentionCandidates(candidates);
        setMentionLoading(false);
      });
    }, 120);
    return () => clearTimeout(timer);
  }, [mentionTokenKey]);

  // Picker now groups candidates internally (recent / configured /
  // recommended / more) from the catalog + usage log. Composer just hands it
  // the raw model.options payload and stays out of the way.

  const appendAttachmentDrafts = (drafts: ComposerAttachment[]) => {
    if (!drafts.length) return;
    setAttachments((current) => {
      const existing = new Set(current.map(attachmentIdentity));
      const additions: ComposerAttachment[] = [];
      for (const draft of drafts) {
        const identity = attachmentIdentity(draft);
        if (existing.has(identity)) {
          revokeAttachmentPreview(draft);
          continue;
        }
        existing.add(identity);
        additions.push(draft);
      }
      return additions.length ? [...current, ...additions] : current;
    });
  };

  const addPathAttachments = (paths: string[]) => {
    const nextPaths = uniquePaths(paths);
    if (!nextPaths.length) return;
    setSubmitError("");
    appendAttachmentDrafts(nextPaths.map((path, index) => createPathAttachment(path, index)));
  };

  const addBrowserFiles = (files: File[] | FileList) => {
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const file of Array.from(files)) {
      if (file.size === 0) {
        rejected.push(`${file.name || "未命名文件"} 为空文件`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        rejected.push(`${file.name || "未命名文件"} 超过 50 MB`);
        continue;
      }
      accepted.push(file);
    }

    if (rejected.length) {
      setSubmitError(rejected.slice(0, 2).join("；"));
    } else {
      setSubmitError("");
    }
    appendAttachmentDrafts(accepted.map((file, index) => createFileAttachment(file, index)));
  };

  const pickFiles = async () => {
    if (controlsDisabled) return;
    setSubmitError("");
    try {
      if (window.hermesDesktop?.pickFiles) {
        const result = await window.hermesDesktop.pickFiles();
        if (!result.canceled) addPathAttachments(result.paths);
        return;
      }
      fileInputRef.current?.click();
    } catch (error) {
      setSubmitError(messageFromError(error));
    }
  };

  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (!controlsDisabled && event.target.files) {
      addBrowserFiles(event.target.files);
    }
    event.target.value = "";
  };

  const applyWorkspacePath = (path: string) => {
    const nextPath = normalizeWorkspacePath(path);
    if (!nextPath) return;
    setWorkspacePath(nextPath);
    writeWorkspacePath(nextPath);
    rememberWorkspaceProject(nextPath);
  };

  const pickWorkspace = async () => {
    if (controlsDisabled) return;
    setSubmitError("");
    try {
      if (window.hermesDesktop?.pickDirectory) {
        const result = await window.hermesDesktop.pickDirectory();
        if (!result.canceled) applyWorkspacePath(result.paths[0] ?? "");
        return;
      }
      setWorkspacePickerOpen(true);
    } catch (error) {
      setSubmitError(messageFromError(error));
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => {
      const target = current.find((item) => item.id === id);
      if (target) revokeAttachmentPreview(target);
      return current.filter((item) => item.id !== id);
    });
  };

  const markAttachmentsProcessing = () => {
    setAttachments((current) =>
      current.map((item) => ({
        ...item,
        status: isAttachmentBusy(item) ? item.status : "processing",
        error: undefined,
        progress: item.status === "uploading" ? item.progress : undefined,
      })),
    );
  };

  const restoreAttachmentState = (error: unknown) => {
    const message = messageFromError(error);
    if (error instanceof ComposerAttachmentError && error.attachmentId) {
      setAttachments((current) =>
        current.map((item) =>
          item.id === error.attachmentId
            ? { ...item, status: "error", error: message }
            : { ...item, status: "ready", error: undefined, progress: undefined },
        ),
      );
      setSubmitError(message);
      return;
    }

    setAttachments((current) =>
      current.map((item) => ({ ...item, status: "ready", error: undefined, progress: undefined })),
    );
    setSubmitError(message);
  };

  const updateAttachment: ComposerSubmitControls["updateAttachment"] = (id, patch) => {
    setAttachments((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  };

  const syncTextareaSelection = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    setSelectionStart(textarea.selectionStart);
    setSelectionEnd(textarea.selectionEnd);
  };

  const commitSkillSelection = (candidate: ComposerSkillCandidate) => {
    if (!activeToken) return;
    const next = extractBodyAfterLeadingSlashToken(value, activeToken);
    setSelectedSkill(candidate);
    setValue(next.text);
    setSelectionStart(next.cursor);
    setSelectionEnd(next.cursor);
    setDismissedSlashToken("");
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(next.cursor, next.cursor);
      setSelectionStart(next.cursor);
      setSelectionEnd(next.cursor);
    });
  };

  const commitMentionSelection = (candidate: MentionCandidate) => {
    if (!mentionToken) return;
    const next = buildMentionReplacement(value, mentionToken, candidate);
    setValue(next.text);
    setSelectionStart(next.cursor);
    setSelectionEnd(next.cursor);
    setDismissedMentionToken("");
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(next.cursor, next.cursor);
      setSelectionStart(next.cursor);
      setSelectionEnd(next.cursor);
    });
  };

  const commitCommandSelection = (candidate: ComposerCommandCandidate) => {
    if (!slashToken) return;
    // Fill "/skill " (then the skill sub-picker opens) or "/compress " (then the
    // user can append a focus topic; a following Enter runs it via the
    // detail-route built-in interception).
    const next = replaceLeadingSlashToken(value, slashToken, candidate.token);
    setValue(next.text);
    setSelectionStart(next.cursor);
    setSelectionEnd(next.cursor);
    setDismissedSlashToken("");
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(next.cursor, next.cursor);
      setSelectionStart(next.cursor);
      setSelectionEnd(next.cursor);
    });
  };

  const clearSelectedSkill = () => {
    setSelectedSkill(null);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      setSelectionStart(textarea.selectionStart);
      setSelectionEnd(textarea.selectionEnd);
    });
  };

  const send = async () => {
    if (!canSend) return;
    const payload: ComposerSubmitPayload = {
      text: submitText,
      attachments,
      workspacePath: workspacePath.trim() || undefined,
      modelSelection: selectedModelRef.current ?? undefined,
      skillCommandNames: skillPicker?.skills.map((skill) => skill.name),
    };

    setSubmitError("");
    markAttachmentsProcessing();
    try {
      await onSend?.(payload, { updateAttachment });
      setValue("");
      setSelectedSkill(null);
      setSelectionStart(0);
      setSelectionEnd(0);
      setDismissedSlashToken("");
      setAttachments((current) => {
        current.forEach(revokeAttachmentPreview);
        return [];
      });
    } catch (error) {
      restoreAttachmentState(error);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      selectedSkill &&
      event.key === "Backspace" &&
      selectionStart === 0 &&
      selectionEnd === 0 &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      clearSelectedSkill();
      return;
    }

    if (mentionPanelOpen && !event.nativeEvent.isComposing) {
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedMentionToken(mentionTokenKey);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionActiveIndex((current) =>
          mentionCandidates.length ? (current + 1) % mentionCandidates.length : 0);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionActiveIndex((current) =>
          mentionCandidates.length
            ? (current - 1 + mentionCandidates.length) % mentionCandidates.length
            : 0);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && mentionCandidates.length > 0) {
        event.preventDefault();
        commitMentionSelection(
          mentionCandidates[Math.min(mentionActiveIndex, mentionCandidates.length - 1)]!,
        );
        return;
      }
    }

    if (skillPanelOpen && !event.nativeEvent.isComposing) {
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedSlashToken(activeToken?.token ?? "");
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSkillActiveIndex((current) =>
          totalCandidates ? (current + 1) % totalCandidates : 0);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSkillActiveIndex((current) =>
          totalCandidates
            ? (current - 1 + totalCandidates) % totalCandidates
            : 0);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && totalCandidates > 0) {
        event.preventDefault();
        const index = Math.min(skillActiveIndex, totalCandidates - 1);
        if (index < commandCandidates.length) {
          commitCommandSelection(commandCandidates[index]!);
        } else {
          commitSkillSelection(skillCandidates[index - commandCandidates.length]!);
        }
        return;
      }
    }

    const shouldSubmit = shouldSubmitComposerKey({
      key: event.key,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      isComposing: event.nativeEvent.isComposing,
    }, effectiveSubmitShortcut);

    if (shouldSubmit) {
      event.preventDefault();
      void send();
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (controlsDisabled) return;
    const files = Array.from(event.clipboardData.files);
    if (files.length) {
      event.preventDefault();
      addBrowserFiles(files);
      return;
    }
    // A bare-URL paste offers to attach it as an `@url:` reference (only where
    // backend ref expansion is wired, i.e. a mention source is present).
    if (mentionPicker && !mentionPicker.disabled) {
      const text = event.clipboardData.getData("text/plain");
      if (text && isSingleUrl(text)) {
        event.preventDefault();
        setUrlDialog({ url: text.trim(), start: selectionStart, end: selectionEnd });
      }
    }
  };

  const applyUrlInsertion = (insertText: string) => {
    if (!urlDialog) return;
    const before = value.slice(0, urlDialog.start);
    const after = value.slice(urlDialog.end);
    const insertion = after && !/^\s/.test(after) ? `${insertText} ` : insertText;
    const cursor = before.length + insertion.length;
    setValue(`${before}${insertion}${after}`);
    setSelectionStart(cursor);
    setSelectionEnd(cursor);
    setUrlDialog(null);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
      setSelectionStart(cursor);
      setSelectionEnd(cursor);
    });
  };

  const hasDroppableData = (event: DragEvent<HTMLDivElement>): boolean => {
    const types = Array.from(event.dataTransfer.types);
    return types.includes("Files") || types.includes("text/plain") || types.includes("text/uri-list");
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (controlsDisabled || !hasDroppableData(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!dragActive) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDragActive(false);
    }
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (controlsDisabled || !hasDroppableData(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    if (controlsDisabled) return;

    const paths: string[] = [];
    const text = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
    if (text) paths.push(...text.split(/\r?\n/));
    for (const file of Array.from(event.dataTransfer.files)) {
      const path = (file as File & { path?: string }).path;
      if (path) paths.push(path);
    }

    if (paths.length) {
      addPathAttachments(paths);
    } else {
      addBrowserFiles(event.dataTransfer.files);
    }
  };

  const loadModelOptions = useCallback(async () => {
    if (!modelPicker?.loadOptions) return modelOptions;
    if (modelOptions) return modelOptions;
    if (modelLoadPromiseRef.current) return modelLoadPromiseRef.current;

    setModelLoading(true);
    setModelError("");
    const promise = modelPicker.loadOptions()
      .then((options) => {
        setModelOptions(options);
        return options;
      })
      .catch((error) => {
        setModelError(messageFromError(error));
        throw error;
      })
      .finally(() => {
        modelLoadPromiseRef.current = null;
        setModelLoading(false);
      });
    modelLoadPromiseRef.current = promise;
    try {
      return await promise;
    } catch {
      return null;
    }
  }, [modelOptions, modelPicker]);

  const toggleModelPicker = () => {
    if (!modelPicker || modelPickerDisabled) return;
    const next = !modelOpen;
    setModelOpen(next);
    if (next) void loadModelOptions();
  };

  const selectModel = async (selection: ComposerModelSelection) => {
    if (!modelPicker?.onSelect || modelPickerDisabled) return;
    selectedModelRef.current = selection;
    setSwitchingModel(true);
    setModelError("");
    try {
      await modelPicker.onSelect(selection);
      setModelOpen(false);
    } catch (error) {
      selectedModelRef.current = modelPicker.selected ?? null;
      setModelError(messageFromError(error));
    } finally {
      setSwitchingModel(false);
    }
  };

  useEffect(() => {
    if (!modelPicker?.loadOptions || modelPickerDisabled) return;
    if (modelOptions || modelLoadPromiseRef.current) return;

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let idleId: number | undefined;
    const run = () => {
      if (!cancelled) void loadModelOptions();
    };

    if ("requestIdleCallback" in window) {
      idleId = window.requestIdleCallback(run, { timeout: 1200 });
    } else {
      timeoutId = setTimeout(run, 250);
    }

    return () => {
      cancelled = true;
      if (idleId !== undefined) window.cancelIdleCallback(idleId);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [loadModelOptions, modelOptions, modelPicker?.loadOptions, modelPickerDisabled]);

  // When the parent's useModelOptions query resolves *after* this composer
  // mounts (cache miss on first ever load), backfill our local state so the
  // picker opens with data instead of a spinner.
  useEffect(() => {
    if (modelPicker?.initialOptions && !modelOptions) {
      setModelOptions(modelPicker.initialOptions);
    }
  }, [modelPicker?.initialOptions, modelOptions]);

  const modelText = modelButtonText(modelPicker, modelOptions);
  const voiceButtonTitle = !sttEnabled
    ? "语音识别（STT）已关闭"
    : voiceStatus === "recording"
      ? "停止录音并转写"
      : voiceStatus === "transcribing"
        ? "正在转写语音"
        : `语音输入（最多 ${maxRecordingSeconds} 秒）`;
  const voiceButtonDisabled = controlsDisabled || voiceStatus === "transcribing" || !sttEnabled;

  return (
    <div className={s.wrapper} data-compact={compact} data-variant={variant}>
      <div
        className={s.box}
        data-disabled={disabled}
        data-drag-active={dragActive}
        data-variant={variant}
        onDrop={handleDrop}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className={s.hiddenFileInput}
          onChange={handleFileInputChange}
          tabIndex={-1}
        />
        {dragActive ? <div className={s.dropOverlay}>释放以添加到当前消息</div> : null}

        {isBig ? (
          <div className={s.bigHeader}>
            <span className={s.bigHeaderLabel}>
              <span className={s.bigHeaderDot} aria-hidden="true" />
              {headerLabel}
            </span>
            <span className={s.bigHeaderRight}>
              <span className={s.bigHeaderChars}>{displayedTextLength} 字</span>
              {contextUsage ? (
                <ContextIndicator
                  usage={contextUsage}
                  active={loading}
                />
              ) : null}
            </span>
          </div>
        ) : null}

        <AttachmentTray attachments={attachments} onRemove={removeAttachment} />

        {selectedSkill ? (
          <div className={s.selectedSkillRow}>
            <div
              className={s.selectedSkillChip}
              title={`${selectedSkill.displayName} · ${selectedSkill.command}`}
            >
              <Sparkles aria-hidden="true" />
              <span className={s.selectedSkillKicker}>Skill</span>
              <span className={s.selectedSkillName}>{selectedSkill.displayName}</span>
              <span className={s.selectedSkillCommand}>{selectedSkill.command}</span>
              <button
                type="button"
                className={s.selectedSkillRemove}
                onMouseDown={(event) => event.preventDefault()}
                onClick={clearSelectedSkill}
                disabled={controlsDisabled}
                aria-label={`移除 Skill ${selectedSkill.displayName}`}
                title="移除 Skill"
              >
                <X aria-hidden="true" />
              </button>
            </div>
            <span className={s.selectedSkillHint}>继续输入任务描述，Backspace 可移除</span>
          </div>
        ) : null}

        {voiceStatus !== "idle" ? (
          <div className={s.voiceActivity} role="status" aria-live="polite">
            <span className={s.voiceActivityIcon} data-status={voiceStatus}>
              {voiceStatus === "recording" ? (
                <Mic aria-hidden="true" />
              ) : (
                <Loader2 aria-hidden="true" />
              )}
            </span>
            <span className={s.voiceActivityText}>
              {voiceStatus === "recording" ? "正在录音" : "正在转写"}
            </span>
            <span className={s.voiceActivityTime}>
              {formatVoiceElapsed(voiceElapsedSeconds)}
            </span>
            <span className={s.voiceBars} aria-hidden="true">
              {[0.5, 0.78, 1, 0.78, 0.5].map((weight, index) => (
                <span
                  key={index}
                  style={{
                    height: `${Math.round((0.24 + Math.min(0.7, voiceLevel * weight)) * 100)}%`,
                  }}
                />
              ))}
            </span>
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setSelectionStart(event.target.selectionStart);
            setSelectionEnd(event.target.selectionEnd);
            setDismissedSlashToken("");
            setDismissedMentionToken("");
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={syncTextareaSelection}
          onClick={syncTextareaSelection}
          onSelect={syncTextareaSelection}
          onPaste={handlePaste}
          placeholder={loading ? (loadingPlaceholder || "Hermes 正在响应...") : resolvedPlaceholder}
          rows={1}
          className={s.textarea}
          disabled={disabled}
          aria-label="输入消息"
        />

        {skillPanelOpen ? (
          <div className={s.skillPanel} role="listbox" aria-label={skillToken ? "选择 Skill" : "斜杠命令"}>
            <div className={s.skillPanelHead}>
              <span>
                <Sparkles aria-hidden="true" />
                {skillToken ? "选择 Skill" : "斜杠命令"}
              </span>
              <small>Enter / Tab 选择，Esc 关闭</small>
            </div>
            {commandCandidates.length > 0 ? (
              <div className={s.skillList}>
                {commandCandidates.map((candidate, index) => (
                  <button
                    key={`cmd-${candidate.token}`}
                    type="button"
                    className={s.skillOption}
                    data-active={index === skillActiveIndex}
                    data-kind="command"
                    role="option"
                    aria-selected={index === skillActiveIndex}
                    onMouseEnter={() => setSkillActiveIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => commitCommandSelection(candidate)}
                  >
                    <span className={s.skillCommand}>{candidate.command}</span>
                    <span className={s.skillMain}>
                      <span className={s.skillName}>{candidate.displayName}</span>
                      <span className={s.skillDesc}>{candidate.description}</span>
                    </span>
                    <span className={s.skillMeta}>
                      {candidate.kind === "namespace" ? "命令组" : "内置命令"}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
            {skillToken && skillPicker?.loading && totalCandidates === 0 ? (
              <div className={s.skillPanelState}>正在读取已启用 Skill…</div>
            ) : skillToken && skillPicker?.error && totalCandidates === 0 ? (
              <div className={s.skillPanelState} data-tone="error">
                {skillPicker.error}
              </div>
            ) : skillToken && totalCandidates === 0 ? (
              <div className={s.skillPanelState}>没有匹配的 Skill</div>
            ) : skillCandidates.length > 0 ? (
              <div className={s.skillList}>
                {skillCandidates.map((candidate, index) => {
                  const combinedIndex = commandCandidates.length + index;
                  return (
                    <button
                      key={candidate.skill.name}
                      type="button"
                      className={s.skillOption}
                      data-active={combinedIndex === skillActiveIndex}
                      role="option"
                      aria-selected={combinedIndex === skillActiveIndex}
                      onMouseEnter={() => setSkillActiveIndex(combinedIndex)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => commitSkillSelection(candidate)}
                    >
                      <span className={s.skillCommand}>{candidate.command}</span>
                      <span className={s.skillMain}>
                        <span className={s.skillName}>{candidate.displayName}</span>
                        <span className={s.skillDesc}>{candidate.description}</span>
                      </span>
                      <span className={s.skillMeta}>
                        {candidate.originLabel} · {candidate.categoryLabel}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}

        {mentionPanelOpen ? (
          <div className={s.skillPanel} role="listbox" aria-label="插入引用">
            <div className={s.skillPanelHead}>
              <span>
                <AtSign aria-hidden="true" />
                插入引用
              </span>
              <small>Enter / Tab 选择，Esc 关闭</small>
            </div>
            {mentionLoading && mentionCandidates.length === 0 ? (
              <div className={s.skillPanelState}>正在检索…</div>
            ) : mentionCandidates.length === 0 ? (
              <div className={s.skillPanelState}>没有匹配的引用</div>
            ) : (
              <div className={s.skillList}>
                {mentionCandidates.map((candidate, index) => (
                  <button
                    key={`${candidate.kind}-${candidate.insertText}-${index}`}
                    type="button"
                    className={s.skillOption}
                    data-active={index === mentionActiveIndex}
                    data-kind="mention"
                    role="option"
                    aria-selected={index === mentionActiveIndex}
                    onMouseEnter={() => setMentionActiveIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => commitMentionSelection(candidate)}
                  >
                    <span className={s.skillCommand}>
                      <MentionIcon kind={candidate.kind} />
                    </span>
                    <span className={s.skillMain}>
                      <span className={s.skillName}>{candidate.display}</span>
                      {candidate.meta ? (
                        <span className={s.skillDesc}>{candidate.meta}</span>
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {isBig && !selectedSkill && hints && hints.length > 0 && value.length === 0 ? (
          <div className={s.hintRow}>
            {hints.map((hint, idx) => (
              <span key={`${hint.label}-${idx}`} className={s.hintItem}>
                {hint.kbd ? <span className={s.hintKbd}>{hint.kbd}</span> : null}
                {hint.label}
              </span>
            ))}
          </div>
        ) : null}

        {submitError ? (
          <ComposerErrorMessage
            message={submitError}
            onConfigureVoice={() => navigate("/voice")}
          />
        ) : null}

        {contextWarning ? (
          <div className={s.contextWarning} data-risk={contextRisk}>
            <span>{contextWarning}</span>
          </div>
        ) : null}

        <div className={s.toolbar}>
          <div className={s.leftTools}>
            <button
              className={s.iconButton}
              type="button"
              onClick={() => void pickFiles()}
              disabled={controlsDisabled}
              title="添加附件"
              aria-label="添加附件"
            >
              <Plus className={s.toolIcon} aria-hidden="true" />
            </button>
            <button
              className={s.iconButton}
              type="button"
              onClick={toggleVoiceRecording}
              disabled={voiceButtonDisabled}
              data-active={voiceStatus !== "idle"}
              data-status={voiceStatus}
              title={voiceButtonTitle}
              aria-label={voiceButtonTitle}
              aria-pressed={voiceStatus === "recording"}
            >
              {voiceStatus === "recording" ? (
                <Square className={s.toolIcon} aria-hidden="true" />
              ) : voiceStatus === "transcribing" ? (
                <Loader2 className={s.toolIcon} aria-hidden="true" />
              ) : (
                <Mic className={s.toolIcon} aria-hidden="true" />
              )}
            </button>
            <button
              className={s.toolButton}
              type="button"
              onClick={() => void pickWorkspace()}
              disabled={controlsDisabled}
              data-active={Boolean(workspacePath)}
              title={workspacePath || "选择工作区"}
            >
              <Folder className={s.toolIcon} aria-hidden="true" />
              <span>工作区</span>
              {workspacePath ? <small>{fileNameFromPath(workspacePath)}</small> : null}
            </button>
            {modelPicker ? (
              <button
                className={s.toolButton}
                type="button"
                onClick={toggleModelPicker}
                disabled={modelPickerDisabled}
                data-active={modelOpen || Boolean(modelPicker.selected)}
                title={modelText}
                aria-haspopup="dialog"
                aria-expanded={modelOpen}
              >
                <Cpu className={s.toolIcon} aria-hidden="true" />
                <span>模型</span>
                <small>{modelText}</small>
              </button>
            ) : null}
            {reasoningPicker ? (
              <ReasoningEffortMenu
                value={reasoningPicker.value}
                onSelect={reasoningPicker.onSelect}
                disabled={controlsDisabled || reasoningPicker.disabled}
              />
            ) : null}
            {showMeta && (
              <>
                <span className={s.pill}>本地模式</span>
                <span className={s.pill}>完全访问权限</span>
              </>
            )}
          </div>

          <div className={s.rightTools}>
            {contextUsage && !isBig ? (
              <ContextIndicator
                usage={contextUsage}
                active={loading}
              />
            ) : loading ? (
              <span className={s.liveDot} aria-hidden="true" />
            ) : null}
            {loading && onStop ? (
              <button
                className={s.sendButton}
                type="button"
                data-mode="stop"
                onClick={() => void onStop()}
                disabled={disabled}
                aria-label="中止响应"
                title="中止响应"
              >
                <StopIcon />
              </button>
            ) : (
              <button
                className={s.sendButton}
                type="button"
                data-ready={canSend}
                onClick={() => void send()}
                disabled={!canSend}
                aria-label="发送消息"
                title={`发送消息（${submitHint}）`}
              >
                <SendIcon />
                <span>发送</span>
              </button>
            )}
          </div>
        </div>
      </div>
      {modelOpen ? (
        <ModelPickerModal
          modelSearch={modelSearch}
          onSearchChange={setModelSearch}
          onClose={() => setModelOpen(false)}
          loading={modelLoading}
          error={modelError}
          modelOptions={modelOptions}
          selected={modelPicker?.selected}
          switchingModel={switchingModel}
          onSelectModel={(selection) => void selectModel(selection)}
          onSelectAndSetDefault={
            modelPicker?.onSelectAndSetDefault
              ? (selection) => {
                  selectedModelRef.current = selection;
                  void Promise.resolve(modelPicker.onSelectAndSetDefault?.(selection))
                    .then(() => setModelOpen(false))
                    .catch(() => {
                      selectedModelRef.current = modelPicker.selected ?? null;
                    });
                }
              : undefined
          }
          onConfigureProvider={(providerId) => {
            setModelOpen(false);
            modelPicker?.onConfigureProvider?.(providerId);
          }}
        />
      ) : null}
      {workspacePickerOpen ? (
        <WorkspacePickerModal
          open
          initialPath={workspacePath}
          onCancel={() => setWorkspacePickerOpen(false)}
          onConfirm={(path) => {
            setWorkspacePickerOpen(false);
            applyWorkspacePath(path);
          }}
        />
      ) : null}
      <UrlDialog
        open={Boolean(urlDialog)}
        url={urlDialog?.url ?? ""}
        onInsertReference={() => applyUrlInsertion(urlReferenceText(urlDialog?.url ?? ""))}
        onInsertPlain={() => applyUrlInsertion(urlDialog?.url ?? "")}
        onCancel={() => setUrlDialog(null)}
      />
    </div>
  );
}
