import { useCallback } from "react";
import { useSetAtom } from "jotai";
import { useNavigate } from "react-router-dom";
import { useGateway } from "@/hooks/use-gateway";
import { useModelInfo } from "@/hooks/use-config";
import type {
  ComposerSubmitControls,
  ComposerSubmitPayload,
} from "@/components/chat/composer-types";
import { activeSessionIdAtom } from "@/stores/ui";
import { buildComposerDisplayText, prepareComposerPrompt } from "@/lib/composer-prompt";
import { resolveComposerSkillCommand } from "@/lib/composer-skills";
import { rememberSessionModelOverride } from "@/lib/session-model-override";
import { titleFromPrompt, titleWithSessionSuffix } from "@/lib/session-title";
import { isRemoteConnection, readImageBytesFromPath, uploadAttachmentFile } from "@/lib/transport";
import type { CreateSessionOptions } from "@/lib/session-create";
import {
  rememberSessionWorkspace,
  rememberWorkspaceProject,
} from "@/lib/workspaces";

interface CreateAndSendOptions {
  createSession?: (options?: CreateSessionOptions) => Promise<string>;
}

export function useCreateAndSendSession() {
  const navigate = useNavigate();
  const {
    createSession,
    beginPrompt,
    failPrompt,
    sendPrompt,
    setSessionTitle,
    dispatchCommand,
    attachImage,
    attachImageBytes,
    detectDroppedPath,
  } = useGateway();
  const { data: modelInfo } = useModelInfo();
  const setActiveSessionId = useSetAtom(activeSessionIdAtom);

  return useCallback(async (
    payload: ComposerSubmitPayload,
    controls: ComposerSubmitControls,
    options?: CreateAndSendOptions,
  ) => {
    const submittedAt = Date.now();
    const workspacePath = payload.workspacePath?.trim() || undefined;
    const requestedModel = payload.modelSelection?.model ?? modelInfo?.model;
    const requestedProvider = payload.modelSelection?.provider ?? modelInfo?.provider;
    const sessionId = await (options?.createSession ?? createSession)({
      cwd: workspacePath,
      model: requestedModel,
      provider: requestedProvider,
    });
    const title = titleFromPrompt(payload.text || payload.attachments[0]?.name || "");
    const optimisticDisplayText = buildComposerDisplayText(payload);
    const optimisticDisplayImages = payload.attachments
      .filter((attachment) => attachment.kind === "image")
      .map((attachment) => ({
        url: attachment.previewUrl && !attachment.previewUrl.startsWith("blob:")
          ? attachment.previewUrl
          : attachment.path,
        alt: attachment.name,
        title: attachment.name,
        name: attachment.name,
        mimeType: attachment.mimeType,
      }));

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
          remote: isRemoteConnection(),
          readImageBytes: readImageBytesFromPath,
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
    beginPrompt,
    createSession,
    detectDroppedPath,
    dispatchCommand,
    failPrompt,
    modelInfo?.model,
    modelInfo?.provider,
    navigate,
    sendPrompt,
    setActiveSessionId,
    setSessionTitle,
  ]);
}
