import { useCallback } from "react";
import { useSetAtom } from "jotai";
import { useNavigate } from "react-router-dom";
import { useGateway } from "@/hooks/use-gateway";
import type {
  ComposerSubmitControls,
  ComposerSubmitPayload,
} from "@/components/chat/composer-types";
import { activeSessionIdAtom } from "@/stores/ui";
import { buildComposerDisplayText, prepareComposerPrompt } from "@/lib/composer-prompt";
import { resolveComposerSkillCommand } from "@/lib/composer-skills";
import { rememberSessionModelOverride } from "@/lib/session-model-override";
import { titleFromPrompt, titleWithSessionSuffix } from "@/lib/session-title";
import { isRemoteConnection, readFileDataUrl, readImageBytesFromPath, uploadAttachmentFile } from "@/lib/transport";
import {
  rememberSessionWorkspace,
  rememberWorkspaceProject,
} from "@/lib/workspaces";

interface CreateAndSendOptions {
  createSession?: (options?: { cwd?: string }) => Promise<string>;
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

export function useCreateAndSendSession() {
  const navigate = useNavigate();
  const {
    createSession,
    beginPrompt,
    failPrompt,
    sendPrompt,
    setSessionTitle,
    setSessionModel,
    setSessionReasoningEffort,
    dispatchCommand,
    attachImage,
    attachImageBytes,
    attachFile,
    detectDroppedPath,
  } = useGateway();
  const setActiveSessionId = useSetAtom(activeSessionIdAtom);

  return useCallback(async (
    payload: ComposerSubmitPayload,
    controls: ComposerSubmitControls,
    options?: CreateAndSendOptions,
  ) => {
    const submittedAt = Date.now();
    const workspacePath = payload.workspacePath?.trim() || undefined;
    const sessionId = await (options?.createSession ?? createSession)({ cwd: workspacePath });
    const title = titleFromPrompt(payload.text || payload.attachments[0]?.name || "");
    const optimisticDisplayText = buildComposerDisplayText(payload);
    const optimisticDisplayImages = await Promise.all(payload.attachments
      .filter((attachment) => attachment.kind === "image")
      .map(async (attachment) => ({
        url: attachment.file
          ? await readFileAsDataUrl(attachment.file)
          : attachment.previewUrl || attachment.path,
        alt: attachment.name,
        title: attachment.name,
        name: attachment.name,
        mimeType: attachment.mimeType,
      })));

    if (payload.modelSelection?.model) {
      rememberSessionModelOverride(sessionId, payload.modelSelection);
    }
    if (workspacePath) {
      rememberWorkspaceProject(workspacePath);
      rememberSessionWorkspace(sessionId, workspacePath);
    }

    beginPrompt(sessionId, optimisticDisplayText, submittedAt, optimisticDisplayImages);
    setActiveSessionId(sessionId);
    navigate(`/tasks/${sessionId}`);

    void (async () => {
      try {
        if (payload.modelSelection?.model) {
          // Composer selection is the user's explicit source of truth.  Do not
          // skip this just because /api/model/info already reports the same
          // model: that REST value comes from config.yaml, while the live
          // gateway process may still carry an older HERMES_MODEL or a
          // prewarmed draft session built before the config save.
          await setSessionModel(
            sessionId,
            payload.modelSelection.model,
            payload.modelSelection.provider,
          );
        }
        if (payload.reasoningEffort) {
          await setSessionReasoningEffort(sessionId, payload.reasoningEffort);
        }
        let transportText: string | undefined;
        const skillCommand = resolveComposerSkillCommand(
          payload.text,
          payload.skillCommandNames,
        );
        if (skillCommand) {
          const dispatched = await dispatchCommand(
            sessionId,
            skillCommand.name,
            skillCommand.arg,
          );
          if (dispatched.type === "skill" && dispatched.message?.trim()) {
            transportText = dispatched.message;
          }
        }
        const prepared = await prepareComposerPrompt(sessionId, payload, {
          attachImage,
          attachImageBytes,
          attachFile,
          remote: isRemoteConnection(),
          readImageBytes: readImageBytesFromPath,
          readFileDataUrl,
          detectDroppedPath,
          uploadFile: uploadAttachmentFile,
          onAttachmentUpdate: controls.updateAttachment,
        }, { transportText });
        await sendPrompt(sessionId, prepared.promptText, {
          displayText: prepared.displayText,
          displayImages: prepared.displayImages,
          skipOptimisticStart: true,
        });
      } catch (err) {
        console.error("Failed to submit session:", err);
        failPrompt(sessionId, err);
      }
    })();

    if (title) {
      void setSessionTitle(sessionId, title).catch((titleError) => {
        const fallbackTitle = titleWithSessionSuffix(title, sessionId);
        if (!fallbackTitle || fallbackTitle === title) {
          console.warn("Failed to set session title:", titleError);
          return;
        }
        void setSessionTitle(sessionId, fallbackTitle).catch(() => {
          console.warn("Failed to set fallback session title:", titleError);
        });
      });
    }

    return sessionId;
  }, [
    attachImage,
    attachImageBytes,
    attachFile,
    beginPrompt,
    createSession,
    detectDroppedPath,
    dispatchCommand,
    failPrompt,
    navigate,
    sendPrompt,
    setActiveSessionId,
    setSessionModel,
    setSessionReasoningEffort,
    setSessionTitle,
  ]);
}
