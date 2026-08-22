import { describe, it, expect, beforeEach } from "vitest";
import { haListEntities, haGetState, haListServices, haCallService } from "./tools.js";
import { registry } from "../registry.js";
import "../catalog.js";
import type { ToolContext } from "../types.js";
import type { HaRequestFn, HaRequestInput, HaRequestResult } from "@hermes/protocol";

function mockHaRequest(
  handler: (input: HaRequestInput) => Promise<HaRequestResult>,
): HaRequestFn {
  return (input) => handler(input);
}

function okResult(body: unknown, status = 200): HaRequestResult {
  return {
    ok: true,
    status,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    env: {
      HASS_TOKEN: "hass-token",
      HASS_URL: "http://homeassistant.local:8123",
    },
    ...overrides,
  };
}

describe("haListEntities", () => {
  it("returns { result: summary } on success", async () => {
    const ctx = makeCtx({
      haRequest: mockHaRequest(async (input) => {
        expect(input.path).toBe("/api/states");
        return okResult([{ entity_id: "light.a", state: "on", attributes: { friendly_name: "A" } }]);
      }),
    });
    const result = await haListEntities({}, ctx);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content)).toEqual({
      result: {
        count: 1,
        entities: [{ entity_id: "light.a", state: "on", friendly_name: "A" }],
      },
    });
  });

  it("supports domain and area filters", async () => {
    const ctx = makeCtx({
      haRequest: mockHaRequest(async (input) => {
        expect(input.path).toBe("/api/states");
        return okResult([
          { entity_id: "light.kitchen", state: "on", attributes: { friendly_name: "Kitchen", area: "Kitchen" } },
          { entity_id: "switch.bedroom", state: "off", attributes: { friendly_name: "Bedroom", area: "Bedroom" } },
        ]);
      }),
    });
    const result = await haListEntities({ domain: "light", area: "kitchen" }, ctx);
    const parsed = JSON.parse(result.content);
    expect(parsed.result.count).toBe(1);
    expect(parsed.result.entities[0].entity_id).toBe("light.kitchen");
  });

  it("returns { error: ... } on network failure", async () => {
    const ctx = makeCtx({
      haRequest: mockHaRequest(async () => ({
        ok: false,
        status: 0,
        statusText: "Network Error",
        headers: {},
        body: "Home Assistant request failed: fetch failed",
      })),
    });
    const result = await haListEntities({}, ctx);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("failed");
  });
});

describe("haGetState", () => {
  it("requires entity_id", async () => {
    const result = await haGetState({}, makeCtx());
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("entity_id");
  });

  it("returns single entity state", async () => {
    const ctx = makeCtx({
      haRequest: mockHaRequest(async (input) => {
        expect(input.path).toBe("/api/states/light.living_room");
        return okResult({ entity_id: "light.living_room", state: "on", attributes: {} });
      }),
    });
    const result = await haGetState({ entity_id: "light.living_room" }, ctx);
    expect(JSON.parse(result.content)).toEqual({
      result: { entity_id: "light.living_room", state: "on", attributes: {} },
    });
  });
});

describe("haListServices", () => {
  it("returns summarized services", async () => {
    const ctx = makeCtx({
      haRequest: mockHaRequest(async (input) => {
        expect(input.path).toBe("/api/services");
        return okResult({
          light: {
            turn_on: { description: "Turn on", fields: {} },
          },
        });
      }),
    });
    const result = await haListServices({}, ctx);
    expect(JSON.parse(result.content).result.count).toBe(1);
  });
});

describe("haCallService", () => {
  it("requires domain and service", async () => {
    const result = await haCallService({ domain: "light" }, makeCtx());
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("service");
  });

  it("calls service with JSON-string data", async () => {
    const ctx = makeCtx({
      haRequest: mockHaRequest(async (input) => {
        expect(input.path).toBe("/api/services/light/turn_on");
        expect(JSON.parse(input.body ?? "{}")).toEqual({
          entity_id: "light.living_room",
          brightness_pct: 50,
        });
        return okResult([{ entity_id: "light.living_room", state: "on", attributes: {} }]);
      }),
    });
    const result = await haCallService(
      { domain: "light", service: "turn_on", entity_id: "light.living_room", data: '{"brightness_pct": 50}' },
      ctx,
    );
    expect(JSON.parse(result.content)).toEqual({
      result: {
        success: true,
        service: "light.turn_on",
        affected_entities: [{ entity_id: "light.living_room", state: "on" }],
      },
    });
  });

  it("rejects blocked domains as errors", async () => {
    const result = await haCallService(
      { domain: "shell_command", service: "run", data: '{"command": "whoami"}' },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("blocked");
  });
});

describe("registration", () => {
  beforeEach(() => {
    // catalog.ts auto-registers on import; registry persists across tests.
  });

  it.each(["ha_list_entities", "ha_get_state", "ha_list_services", "ha_call_service"])(
    "%s is registered",
    (name) => {
      expect(registry.has(name)).toBe(true);
      const entry = registry.get(name);
      expect(entry?.toolset).toBe("homeassistant");
      expect(entry?.emoji).toBe("🏠");
      expect(entry?.checkFn).toBeDefined();
    },
  );
});
