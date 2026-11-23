import type { MoaConfigResponse, MoaModelSlot, MoaPresetConfig } from "@hermes/protocol";

const presetFields = [
  "enabled", "reference_models", "aggregator", "reference_temperature",
  "aggregator_temperature", "reference_timeout", "degraded_reference_policy",
  "max_tokens", "reference_max_tokens", "fanout",
] as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type MoaConfigSource =
  | { kind: "named"; names: string[] }
  | { kind: "legacy"; preset: MoaPresetConfig; fields: string[]; privacy: boolean };

function enabled(value: unknown): boolean {
  if (typeof value === "string") return !["false", "no", "off", "0"].includes(value.trim().toLowerCase());
  return value == null || Boolean(value);
}

function slot(raw: unknown): MoaModelSlot {
  const data = record(raw) ? raw : {};
  return {
    ...("enabled" in data ? { enabled: enabled(data.enabled) } : {}),
    ...Object.fromEntries(["reasoning_effort", "max_tokens"].filter(k => k in data).map(k => [k, data[k]])),
    provider: String(data.provider ?? ""), model: String(data.model ?? ""),
  };
}

// Match the older Core's accepted reference list and { mode: every_n, n: N } forms.
// Missing model IDs are left for the user to fill in before saving.
export async function inspectMoaYaml(yaml: string): Promise<MoaConfigSource | null> {
  const { parse } = await import("yaml");
  let doc: unknown;
  try {
    doc = parse(yaml, {
      version: "1.1",
      logLevel: "silent",
      // Core uses PyYAML, which treats single-letter y/n as strings (e.g. fanout.n).
      customTags: tags => tags.map(tag => {
        if (typeof tag === "string" || tag.tag !== "tag:yaml.org,2002:bool" || !tag.test) return tag;
        return { ...tag, test: tag.test.test("true") ? /^(?:true|yes|on)$/i : /^(?:false|no|off)$/i };
      }),
    });
  } catch {
    return null;
  }
  if (!record(doc) || !record(doc.moa)) return null;
  const raw = doc.moa;
  if ("presets" in raw) return record(raw.presets) ? { kind: "named", names: Object.keys(raw.presets) } : null;
  const fields = presetFields.filter(key => key in raw);
  if (!fields.length) return null;
  let refs = raw.reference_models;
  if (typeof refs === "string") {
    try { refs = JSON.parse(refs); } catch { return null; }
  }
  const list = Array.isArray(refs) ? refs : refs ? [refs] : [];
  const preset: MoaPresetConfig = {
    ...Object.fromEntries(fields.map(key => [key, raw[key]])),
    enabled: enabled(raw.enabled),
    max_tokens: Number(raw.max_tokens ?? 4096),
    reference_models: (list.length ? list : [null]).map(slot),
    aggregator: slot(raw.aggregator),
  };
  if (record(raw.fanout)) {
    preset.fanout = raw.fanout.mode === "every_n" ? `every_n:${raw.fanout.n}` : raw.fanout.mode;
  }
  const privacy = ["true", "yes", "on", "1", "display", "full"].includes(String(raw.privacy_filter).trim().toLowerCase());
  return { kind: "legacy", preset, fields, privacy };
}

export function conflictsWithLegacy(source: MoaConfigSource | null | undefined, config: MoaConfigResponse | undefined) {
  if (source?.kind !== "legacy" || !config) return false;
  const actual = config.presets[config.default_preset];
  if (!actual) return false;
  const wanted = source.preset;
  function slotDiffers(from: MoaModelSlot, to: MoaModelSlot | undefined) {
    if (!from.provider || !from.model || from.provider.includes("${") || from.model.includes("${")) return false;
    if (!to || from.provider !== to.provider || from.model !== to.model) return true;
    return (from.enabled === false) !== (to.enabled === false) ||
      ["reasoning_effort", "max_tokens"].some(key => from[key] != null && String(from[key]) !== String(to[key]));
  }
  return source.fields.some(key => {
    if (key === "aggregator") return slotDiffers(wanted.aggregator, actual.aggregator);
    if (key === "reference_models") {
      return wanted.reference_models.some((ref, i) => slotDiffers(ref, actual.reference_models[i])) ||
        (wanted.reference_models.every(ref => ref.provider && ref.model) && wanted.reference_models.length !== actual.reference_models.length);
    }
    return wanted[key] != null && String(wanted[key]) !== String(actual[key]);
  });
}
