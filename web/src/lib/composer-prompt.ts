import {
  ComposerAttachmentError,
  type ComposerAttachment,
  type ComposerSubmitPayload,
} from "@/components/chat/composer-types";
import type { AttachmentUploadResult, ImageAttachResult, InputDetectDropResult } from "@hermes/protocol";

const WORKSPACE_BLOCK_START = "[Hermes UI Workspace]";
const WORKSPACE_BLOCK_END = "[/Hermes UI Workspace]";
const WORKSPACE_BLOCK_RE = /\n?\[Hermes UI Workspace\]\nworkspace=[^\n]*\ninstruction=[\s\S]*?\n\[\/Hermes UI Workspace\]\n?/g;
const IMAGE_BLOCK_START = "[Hermes UI Image]";
const IMAGE_BLOCK_END = "[/Hermes UI Image]";
const IMAGE_BLOCK_RE = /\n?\[Hermes UI Image\]\nname=([^\n]*)\ndescription:\n[\s\S]*?\n\[\/Hermes UI Image\]\n?/g;
const IMAGE_FALLBACK_PREAMBLE_RE = /\n?\[The user attached an image(?: but analysis failed)?\.\]\n\[You can examine it with vision_analyze using image_url: [^\]\n]+\]\n?/g;
const IMAGE_FULL_PREAMBLE_RE = /\n?\[The user attached an image[\s\S]*?\]\n?\[(?:If you need a closer look,? use|You can examine it with) vision_analyze (?:with |using )?image_url: [^\]\n]+\]\n?/g;
const LEGACY_IMAGE_BLOCK_RE = /^\s*\[User attached image: ([^\]\n]+)\]\n[\s\S]*$/;

const IMAGE_EXTENSIONS = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);

export function isImagePath(path: string): boolean {
  const clean = path.split("?")[0]?.split("#")[0] ?? path;
  const index = clean.lastIndexOf(".");
  if (index === -1) return false;
  return IMAGE_EXTENSIONS.has(clean.slice(index).toLowerCase());
}

export function fileNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").pop() || path;
}

function attachmentSuffix(labels: string[]): string {
  return `附件：${labels.join("、")}`;
}

function sanitizeContextValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function stripLegacyImageContext(value: string, labels: string[]): string {
  const match = value.match(LEGACY_IMAGE_BLOCK_RE);
  if (!match) return value;

  const label = match[1]?.trim();
  if (label) labels.push(label);

  const body = value.replace(/^\s*\[User attached image: [^\]\n]+\]\n/, "");
  const lastSeparator = body.lastIndexOf("\n\n");
  return lastSeparator >= 0 ? body.slice(lastSeparator + 2) : "";
}

export function stripHermesUiWorkspaceContext(text: string | null | undefined): string {
  let value = (text ?? "")
    .replace(IMAGE_FALLBACK_PREAMBLE_RE, "")
    .replace(IMAGE_FULL_PREAMBLE_RE, "")
    .replace(WORKSPACE_BLOCK_RE, "");
  const imageLabels: string[] = [];

  value = value.replace(IMAGE_BLOCK_RE, (_block, label: string) => {
    const name = label.trim();
    if (name) imageLabels.push(name);
    return "\n";
  });
  value = stripLegacyImageContext(value, imageLabels).trim();

  if (imageLabels.length === 0) return value.trimEnd();

  const suffix = attachmentSuffix(imageLabels);
  return value ? `${value}\n\n${suffix}` : suffix;
}

function buildWorkspaceContext(workspacePath?: string): string {
  const path = workspacePath?.trim();
  if (!path) return "";
  return [
    WORKSPACE_BLOCK_START,
    `workspace=${path}`,
    "instruction=Treat this as the active workspace/root for file paths and shell commands.",
    WORKSPACE_BLOCK_END,
  ].join("\n");
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "附件处理失败");
}

function attachmentDisplayName(attachment: ComposerAttachment): string {
  return attachment.uploadedName || attachment.name || fileNameFromPath(attachment.path ?? "");
}

function readFileAsDataUrl(file: File): Promise<string | undefined> {
  if (typeof FileReader === "undefined") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(typeof reader.result === "string" ? reader.result : undefined);
    }, { once: true });
    reader.addEventListener("error", () => resolve(undefined), { once: true });
    reader.readAsDataURL(file);
  });
}

