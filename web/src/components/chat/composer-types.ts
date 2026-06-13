import type { ModelOptionsResult, SkillInfo } from "@hermes/protocol";
import type { ReasoningEffort } from "@/lib/reasoning-effort";

export type ComposerAttachmentKind = "image" | "file" | "directory";
export type ComposerAttachmentSource = "browser" | "path" | "uploaded";
export type ComposerAttachmentStatus = "ready" | "uploading" | "processing" | "done" | "error";

export interface ComposerAttachment {
  id: string;
  source: ComposerAttachmentSource;
  path?: string;
  file?: File;
  name: string;
  kind: ComposerAttachmentKind;
  status: ComposerAttachmentStatus;
  size?: number;
  mimeType?: string;
  previewUrl?: string;
  uploadedPath?: string;
  uploadedName?: string;
  progress?: number;
  error?: string;
}

export interface ComposerModelSelection {
  model: string;
  provider?: string;
  providerName?: string;
  contextWindow?: number;
}

export interface ComposerContextUsage {
  used?: number;
  max?: number;
  percent?: number;
  model?: string;
  compressions?: number;
  estimated?: boolean;
}

export interface ComposerSubmitPayload {
  text: string;
  attachments: ComposerAttachment[];
  workspacePath?: string;
  modelSelection?: ComposerModelSelection;
  skillCommandNames?: string[];
}

export interface ComposerSubmitControls {
  updateAttachment(id: string, patch: Partial<ComposerAttachment>): void;
}

export interface ComposerModelPickerProps {
  selected?: ComposerModelSelection | null;
  label?: string;
  loadOptions?: () => Promise<ModelOptionsResult>;
  /** Pre-fetched options from useModelOptions — prevents the picker from
   * showing a spinner on first open when the data is already in cache. */
  initialOptions?: ModelOptionsResult | null;
  onSelect?: (selection: ComposerModelSelection) => void | Promise<void>;
  /** ⌘↵ variant of onSelect — switches the current session AND persists the
   * choice as the global default for future sessions. When unset, ⌘↵
   * degrades to plain onSelect. */
  onSelectAndSetDefault?: (selection: ComposerModelSelection) => void | Promise<void>;
  /** Called when the user clicks "去设置" on an unconfigured provider card.
   * Host routes wire this to React Router navigation (/models#<provider>). */
  onConfigureProvider?: (providerId: string) => void;
  disabled?: boolean;
}

export interface ComposerSkillPickerProps {
  skills: SkillInfo[];
  loading?: boolean;
  error?: string;
  disabled?: boolean;
}

export interface ComposerReasoningPickerProps {
  /** 当前思考强度；null 表示配置里未显式设置（后端回落到默认档）。 */
  value: ReasoningEffort | null;
  onSelect: (effort: ReasoningEffort) => void | Promise<void>;
  disabled?: boolean;
}

export class ComposerAttachmentError extends Error {
  attachmentId?: string;

  constructor(message: string, attachmentId?: string) {
    super(message);
    this.name = "ComposerAttachmentError";
    this.attachmentId = attachmentId;
  }
}
