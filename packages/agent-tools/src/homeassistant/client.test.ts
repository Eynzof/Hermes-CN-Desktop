import { describe, it, expect } from "vitest";
import { HassClient } from "./client.js";
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

function errorResult(status: number, body: string | unknown): HaRequestResult {
  return {
    ok: false,
    status,
    statusText: "Error",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

describe("HassClient.listStates", () => {
  it("returns summarized entities", async () => {
    const client = new HassClient({
      url: "http://homeassistant.local:8123",
      token: "token",
      haRequest: mockHaRequest(async (input) => {
        expect(input.path).toBe("/api/states");
        expect(input.method).toBeUndefined();
        expect(input.headers?.Authorization).toBe("Bearer token");
        return okResult([
          {
            entity_id: "light.living_room",
            state: "on",
            attributes: { friendly_name: "Living Room" },
          },
        ]);
      }),
    });
    const result = await client.listStates();
    expect(result.count).toBe(1);
    expect(result.entities[0]).toEqual({
      entity_id: "light.living_room",
      state: "on",
      friendly_name: "Living Room",
    });
  });

  it("applies domain filter", async () => {
    const client = new HassClient({
      url: "http://homeassistant.local:8123",
      token: "token",
      haRequest: mockHaRequest(async () =>
        okResult([
          { entity_id: "light.a", state: "on", attributes: {} },
          { entity_id: "switch.b", state: "on", attributes: {} },
        ]),
      ),
    });
    const result = await client.listStates({ domain: "light" });
    expect(result.count).toBe(1);
    expect(result.entities[0].entity_id).toBe("light.a");
  });

  it("throws on HTTP error", async () => {
    const client = new HassClient({
      url: "http://homeassistant.local:8123",
      token: "token",
      haRequest: mockHaRequest(async () => errorResult(401, { message: "Unauthorized" })),
    });
    await expect(client.listStates()).rejects.toThrow("Unauthorized");
  });
});

describe("HassClient.getState", () => {
  it("fetches a single entity", async () => {
    const client = new HassClient({
      url: "http://homeassistant.local:8123",
      token: "token",
      haRequest: mockHaRequest(async (input) => {
        expect(input.path).toBe("/api/states/light.living_room");
        return okResult({ entity_id: "light.living_room", state: "on", attributes: {} });
      }),
    });
    const result = await client.getState("light.living_room");
    expect(result.entity_id).toBe("light.living_room");
  });

  it("rejects invalid entity ids", async () => {
    const client = new HassClient({
      url: "http://homeassistant.local:8123",
      token: "token",
    });
    await expect(client.getState("invalid")).rejects.toThrow("Invalid entity_id");
  });
});

describe("HassClient.listServices", () => {
  it("summarizes services", async () => {
    const client = new HassClient({
      url: "http://homeassistant.local:8123",
      token: "token",
      haRequest: mockHaRequest(async (input) => {
        expect(input.path).toBe("/api/services");
        return okResult({
          light: {
            turn_on: { description: "Turn on", fields: { brightness_pct: { description: "Brightness" } } },
          },
        });
      }),
    });
    const result = await client.listServices();
    expect(result.count).toBe(1);
    expect(result.domains[0].services.turn_on.fields).toEqual({
      brightness_pct: { description: "Brightness" },
    });
  });
});

describe("HassClient.callService", () => {
  it("calls a service and returns affected entities", async () => {
    const client = new HassClient({
      url: "http://homeassistant.local:8123",
      token: "token",
      haRequest: mockHaRequest(async (input) => {
        expect(input.path).toBe("/api/services/light/turn_on");
        expect(input.method).toBe("POST");
        expect(JSON.parse(input.body ?? "{}")).toEqual({ entity_id: "light.living_room" });
        return okResult([{ entity_id: "light.living_room", state: "on", attributes: {} }]);
      }),
    });
    const result = await client.callService("light", "turn_on", "light.living_room");
    expect(result).toEqual({
      success: true,
      service: "light.turn_on",
      affected_entities: [{ entity_id: "light.living_room", state: "on" }],
    });
  });

  it("rejects blocked domains", async () => {
    const client = new HassClient({
      url: "http://homeassistant.local:8123",
      token: "token",
    });
    await expect(client.callService("shell_command", "run", undefined, { command: "whoami" })).rejects.toThrow(
      "blocked",
    );
  });

  it("rejects invalid service names", async () => {
    const client = new HassClient({
      url: "http://homeassistant.local:8123",
      token: "token",
    });
    await expect(client.callService("light", "../turn_on")).rejects.toThrow("Invalid service name");
  });

  it("rejects invalid entity ids", async () => {
    const client = new HassClient({
      url: "http://homeassistant.local:8123",
      token: "token",
    });
    await expect(client.callService("light", "turn_on", "not valid")).rejects.toThrow("Invalid entity_id");
  });

  it("merges data payload with explicit entity_id", async () => {
    const client = new HassClient({
      url: "http://homeassistant.local:8123",
      token: "token",
      haRequest: mockHaRequest(async (input) => {
        expect(JSON.parse(input.body ?? "{}")).toEqual({ entity_id: "light.living_room", brightness_pct: 50 });
        return okResult([]);
      }),
    });
    await client.callService("light", "turn_on", "light.living_room", { brightness_pct: 50 });
  });
});

describe("HassClient fallback invoke", () => {
  it("uses ctx.invoke when haRequest is not provided", async () => {
    const client = new HassClient({
      url: "http://homeassistant.local:8123",
      token: "token",
      invoke: async (command, args) => {
        expect(command).toBe("ha_request");
        const input = (args as { input: HaRequestInput }).input;
        expect(input.path).toBe("/api/states");
        expect(input.headers?.Authorization).toBe("Bearer token");
        return okResult([{ entity_id: "light.a", state: "on", attributes: {} }]);
      },
    });
    const result = await client.listStates();
    expect(result.count).toBe(1);
  });
});
