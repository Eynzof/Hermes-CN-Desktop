import type { TestConnectionResult } from "@hermes/protocol";

export interface ExternalConnectionHealthSummary {
  ok: boolean;
  title: string;
  detail: string;
}

const FAILED_TITLE = "外部 Hermes Agent 网关未启动或连接失败";

export function summarizeExternalConnectionHealth(
  result: TestConnectionResult,
): ExternalConnectionHealthSummary {
  if (result.ok) {
    const version = result.version ? `Hermes ${result.version}` : "Hermes Agent";
    return {
      ok: true,
      title: "外部 Hermes Agent 连接正常",
      detail: `${version} · HTTP 与实时网关均可用`,
    };
  }

  const rawDetail = result.error?.trim();
  if (result.httpOk && !result.wsOk) {
    return {
      ok: false,
      title: FAILED_TITLE,
      detail:
        rawDetail ||
        "Dashboard 可以访问，但实时网关连接失败。请确认目标 Hermes Agent 的网关已启动，并检查 Token、代理或防火墙。",
    };
  }

  return {
    ok: false,
    title: FAILED_TITLE,
    detail:
      rawDetail ||
      "无法访问目标 Hermes Agent。请确认目标地址正确，并先在目标机器上启动 Hermes Dashboard 与网关。",
  };
}

export function externalConnectionFailureSummary(error: unknown): ExternalConnectionHealthSummary {
  const detail = error instanceof Error ? error.message : String(error || "连接检测失败");
  return {
    ok: false,
    title: FAILED_TITLE,
    detail,
  };
}