async function imageDisplayUrl(attachment: ComposerAttachment, path: string): Promise<string | undefined> {
  if (attachment.file?.type.startsWith("image/")) {
    const dataUrl = await readFileAsDataUrl(attachment.file);
    if (dataUrl) return dataUrl;
  }
  if (attachment.previewUrl && !attachment.previewUrl.startsWith("blob:")) return attachment.previewUrl;
  return path || undefined;
}

export function buildComposerDisplayText(payload: ComposerSubmitPayload): string {
  const text = payload.text.trim();
  const attachments = payload.attachments.map(attachmentDisplayName);
  if (attachments.length === 0) return text;
  const suffix = `附件：${attachments.join("、")}`;
  return text ? `${text}\n\n${suffix}` : suffix;
}

export async function prepareComposerPrompt(
  sessionId: string,
  payload: ComposerSubmitPayload,
  helpers: {
    uploadFile?(
      sessionId: string,
      file: File,
      onProgress?: (percent: number) => void,
    ): Promise<AttachmentUploadResult>;
    attachImage(sessionId: string, path: string): Promise<ImageAttachResult>;
    attachImageBytes?(
      sessionId: string,
      contentBase64: string,
      filename?: string,
    ): Promise<ImageAttachResult>;
    // True when attached to a remote gateway: it can't read this machine's
    // paths, so image bytes must be uploaded (matches the official desktop's
    // `remote ? attach_bytes : attach{path}`).
    remote?: boolean;
    // Read a local image file's bytes for remote upload (path-only attachments
    // such as drag-dropped files, which have no in-browser File to read).
    readImageBytes?(
      path: string,
    ): Promise<{ contentBase64: string; filename: string } | null>;
    detectDroppedPath(sessionId: string, path: string): Promise<InputDetectDropResult>;
    onAttachmentUpdate?(id: string, patch: Partial<ComposerAttachment>): void;
  },
  options: {
    transportText?: string;
  } = {},
): Promise<{
  promptText: string;
  displayText: string;
  displayImages: Array<{
    url?: string;
    alt?: string;
    title?: string;
    name?: string;
    mimeType?: string;
  }>;
}> {
  const parts: string[] = [];
  const displayImages: Array<{
    url?: string;
    alt?: string;
    title?: string;
    name?: string;
    mimeType?: string;
  }> = [];

  for (const attachment of payload.attachments) {
    try {
      let path = attachment.uploadedPath || attachment.path || "";
      let uploadedName = attachment.uploadedName;

      const looksLikeImage =
        attachment.kind === "image" ||
        (!!path && isImagePath(path)) ||
        (attachment.file?.type?.startsWith("image/") ?? false);

      // Images attach over the gateway. With a gateway-readable path we use
      // image.attach{path}; for an in-browser File (e.g. a pasted screenshot,
      // which has no real path) we send the bytes via image.attach_bytes. Both
      // return the same ImageAttachResult shape. This keeps images off the
      // fork-only REST /api/upload endpoint, which Core drops/restores across
      // upstream syncs — matching the official desktop's image-attach path.
      if (looksLikeImage) {
        let attached: ImageAttachResult;
        // Send bytes when there's no gateway-readable path (an in-browser File,
        // e.g. a pasted screenshot) OR when remote (the gateway can't read this
        // machine's paths). Otherwise pass the path. This mirrors the official
        // desktop's `remote ? attach_bytes : attach{path}`, extended to also
        // cover our pathless pasted Files.
        const useBytes = !path || !!helpers.remote;
        if (useBytes) {
          if (!helpers.attachImageBytes) {
            throw new Error("当前环境不支持上传这个图片附件");
          }
          helpers.onAttachmentUpdate?.(attachment.id, {
            status: "uploading",
            progress: 0,
            error: undefined,
          });
          let contentBase64 = "";
          let filename =
            attachment.file?.name ||
            (path ? fileNameFromPath(path) : attachment.name || "image.png");
          if (attachment.file) {
            const dataUrl = await readFileAsDataUrl(attachment.file);
            contentBase64 = dataUrl ? dataUrl.slice(dataUrl.indexOf(",") + 1) : "";
          } else if (path && helpers.readImageBytes) {
            const payload = await helpers.readImageBytes(path);
            if (payload) {
              contentBase64 = payload.contentBase64;
              filename = payload.filename;
            }
          }
          if (!contentBase64) {
            throw new Error("无法读取图片数据");
          }
          helpers.onAttachmentUpdate?.(attachment.id, { status: "processing", progress: 100 });
          attached = await helpers.attachImageBytes(sessionId, contentBase64, filename);
          if (attached.attached === false) {
            throw new Error(attached.text || "图片附件未能添加");
          }
          path = attached.path || path;
          uploadedName = attached.name || filename;
          helpers.onAttachmentUpdate?.(attachment.id, {
            source: "uploaded",
            uploadedPath: attached.path,
            uploadedName,
            path: attached.path,
            mimeType: attachment.mimeType,
          });
        } else {
          if (!path) {
            throw new Error("附件缺少可读取路径");
          }
          helpers.onAttachmentUpdate?.(attachment.id, { status: "processing" });
          attached = await helpers.attachImage(sessionId, path);
          if (attached.attached === false) {
            throw new Error(attached.text || "图片附件未能添加");
          }
        }

        if (attached.text?.trim()) {
          const label = attached.name || uploadedName || attachment.name || fileNameFromPath(path);
          parts.push([
            IMAGE_BLOCK_START,
            `name=${sanitizeContextValue(label)}`,
            "description:",
            attached.text.trim(),
            IMAGE_BLOCK_END,
          ].join("\n"));
        }
        const label = attached.name || uploadedName || attachment.name || fileNameFromPath(path);
        displayImages.push({
          url: await imageDisplayUrl(attachment, attached.path || path),
          alt: label,
          title: label,
          name: label,
          mimeType: attachment.mimeType,
        });
        helpers.onAttachmentUpdate?.(attachment.id, { status: "done", progress: 100 });
        continue;
      }

      // Non-image attachments. A browser File with no path still needs the REST
      // upload (uncommon in the desktop: pickers/drag supply real paths, paste
      // produces images).
      if (!path && attachment.file) {
        if (!helpers.uploadFile) {
          throw new Error("当前环境不支持上传这个附件");
        }
        helpers.onAttachmentUpdate?.(attachment.id, {
          status: "uploading",
          progress: 0,
          error: undefined,
        });
        const uploaded = await helpers.uploadFile(sessionId, attachment.file, (progress) => {
          helpers.onAttachmentUpdate?.(attachment.id, {
            status: "uploading",
            progress,
          });
        });
        path = uploaded.path;
        uploadedName = uploaded.filename;
        helpers.onAttachmentUpdate?.(attachment.id, {
          source: "uploaded",
          uploadedPath: uploaded.path,
          uploadedName: uploaded.filename,
          path: uploaded.path,
          size: uploaded.size,
          mimeType: uploaded.mime_type ?? attachment.mimeType,
          status: "processing",
          progress: 100,
        });
      }

      if (!path) {
        throw new Error("附件缺少可读取路径");
      }

      helpers.onAttachmentUpdate?.(attachment.id, { status: "processing" });
      if (attachment.kind === "directory") {
        parts.push(`[User attached directory: ${path}]`);
        helpers.onAttachmentUpdate?.(attachment.id, { status: "done", progress: 100 });
        continue;
      }

      const dropped = await helpers.detectDroppedPath(sessionId, path);
      if (dropped.matched && typeof dropped.text === "string" && dropped.text.trim()) {
        parts.push(dropped.text.trim());
      } else {
        parts.push(`[User attached file: ${path}]`);
      }
      helpers.onAttachmentUpdate?.(attachment.id, {
        status: "done",
        progress: 100,
        ...(uploadedName ? { uploadedName } : {}),
      });
    } catch (error) {
      throw new ComposerAttachmentError(messageFromError(error), attachment.id);
    }
  }

  const text = (options.transportText ?? payload.text).trim();
  if (text) parts.push(text);

  const workspace = buildWorkspaceContext(payload.workspacePath);
  if (workspace) parts.unshift(workspace);

  const promptText = parts.join("\n\n").trim();
  return {
    promptText,
    displayText: buildComposerDisplayText(payload),
    displayImages,
  };
}
