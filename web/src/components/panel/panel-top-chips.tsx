import { useAtomValue } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { gwConnectionAtom } from "@/stores/chat";
import { useStatus } from "@/hooks/use-status";
import { useModelInfo } from "@/hooks/use-config";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { useLastUsedModel } from "@/lib/last-used-model";
import { Dot } from "@/components/ui/pill";
import s from "./panel-top-chips.module.css";

const DEFAULT_DESKTOP_DASHBOARD_PORT = "9120";

function portFromHealthUrl(url: string | null | undefined): string {
  if (!url) return DEFAULT_DESKTOP_DASHBOARD_PORT;
  try {
    return new URL(url).port || DEFAULT_DESKTOP_DASHBOARD_PORT;
  } catch {
    return DEFAULT_DESKTOP_DASHBOARD_PORT;
  }
}

export function PanelTopChips() {
  const { data: status } = useStatus();
  const { data: modelInfo } = useModelInfo();
  const lastUsedModel = useLastUsedModel();
  const connectionState = useAtomValue(gwConnectionAtom);
  const queryClient = useQueryClient();
  const profile = useActiveProfileName();

  // 网关 WebSocket 连接 open 即视为健康；status?.gateway_running 是 PTY
  // daemon 字段，与桌面端聊天链路无关（见 health-grid.tsx 注释）。
  const gatewayOk = connectionState === "open";
  const gatewayTone = gatewayOk ? "ok" : connectionState === "connecting" ? "warn" : "err";
  const gatewayPort = portFromHealthUrl(status?.gateway_health_url);

  // Match composer's "model that will be used" semantics: prefer user's last-used
  // selection, fall back to dashboard's effective default. Tag the source so the
  // user can tell whether the chip reflects their explicit choice or the global
  // default — both can show the same string but mean very different things when
  // troubleshooting (esp. when dashboard config drifts from UI selection).
  const modelChip = lastUsedModel?.model
    ? { text: `下次会话 ${lastUsedModel.model}`, title: "你最近一次在 composer 选的模型 — 下次发新会话时会用它" }
    : modelInfo?.model
      ? { text: `默认 ${modelInfo.model}`, title: "Dashboard 全局默认模型 — composer 未选其他模型时会用它" }
      : null;

  const onRefresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    void queryClient.invalidateQueries({ queryKey: ["status"] });
    void queryClient.invalidateQueries({ queryKey: ["analytics"] });
    void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
  };

  return (
    <>
      <span className={s.chip} title={`Gateway ${connectionState}`}>
        <Dot tone={gatewayTone} />
        Gateway {gatewayPort}
      </span>
      <span
        className={s.chip}
        title="当前 sticky default profile（前端记录值）。切换不会立即生效，需要重启 dashboard。"
      >
        profile {profile}
      </span>
      {modelChip && (
        <span className={s.chip} title={modelChip.title}>
          {modelChip.text}
        </span>
      )}
      <button className={s.refreshBtn} onClick={onRefresh} title="刷新" aria-label="刷新">
        ⟳
      </button>
    </>
  );
}
