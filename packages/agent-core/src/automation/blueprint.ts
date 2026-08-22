import type { AutomationBlueprint } from "./types.js";

export class BlueprintLibrary {
  private blueprints = new Map<string, AutomationBlueprint>();

  add(name: string, steps: string[], tags: string[] = []): AutomationBlueprint {
    const blueprint: AutomationBlueprint = {
      id: `bp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      steps,
      tags,
      createdAt: Date.now(),
    };
    this.blueprints.set(blueprint.id, blueprint);
    return blueprint;
  }

  get(id: string): AutomationBlueprint | undefined {
    return this.blueprints.get(id);
  }

  list(): AutomationBlueprint[] {
    return Array.from(this.blueprints.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  match(query: string): AutomationBlueprint[] {
    const q = query.toLowerCase();
    return this.list().filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        b.tags.some((t) => t.toLowerCase().includes(q)) ||
        b.steps.some((s) => s.toLowerCase().includes(q)),
    );
  }
}

export function levenshtein(a: string, b: string): number {
  const matrix: number[][] = Array.from({ length: a.length + 1 }, () => []);
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[a.length][b.length];
}
