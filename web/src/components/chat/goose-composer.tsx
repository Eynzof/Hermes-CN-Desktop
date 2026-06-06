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
import { Cpu, Folder, Plus, Sparkles } from "lucide-react";
import type { ModelOptionsResult } from "@hermes/protocol";
import { fileNameFromPath } from "@/lib/composer-prompt";
import {
  filterComposerSkills,
  getLeadingSlashToken,
  replaceLeadingSlashToken,
  type ComposerSkillCandidate,
} from "@/lib/composer-skills";
import { contextUsageRisk } from "@/lib/context-usage";
import {
  composerSubmitShortcutHint,
  shouldSubmitComposerKey,
  type ComposerSubmitShortcut,
} from "@/lib/composer-submit-shortcut";
import { composerSubmitShortcutAtom } from "@/stores/ui";
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
  type ComposerModelPickerProps,
  type ComposerModelSelection,
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
  skillPicker?: ComposerSkillPickerProps;
  contextUsage?: ComposerContextUsage | null;
  initialWorkspacePath?: string;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "发送失败");
}

export function GooseComposer({
  onSend,
  onStop,
  placeholder,
  initial = "",
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
  skillPicker,
  contextUsage,
  initialWorkspacePath = "",
}: GooseComposerProps) {
  const configuredSubmitShortcut = useAtomValue(composerSubmitShortcutAtom);
  const effectiveSubmitShortcut = submitShortcut ?? configuredSubmitShortcut;
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
  const [skillActiveIndex, setSkillActiveIndex] = useState(0);
  const [dismissedSlashToken, setDismissedSlashToken] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const modelLoadPromiseRef = useRef<Promise<ModelOptionsResult> | null>(null);
  const selectedModelRef = useRef<ComposerModelSelection | null>(modelPicker?.selected ?? null);
  const dragDepthRef = useRef(0);
  const hasProcessingAttachment = attachments.some(isAttachmentBusy);
  const contextRisk = contextUsageRisk(contextUsage);
  const contextWarning = contextRiskText(contextRisk, loading);
  const controlsDisabled = disabled || loading;
  const modelPickerDisabled = controlsDisabled || Boolean(modelPicker?.disabled);
  const canSend =
    (value.trim().length > 0 || attachments.length > 0) &&
    !controlsDisabled &&
    !hasProcessingAttachment;
  const slashToken = useMemo(
    () => getLeadingSlashToken(value, selectionStart, selectionEnd),
    [selectionEnd, selectionStart, value],
  );
  const skillCandidates = useMemo(
    () => slashToken && skillPicker
      ? filterComposerSkills(skillPicker.skills, slashToken.query)
      : [],
    [skillPicker, slashToken],
  );
  const skillPanelOpen = Boolean(
    slashToken &&
    skillPicker &&
    !controlsDisabled &&
    !skillPicker.disabled &&
    dismissedSlashToken !== slashToken.token,
  );

  // Make `initial` reactive so external prefill (e.g. quick-start recipes) takes
  // effect after mount. We focus the textarea on non-empty external pushes so
  // the user can keep typing without an extra click.
  useEffect(() => {
    setValue(initial);
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
  }, [initial]);

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
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 196)}px`;
  }, [value]);

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
    setDragActive(false);
    dragDepthRef.current = 0;
  }, [controlsDisabled]);

  useEffect(() => {
    setSkillActiveIndex(0);
  }, [slashToken?.token, skillCandidates.length]);

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
    if (!slashToken) return;
    const next = replaceLeadingSlashToken(value, slashToken, candidate.skill.name);
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

  const send = async () => {
    if (!canSend) return;
    const text = value.trim();
    const payload: ComposerSubmitPayload = {
      text,
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
    if (skillPanelOpen && !event.nativeEvent.isComposing) {
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedSlashToken(slashToken?.token ?? "");
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSkillActiveIndex((current) =>
          skillCandidates.length ? (current + 1) % skillCandidates.length : 0);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSkillActiveIndex((current) =>
          skillCandidates.length
            ? (current - 1 + skillCandidates.length) % skillCandidates.length
            : 0);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && skillCandidates.length > 0) {
        event.preventDefault();
        commitSkillSelection(skillCandidates[Math.min(skillActiveIndex, skillCandidates.length - 1)]!);
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

  const submitHint = composerSubmitShortcutHint(effectiveSubmitShortcut);
  const resolvedPlaceholder = placeholder ?? `发送消息，${submitHint}…`;

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (controlsDisabled) return;
    const files = Array.from(event.clipboardData.files);
    if (!files.length) return;
    event.preventDefault();
    addBrowserFiles(files);
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
              <span className={s.bigHeaderChars}>{value.length} 字</span>
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

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setSelectionStart(event.target.selectionStart);
            setSelectionEnd(event.target.selectionEnd);
            setDismissedSlashToken("");
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
          <div className={s.skillPanel} role="listbox" aria-label="选择 Skill">
            <div className={s.skillPanelHead}>
              <span>
                <Sparkles aria-hidden="true" />
                选择 Skill
              </span>
              <small>Enter / Tab 选择，Esc 关闭</small>
            </div>
            {skillPicker?.loading && skillCandidates.length === 0 ? (
              <div className={s.skillPanelState}>正在读取已启用 Skill…</div>
            ) : skillPicker?.error && skillCandidates.length === 0 ? (
              <div className={s.skillPanelState} data-tone="error">
                {skillPicker.error}
              </div>
            ) : skillCandidates.length === 0 ? (
              <div className={s.skillPanelState}>没有匹配的 Skill</div>
            ) : (
              <div className={s.skillList}>
                {skillCandidates.map((candidate, index) => (
                  <button
                    key={candidate.skill.name}
                    type="button"
                    className={s.skillOption}
                    data-active={index === skillActiveIndex}
                    role="option"
                    aria-selected={index === skillActiveIndex}
                    onMouseEnter={() => setSkillActiveIndex(index)}
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
                ))}
              </div>
            )}
          </div>
        ) : null}

        {isBig && hints && hints.length > 0 && value.length === 0 ? (
          <div className={s.hintRow}>
            {hints.map((hint, idx) => (
              <span key={`${hint.label}-${idx}`} className={s.hintItem}>
                {hint.kbd ? <span className={s.hintKbd}>{hint.kbd}</span> : null}
                {hint.label}
              </span>
            ))}
          </div>
        ) : null}

        {submitError ? <div className={s.errorText}>{submitError}</div> : null}

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
    </div>
  );
}
