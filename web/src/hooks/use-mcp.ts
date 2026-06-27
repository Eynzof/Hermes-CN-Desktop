import { getDefaultStore } from "jotai";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteJSON, fetchJSON, postJSON, putJSON } from "@/lib/transport";
import { getGatewayClient } from "@/lib/gateway-client";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { gwSessionIdAtom } from "@/stores/chat";
import {
  McpCatalogInstallResponse,
  McpCatalogResponse,
  McpEnabledResponse,
  McpServer,
  McpServerCreate,
  McpServersFullResponse,
  McpTestResult,
  MutationOkResponse,
} from "@hermes/protocol";

// 桌面版的 MCP 管理直接打官方上游接口 /api/mcp/*（增删改 / 启停 / 测试 / 目录），
// 与只读的 fork 端点 /api/mcp-servers（health 面板用）相互独立。

const SERVERS_KEY = "mcp-servers-full";
const CATALOG_KEY = "mcp-catalog";

const mcpPath = (name: string, suffix = "") =>
  `/api/mcp/servers/${encodeURIComponent(name)}${suffix}`;

// GET /api/mcp/servers — 完整服务列表（env 已脱敏）。queryKey 含 profile，
// 与 use-mcp-servers / use-profiles 的 profile-aware 失效保持一致。
export function useMcpServersFull() {
  const profile = useActiveProfileName();
  return useQuery<McpServer[]>({
    queryKey: [SERVERS_KEY, profile],
    queryFn: async ({ signal }) => {
      const r = await fetchJSON("/api/mcp/servers", { signal }, McpServersFullResponse);
      return r.servers;
    },
    staleTime: 30_000,
  });
}

// GET /api/mcp/catalog — Nous 官方目录 + 诊断。
export function useMcpCatalog() {
  const profile = useActiveProfileName();
  return useQuery<McpCatalogResponse>({
    queryKey: [CATALOG_KEY, profile],
    queryFn: ({ signal }) => fetchJSON("/api/mcp/catalog", { signal }, McpCatalogResponse),
    staleTime: 60_000,
  });
}

export function useAddMcpServer() {
  const qc = useQueryClient();
  return useMutation<McpServer, Error, McpServerCreate>({
    mutationFn: (body) => postJSON("/api/mcp/servers", body, McpServer),
    onSuccess: () => qc.invalidateQueries({ queryKey: [SERVERS_KEY] }),
  });
}

export function useRemoveMcpServer() {
  const qc = useQueryClient();
  return useMutation<MutationOkResponse, Error, string>({
    mutationFn: (name) => deleteJSON(mcpPath(name), undefined, MutationOkResponse),
    onSuccess: () => qc.invalidateQueries({ queryKey: [SERVERS_KEY] }),
  });
}

export interface SetMcpEnabledInput {
  name: string;
  enabled: boolean;
}

export function useSetMcpEnabled() {
  const qc = useQueryClient();
  return useMutation<McpEnabledResponse, Error, SetMcpEnabledInput>({
    mutationFn: ({ name, enabled }) =>
      putJSON(mcpPath(name, "/enabled"), { enabled }, McpEnabledResponse),
    onSuccess: () => qc.invalidateQueries({ queryKey: [SERVERS_KEY] }),
  });
}

// 测试连接：后端连服务、列工具、断开。OAuth 服务会在这里触发浏览器授权。
// 不进 query 缓存——结果由调用方按服务名自行存。
export function useTestMcpServer() {
  return useMutation<McpTestResult, Error, string>({
    mutationFn: (name) => postJSON(mcpPath(name, "/test"), {}, McpTestResult),
  });
}

export interface InstallCatalogInput {
  name: string;
  env?: Record<string, string>;
  enable?: boolean;
}

export function useInstallCatalogEntry() {
  const qc = useQueryClient();
  return useMutation<McpCatalogInstallResponse, Error, InstallCatalogInput>({
    mutationFn: ({ name, env, enable = true }) =>
      postJSON(
        "/api/mcp/catalog/install",
        { name, env: env ?? {}, enable },
        McpCatalogInstallResponse,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [SERVERS_KEY] });
      qc.invalidateQueries({ queryKey: [CATALOG_KEY] });
    },
  });
}

export interface ReloadMcpResult {
  status: string;
  message?: string;
}

// 触发官方 reload.mcp（WS JSON-RPC，无 REST 版）。增删改 / 启停后调用即可让改动
// 即时生效：handler 内部全局 shutdown_mcp_servers() + discover_mcp_tools()，再刷新
// 当前会话的工具快照。settings 页通常没有活跃会话，session_id 传空字符串即触发
// 全局重连，下次会话自然用上新配置。confirm:true 跳过会话级确认门。
export async function reloadMcp(): Promise<ReloadMcpResult> {
  const sessionId = getDefaultStore().get(gwSessionIdAtom) ?? "";
  return getGatewayClient().request<ReloadMcpResult>("reload.mcp", {
    session_id: sessionId,
    confirm: true,
  });
}
