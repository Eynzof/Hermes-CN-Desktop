import { describe, expect, it } from "vitest";
import {
  classifyGatewayActionStatus,
  gatewayRestartButtonLabel,
  gatewayRestartResponseError,
  gatewayRestartTitle,
  isGatewayRestartBusy,
  isGatewayRestartLocked,
  isGatewayRestartObservedRunning,
  type GatewayActionStatusResponse,
} from "./gateway-restart";

function status(overrides: Partial<GatewayActionStatusResponse>): GatewayActionStatusResponse {
  return {
    name: "gateway-restart",
    running: false,
    exit_code: 0,
    pid: null,
    lines: [],
    ...overrides,
  };
}

describe("gateway restart helpers", () => {
  it("marks starting and running phases as busy", () => {
    expect(isGatewayRestartBusy("idle")).toBe(false);
    expect(isGatewayRestartBusy("starting")).toBe(true);
    expect(isGatewayRestartBusy("running")).toBe(true);
    expect(isGatewayRestartBusy("success")).toBe(false);
    expect(isGatewayRestartBusy("error")).toBe(false);
  });

  it("keeps the button locked through the post-restart success cooldown", () => {
    expect(isGatewayRestartLocked("idle")).toBe(false);
    expect(isGatewayRestartLocked("starting")).toBe(true);
    expect(isGatewayRestartLocked("running")).toBe(true);
    expect(isGatewayRestartLocked("success")).toBe(true);
    expect(isGatewayRestartLocked("error")).toBe(false);
  });

  it("builds compact button labels and titles", () => {
    expect(gatewayRestartButtonLabel("idle")).toBe("重启");
    expect(gatewayRestartButtonLabel("running")).toBe("重启中…");
    expect(gatewayRestartButtonLabel("success")).toBe("已完成");
    expect(gatewayRestartButtonLabel("error")).toBe("重试");
    expect(gatewayRestartTitle("running", "自定义状态")).toBe("自定义状态");
  });

  it("classifies running and successful action status", () => {
    expect(classifyGatewayActionStatus(status({ running: true, pid: 1234 }))).toEqual({
      done: false,
      ok: false,
      message: "Gateway 重启中（PID 1234）…",
    });
    expect(classifyGatewayActionStatus(status({ running: false, exit_code: 0 }))).toEqual({
      done: true,
      ok: true,
      message: "Gateway 重启已完成",
    });
  });

  it("classifies missing exit code as a completed fire-and-forget action", () => {
    expect(classifyGatewayActionStatus(status({ running: false, exit_code: null }))).toEqual({
      done: true,
      ok: true,
      message: "Gateway 重启已完成",
    });
  });

  it("classifies non-zero exit code as failure", () => {
    expect(classifyGatewayActionStatus(status({ running: false, exit_code: 75 }))).toEqual({
      done: true,
      ok: false,
      message: "Gateway 重启失败（exit 75）",
    });
  });

  it("treats a foreground gateway process as completed once /api/status sees it running", () => {
    const action = status({ running: true, pid: 33560 });
    expect(isGatewayRestartObservedRunning(action, {
      gateway_running: true,
      gateway_pid: 33560,
      gateway_state: "running",
    })).toBe(true);
    expect(isGatewayRestartObservedRunning(action, {
      gateway_running: true,
      gateway_pid: 98288,
      gateway_state: "running",
    })).toBe(false);
    expect(isGatewayRestartObservedRunning(action, {
      gateway_running: false,
      gateway_pid: 33560,
      gateway_state: "stopped",
    })).toBe(false);
  });

  it("extracts structured restart response errors", () => {
    expect(gatewayRestartResponseError({ ok: true })).toBeNull();
    expect(gatewayRestartResponseError({ ok: false, message: "无法重启" })).toBe("无法重启");
    expect(gatewayRestartResponseError({ ok: false, error: "failed" })).toBe("failed");
  });
});
