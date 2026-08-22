import { describe, it, expect } from "vitest";
import {
  ENTITY_ID_RE,
  SERVICE_NAME_RE,
  BLOCKED_DOMAINS,
  isValidEntityId,
  isValidServiceName,
  isBlockedDomain,
  parseStringData,
} from "./security.js";

describe("ENTITY_ID_RE", () => {
  it.each([
    "light.living_room",
    "switch.kitchen",
    "sensor.outside_temperature",
    "binary_sensor.door",
    "climate.home",
    "_custom_domain.entity",
  ])("accepts %s", (id) => {
    expect(ENTITY_ID_RE.test(id)).toBe(true);
  });

  it.each([
    "light",
    "light.",
    ".entity",
    "Light.living_room",
    "light.living room",
    "light/living_room",
    "shell_command../light",
    "light..entity",
    "light.entity.extra",
  ])("rejects %s", (id) => {
    expect(ENTITY_ID_RE.test(id)).toBe(false);
  });
});

describe("SERVICE_NAME_RE", () => {
  it.each(["turn_on", "turn_off", "set_temperature", "reload", "execute", "a1_2"])("accepts %s", (name) => {
    expect(SERVICE_NAME_RE.test(name)).toBe(true);
  });

  it.each(["Turn_on", "turn on", "turn-on", "1service", "service.test", ""])("rejects %s", (name) => {
    expect(SERVICE_NAME_RE.test(name)).toBe(false);
  });
});

describe("BLOCKED_DOMAINS", () => {
  it("contains the six security-sensitive domains", () => {
    expect(BLOCKED_DOMAINS).toEqual(
      new Set(["shell_command", "command_line", "python_script", "pyscript", "hassio", "rest_command"]),
    );
  });

  it.each(["shell_command", "command_line", "python_script", "pyscript", "hassio", "rest_command"])(
    "%s is blocked",
    (domain) => {
      expect(isBlockedDomain(domain)).toBe(true);
    },
  );

  it.each(["light", "switch", "climate", "persistent_notification"])("%s is not blocked", (domain) => {
    expect(isBlockedDomain(domain)).toBe(false);
  });
});

describe("isValidEntityId", () => {
  it("rejects path traversal attempts", () => {
    expect(isValidEntityId("shell_command../light")).toBe(false);
    expect(isValidEntityId("../shell_command.run")).toBe(false);
  });
});

describe("isValidServiceName", () => {
  it("validates before blocklist application", () => {
    // Service name validation must reject traversal-shaped names before a
    // blocklist check could be bypassed.
    expect(isValidServiceName("../light")).toBe(false);
    expect(isValidServiceName("shell_command/../light")).toBe(false);
  });
});

describe("parseStringData", () => {
  it("returns undefined for undefined/null", () => {
    expect(parseStringData(undefined)).toBeUndefined();
    expect(parseStringData(null)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseStringData("")).toBeUndefined();
    expect(parseStringData("   ")).toBeUndefined();
  });

  it("parses valid JSON string", () => {
    expect(parseStringData('{"brightness_pct": 50}')).toEqual({ brightness_pct: 50 });
  });

  it("parses object input as-is", () => {
    expect(parseStringData({ brightness_pct: 50 })).toEqual({ brightness_pct: 50 });
  });

  it("rejects non-object JSON values", () => {
    expect(parseStringData("[1, 2, 3]")).toBeUndefined();
    expect(parseStringData('"string"')).toBeUndefined();
    expect(parseStringData("null")).toBeUndefined();
  });

  it("rejects invalid JSON", () => {
    expect(parseStringData("{not json}")).toBeUndefined();
  });

  it("rejects arrays and primitives", () => {
    expect(parseStringData(123)).toBeUndefined();
    expect(parseStringData([1, 2])).toBeUndefined();
  });
});
