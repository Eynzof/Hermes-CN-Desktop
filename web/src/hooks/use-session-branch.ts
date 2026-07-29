import { useCallback, useState } from "react";
import { useSetAtom } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type { SessionSummary, SessionsResponse } from "@hermes/protocol";
import { activeSessionIdAtom } from "@/stores/ui";
import { useGateway } from "@/hooks/use-gateway";
import { fetchSessionMessages } from "@/hooks/use-sessions";
import { sessionBranchMessages, withOptimisticBranch } from "@/lib/session-branch";
import { rememberSessionWorkspace } from "@/lib/workspaces";

export interface UseSessionBranch {
  branchSession: (session: SessionSummary) => Promise<string | null>;
  branchingSessionId: string | null;
  error: string;
  clearError: () => void;
}

export function useSessionBranch(): UseSessionBranch {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setActiveSessionId = useSetAtom(activeSessionIdAtom);
  const { createBranchSession } = useGateway();
  const [branchingSessionId, setBranchingSessionId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const clearError = useCallback(() => setError(""), []);

  const branchSession = useCallback(async (session: SessionSummary): Promise<string | null> => {
    if (branchingSessionId) return null;
    setBranchingSessionId(session.id);
    setError("");

    try {
      const response = await fetchSessionMessages(session.id);
      const messages = sessionBranchMessages(response);
      if (messages.length === 0) {
        throw new Error("当前会话没有可用于分叉的对话内容");
      }

      const created = await createBranchSession({
        parentSessionId: session.id,
        cwd: session.cwd,
        messages,
      });
      const startedAt = Date.now() / 1000;
      const preview = messages.find((message) => message.role === "user")?.content;
      const branch: SessionSummary = {
        id: created.storedSessionId,
        parent_session_id: session.id,
        source: "desktop",
        user_id: session.user_id,
        model: session.model,
        title: "草稿：分叉",
        preview,
        cwd: session.cwd,
        started_at: startedAt,
        ended_at: null,
        end_reason: null,
        message_count: messages.length,
        input_tokens: 0,
        output_tokens: 0,
        estimated_cost_usd: null,
        is_active: false,
      };

      queryClient.setQueriesData<SessionsResponse>({ queryKey: ["sessions"] }, (data) =>
        withOptimisticBranch(data, branch),
      );
      if (session.cwd) {
        rememberSessionWorkspace(created.storedSessionId, session.cwd);
      }
      setActiveSessionId(created.storedSessionId);
      navigate(`/tasks/${encodeURIComponent(created.storedSessionId)}`);
      return created.storedSessionId;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "会话分叉失败");
      return null;
    } finally {
      setBranchingSessionId(null);
    }
  }, [
    branchingSessionId,
    createBranchSession,
    navigate,
    queryClient,
    setActiveSessionId,
  ]);

  return {
    branchSession,
    branchingSessionId,
    error,
    clearError,
  };
}
