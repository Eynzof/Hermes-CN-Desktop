import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { deleteJSON, fetchJSON, postJSON } from "@/lib/transport";
import { openExternalUrl } from "@/lib/external-links";
import { reloadMcp } from "./use-mcp";

interface McpOAuthFlow {
  flow_id: string;
  status: "starting" | "authorization_required" | "approved" | "error";
  authorization_url?: string | null;
  error?: string | null;
}
const flowPath = (id: string) => `/api/mcp/oauth/flows/${encodeURIComponent(id)}`;

export function useMcpOAuth(name: string) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<"authorize" | "logout" | null>(null);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const flowId = useRef<string | null>(null);
  const cancel = async () => {
    generation.current += 1;
    const id = flowId.current;
    flowId.current = null;
    setPhase(null);
    setMessage("授权已取消");
    if (id) {
      try { await deleteJSON(flowPath(id)); }
      catch (error) { setMessage(error instanceof Error ? error.message : "取消授权失败"); }
    }
  };
  useEffect(() => () => {
    generation.current += 1;
    const id = flowId.current;
    flowId.current = null;
    if (id) void deleteJSON(flowPath(id)).catch(() => {});
  }, [name]);

  const authorize = async (): Promise<boolean> => {
    const run = ++generation.current;
    setPhase("authorize");
    setMessage("正在发起授权…");
    try {
      let flow = await postJSON<McpOAuthFlow>(`/api/mcp/servers/${encodeURIComponent(name)}/auth`, {});
      if (run !== generation.current) {
        await deleteJSON(flowPath(flow.flow_id));
        return false;
      }
      flowId.current = flow.flow_id;
      let opened = false;
      while (run === generation.current) {
        if (flow.status === "error") throw new Error(flow.error || "授权失败");
        if (flow.status === "approved") {
          flowId.current = null;
          setMessage("授权成功");
          await qc.invalidateQueries({ queryKey: ["mcp-servers-full"] });
          return true;
        }
        if (flow.authorization_url && !opened) {
          await openExternalUrl(flow.authorization_url);
          opened = true;
          setMessage("请在浏览器中完成授权");
        }
        await new Promise(resolve => window.setTimeout(resolve, 1000));
        if (run !== generation.current) return false;
        flow = await fetchJSON<McpOAuthFlow>(flowPath(flow.flow_id));
      }
    } catch (error) {
      if (run === generation.current) setMessage(error instanceof Error ? error.message : "授权失败");
    } finally {
      if (run === generation.current) setPhase(null);
    }
    return false;
  };

  const logout = async () => {
    setPhase("logout");
    try {
      await deleteJSON(`/api/mcp/servers/${encodeURIComponent(name)}/auth`);
      await reloadMcp();
      await qc.invalidateQueries({ queryKey: ["mcp-servers-full"] });
      setMessage("已退出登录并禁用服务");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "退出登录失败");
    } finally { setPhase(null); }
  };
  return { busy: phase !== null, authorizing: phase === "authorize", message, authorize, cancel, logout };
}
