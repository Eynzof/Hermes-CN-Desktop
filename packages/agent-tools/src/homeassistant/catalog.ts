/**
 * Home Assistant tool catalog registration.
 */

import { z } from "zod";
import { registry } from "../registry.js";
import { objectSchema } from "../catalog.js";
import { credentialGates } from "../gates.js";
import { haListEntities, haGetState, haListServices, haCallService } from "./tools.js";
import type { ToolEntry } from "../types.js";

export function registerHomeAssistantTools(): void {
  const tools: ToolEntry[] = [
    {
      name: "ha_list_entities",
      toolset: "homeassistant",
      description: "List Home Assistant entities, optionally filtered by domain and/or area.",
      emoji: "🏠",
      tags: ["ha"],
      schema: objectSchema(
        {
          domain: z.string().optional().describe("Filter by entity domain (e.g. 'light', 'switch')"),
          area: z.string().optional().describe("Filter by area name"),
        },
        [],
      ),
      handler: haListEntities,
      checkFn: credentialGates.homeassistant,
    },
    {
      name: "ha_get_state",
      toolset: "homeassistant",
      description: "Get the full state of a single Home Assistant entity.",
      emoji: "🏠",
      tags: ["ha"],
      schema: objectSchema(
        {
          entity_id: z.string().describe("Entity id, e.g. 'light.living_room'"),
        },
        ["entity_id"],
      ),
      handler: haGetState,
      checkFn: credentialGates.homeassistant,
    },
    {
      name: "ha_list_services",
      toolset: "homeassistant",
      description: "List available Home Assistant services, optionally filtered by domain.",
      emoji: "🏠",
      tags: ["ha"],
      schema: objectSchema(
        {
          domain: z.string().optional().describe("Filter by service domain"),
        },
        [],
      ),
      handler: haListServices,
      checkFn: credentialGates.homeassistant,
    },
    {
      name: "ha_call_service",
      toolset: "homeassistant",
      description: "Call a Home Assistant service on an entity (or with arbitrary data).",
      emoji: "🏠",
      tags: ["ha"],
      schema: objectSchema(
        {
          domain: z.string().describe("Service domain, e.g. 'light'"),
          service: z.string().describe("Service name, e.g. 'turn_on'"),
          entity_id: z.string().optional().describe("Target entity id"),
          data: z
            .string()
            .optional()
            .describe("Service data as a JSON string; e.g. '{\"brightness_pct\": 50}'"),
        },
        ["domain", "service"],
      ),
      handler: haCallService,
      checkFn: credentialGates.homeassistant,
    },
  ];

  for (const tool of tools) {
    registry.register(tool);
  }
}

// Auto-register on module import so the global catalog contains the tools.
registerHomeAssistantTools();
