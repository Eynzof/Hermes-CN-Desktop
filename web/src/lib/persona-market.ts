import { PERSONA_MANIFEST, PERSONA_SOURCE } from "@/data/persona-market/personas.generated";

export type PersonaMarketItem = (typeof PERSONA_MANIFEST)[number];

export const personaMarketItems: readonly PersonaMarketItem[] = PERSONA_MANIFEST;
export const personaMarketSource = PERSONA_SOURCE;
export const personaMarketCategories = Array.from(
  new Map(PERSONA_MANIFEST.map((persona) => [persona.category, persona.categoryLabel])).entries(),
).map(([id, label]) => ({ id, label }));

const promptLoaders = import.meta.glob<string>("../data/persona-market/prompts/*.md", {
  query: "?raw",
  import: "default",
});

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

export function filterPersonaMarket(
  query: string,
  category: string,
): readonly PersonaMarketItem[] {
  const needle = normalize(query);
  return PERSONA_MANIFEST.filter((persona) => {
    if (category !== "all" && persona.category !== category) return false;
    if (!needle) return true;
    return normalize([
      persona.name,
      persona.description,
      persona.categoryLabel,
      persona.id,
    ].join(" ")).includes(needle);
  });
}

export async function loadPersonaPrompt(id: string): Promise<string> {
  const key = `../data/persona-market/prompts/${id}.md`;
  const loader = promptLoaders[key];
  if (!loader) throw new Error(`找不到人格提示词：${id}`);
  return (await loader()).trim();
}
