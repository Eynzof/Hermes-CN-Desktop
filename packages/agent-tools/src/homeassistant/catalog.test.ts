import { describe, expect, it, vi } from "vitest";
import "./catalog.js";
import { registry } from "../registry.js";
import type { HaRequestInput } from "@hermes/protocol";

const TOOL_NAMES = ["ha_list_entities", "ha_get_state", "ha_list_services", "ha_call_service"];

function haOk(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: {},
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

const baseCtx = {
  env: { HOME_ASSISTANT_TOKEN: "tok", HASS_URL: "http://ha.local:8123" },
};

describe("homeassistant catalog registration", () => {
  it("registers the four HA tools under the homeassistant toolset", () => {
    for (const name of TOOL_NAMES) {
      const entry = registry.get(name);
      expect(entry, `expected ${name}`).toBeDefined();
      expect(entry!.toolset).toBe("homeassistant");
      expect(entry!.checkFn).toBeTypeOf("function");
      expect(entry!.handler).toBeTypeOf("function");
      expect(entry!.tags).toContain("ha");
    }
  });

  it("builds schemas with the expected required fields", () => {
    const getState = registry.get("ha_get_state")!.schema;
    expect(getState.required).toEqual(["entity_id"]);

    const callService = registry.get("ha_call_service")!.schema;
    expect(callService.required).toEqual(["domain", "service"]);

    // Optional-only tools have an empty required list.
    const listEntities = registry.get("ha_list_entities")!.schema;
    expect(listEntities.required).toEqual([]);
    expect(listEntities.properties).toHaveProperty("domain");
    expect(listEntities.properties).toHaveProperty("area");
  });
});

describe("homeassistant tool dispatch", () => {
  it("ha_get_state requires entity_id without touching the network", async () => {
    const res = await registry.dispatch("ha_get_state", {}, baseCtx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("entity_id is required");
  });

  it("ha_get_state returns the entity state through haRequest", async () => {
    const haRequest = vi.fn(async (_input: HaRequestInput) =>
      haOk({ entity_id: "light.living_room", state: "on" }),
    );
    const res = await registry.dispatch(
      "ha_get_state",
      { entity_id: "light.living_room" },
      { ...baseCtx, haRequest },
    );
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content);
    expect(parsed.result.entity_id).toBe("light.living_room");
    expect(parsed.result.state).toBe("on");
    expect(haRequest).toHaveBeenCalledTimes(1);
    expect(haRequest.mock.calls[0][0].path).toBe("/api/states/light.living_room");
    expect(haRequest.mock.calls[0][0].headers?.Authorization).toBe("Bearer tok");
  });

  it("ha_list_entities lists states with domain/area filters", async () => {
    const haRequest = vi.fn(async (_input: HaRequestInput) =>
      haOk([
        { entity_id: "light.a", state: "on" },
        { entity_id: "switch.b", state: "off" },
      ]),
    );
    const res = await registry.dispatch(
      "ha_list_entities",
      { domain: "light" },
      { ...baseCtx, haRequest },
    );
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content);
    expect(parsed.result).toBeDefined();
    expect(haRequest.mock.calls[0][0].path).toBe("/api/states");
  });

  it("ha_call_service requires domain and service", async () => {
    const res1 = await registry.dispatch("ha_call_service", { service: "turn_on" }, baseCtx);
    expect(res1.isError).toBe(true);
    expect(res1.content).toContain("domain is required");

    const res2 = await registry.dispatch("ha_call_service", { domain: "light" }, baseCtx);
    expect(res2.isError).toBe(true);
    expect(res2.content).toContain("service is required");
  });

  it("ha_call_service posts parsed data and entity_id", async () => {
    const haRequest = vi.fn(async (_input: HaRequestInput) => haOk([{ entity_id: "light.a", state: "on" }]));
    const res = await registry.dispatch(
      "ha_call_service",
      { domain: "light", service: "turn_on", entity_id: "light.a", data: '{"brightness_pct": 50}' },
      { ...baseCtx, haRequest },
    );
    expect(res.isError).toBeFalsy();
    const call = haRequest.mock.calls[0][0];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/services/light/turn_on");
    expect(JSON.parse(call.body ?? "")).toEqual({ brightness_pct: 50, entity_id: "light.a" });
  });

  it("fails cleanly when no token is configured", async () => {
    const res = await registry.dispatch("ha_get_state", { entity_id: "light.a" }, { env: {} });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("HASS_TOKEN is not configured");
  });

  it("surfaces HA HTTP errors as tool errors", async () => {
    const haRequest = vi.fn(async (_input: HaRequestInput) => haOk({ message: "unauthorized" }, 401));
    const res = await registry.dispatch("ha_get_state", { entity_id: "light.a" }, { ...baseCtx, haRequest });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("401");
  });
});
