import { describe, it, expect } from "vitest";
import {
  filterAndSummarize,
  buildServicePayload,
  parseServiceResponse,
  summarizeServices,
  type HassState,
} from "./format.js";

describe("filterAndSummarize", () => {
  const states: HassState[] = [
    {
      entity_id: "light.living_room",
      state: "on",
      attributes: { friendly_name: "Living Room", area: "Living Room" },
    },
    {
      entity_id: "light.kitchen",
      state: "off",
      attributes: { friendly_name: "Kitchen Lights", area: "Kitchen" },
    },
    {
      entity_id: "switch.kitchen",
      state: "on",
      attributes: { friendly_name: "Coffee Maker", area: "Kitchen" },
    },
    {
      entity_id: "sensor.outside_temp",
      state: "21.5",
      attributes: { friendly_name: "Outside Temperature" },
    },
  ];

  it("summarizes all entities when no filter is given", () => {
    const result = filterAndSummarize(states);
    expect(result.count).toBe(4);
    expect(result.entities[0]).toEqual({
      entity_id: "light.living_room",
      state: "on",
      friendly_name: "Living Room",
    });
  });

  it("filters by domain", () => {
    const result = filterAndSummarize(states, { domain: "light" });
    expect(result.count).toBe(2);
    expect(result.entities.map((e) => e.entity_id)).toEqual(["light.living_room", "light.kitchen"]);
  });

  it("filters by area case-insensitively", () => {
    const result = filterAndSummarize(states, { area: "kitchen" });
    expect(result.count).toBe(2);
    expect(result.entities.map((e) => e.entity_id)).toEqual(["light.kitchen", "switch.kitchen"]);
  });

  it("filters by friendly_name substring", () => {
    const result = filterAndSummarize(states, { area: "living" });
    expect(result.count).toBe(1);
    expect(result.entities[0].entity_id).toBe("light.living_room");
  });

  it("combines domain and area filters", () => {
    const result = filterAndSummarize(states, { domain: "light", area: "kitchen" });
    expect(result.count).toBe(1);
    expect(result.entities[0].entity_id).toBe("light.kitchen");
  });

  it("falls back to entity_id when friendly_name is missing", () => {
    const result = filterAndSummarize([
      { entity_id: "sensor.unknown", state: "42", attributes: {} },
    ]);
    expect(result.entities[0].friendly_name).toBe("sensor.unknown");
  });
});

describe("buildServicePayload", () => {
  it("returns empty payload when only domain/service are provided", () => {
    const result = buildServicePayload("light", "turn_on");
    expect(result).toEqual({ domain: "light", service: "turn_on", payload: {} });
  });

  it("explicit entity_id wins over data.entity_id", () => {
    const result = buildServicePayload("light", "turn_on", "light.living_room", {
      entity_id: "light.kitchen",
      brightness_pct: 50,
    });
    expect(result.payload).toEqual({
      entity_id: "light.living_room",
      brightness_pct: 50,
    });
  });

  it("uses data.entity_id when no explicit entity_id is given", () => {
    const result = buildServicePayload("light", "turn_on", undefined, { entity_id: "light.kitchen" });
    expect(result.payload).toEqual({ entity_id: "light.kitchen" });
  });

  it("copies arbitrary data fields", () => {
    const result = buildServicePayload("climate", "set_temperature", undefined, {
      temperature: 22,
      hvac_mode: "cool",
    });
    expect(result.payload).toEqual({ temperature: 22, hvac_mode: "cool" });
  });
});

describe("parseServiceResponse", () => {
  it("extracts affected entities from state array", () => {
    const response = [
      { entity_id: "light.living_room", state: "on", attributes: {} },
      { entity_id: "light.kitchen", state: "on", attributes: {} },
    ];
    const result = parseServiceResponse("light", "turn_on", response);
    expect(result).toEqual({
      success: true,
      service: "light.turn_on",
      affected_entities: [
        { entity_id: "light.living_room", state: "on" },
        { entity_id: "light.kitchen", state: "on" },
      ],
    });
  });

  it("returns empty affected_entities for empty response", () => {
    const result = parseServiceResponse("persistent_notification", "create", []);
    expect(result).toEqual({
      success: true,
      service: "persistent_notification.create",
      affected_entities: [],
    });
  });

  it("returns empty affected_entities for non-array response", () => {
    const result = parseServiceResponse("light", "turn_on", { message: "ok" });
    expect(result.affected_entities).toEqual([]);
  });

  it("skips malformed state objects", () => {
    const response = [
      { entity_id: "light.living_room", state: "on", attributes: {} },
      { state: "bad" },
      "not an object",
    ];
    const result = parseServiceResponse("light", "turn_on", response);
    expect(result.affected_entities).toEqual([{ entity_id: "light.living_room", state: "on" }]);
  });
});

describe("summarizeServices", () => {
  const services = {
    light: {
      turn_on: {
        description: "Turn a light on",
        fields: {
          brightness_pct: { description: "Brightness percentage", name: "Brightness" },
        },
      },
      turn_off: { description: "Turn a light off", fields: {} },
    },
    switch: {
      turn_on: {
        description: "Turn a switch on",
        fields: {
          transition: { description: "Transition time", name: "Transition" },
        },
      },
    },
  };

  it("compacts services to descriptions and field names", () => {
    const result = summarizeServices(services);
    expect(result.count).toBe(3);
    expect(result.domains).toHaveLength(2);
    const light = result.domains.find((d) => d.domain === "light");
    expect(light?.services.turn_on).toEqual({
      description: "Turn a light on",
      fields: { brightness_pct: { description: "Brightness percentage" } },
    });
  });

  it("filters by domain case-insensitively", () => {
    const result = summarizeServices(services, "Switch");
    expect(result.count).toBe(1);
    expect(result.domains[0].domain).toBe("switch");
  });
});
