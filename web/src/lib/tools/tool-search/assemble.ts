import type { ToolDefinition } from "@hermes/agent-tools";
import { bridgeToolSchemas } from "./bridge.js";
import { buildCatalogListingWithForm } from "./catalog.js";
import { classifyTools } from "./classify.js";
import { toolSearchConfigFromRaw } from "./config.js";
import { estimateTokensFromSchemas } from "./retrieval.js";
import type { AssemblyResult, ToolSearchConfig } from "./types.js";

export function assembleToolDefs(
  toolDefs: ToolDefinition[],
  opts: { contextLength: number; config?: unknown },
): AssemblyResult {
  const config = toolSearchConfigFromRaw(opts.config);
  const { visible, deferrable } = classifyTools(toolDefs);

  if (config.enabled === "off" || deferrable.length === 0) {
    return {
      toolDefs,
      activated: false,
      deferredCount: 0,
      deferredTokens: 0,
      thresholdTokens: 0,
      tier: 1,
      listingForm: "none",
    };
  }

  const thresholdTokens = Math.min(config.listingMaxTokens, Math.max(10000, Math.floor((opts.contextLength * config.thresholdPct) / 100)));
  const { listing, form } = buildCatalogListingWithForm(
    deferrable.map((d) => ({
      name: d.function.name,
      description: d.function.description,
      schema: d.function.parameters,
      source: d.function.name.split("__")[0] ?? "unknown",
      sourceName: d.function.name,
    })),
    thresholdTokens,
  );

  // Strip any pre-existing bridge tools to stay idempotent.
  const filtered = visible.filter((d) => !["tool_search", "tool_describe", "tool_call"].includes(d.function.name));
  const bridge = bridgeToolSchemas(deferrable.length, listing, form);

  return {
    toolDefs: [...filtered, ...bridge],
    activated: true,
    deferredCount: deferrable.length,
    deferredTokens: estimateTokensFromSchemas(deferrable.map((d) => ({ name: d.function.name, description: d.function.description, schema: d.function.parameters, source: "", sourceName: "" }))),
    thresholdTokens,
    tier: form === "full" || form === "names" || form === "mixed" ? 1 : 2,
    listingForm: form,
  };
}
