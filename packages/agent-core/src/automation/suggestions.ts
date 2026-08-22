import type { AutomationBlueprint, AutomationSuggestion } from "./types.js";

export function generateSuggestions(
  topic: string,
  blueprints: AutomationBlueprint[],
): AutomationSuggestion[] {
  const q = topic.toLowerCase();
  const scored = blueprints
    .map((b) => {
      const nameHit = b.name.toLowerCase().includes(q) ? 1 : 0;
      const tagHit = b.tags.some((t) => t.toLowerCase().includes(q)) ? 1 : 0;
      return { blueprint: b, score: nameHit * 2 + tagHit };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map((x, i) => ({
    id: `sug-${Date.now()}-${i}`,
    title: `Automate ${x.blueprint.name}`,
    description: x.blueprint.steps.join(" → "),
    confidence: Math.min(0.5 + x.score * 0.25, 1),
    blueprintId: x.blueprint.id,
  }));
}
