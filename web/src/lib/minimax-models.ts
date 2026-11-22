/** Current direct API choices; custom providers and saved selections stay explicit. */
export const MINIMAX_TEXT_MODELS = ["MiniMax-M3.1-Flash", "MiniMax-M3"] as const;

export function isDirectMiniMaxProvider(provider: string): boolean {
  return provider === "minimax" || provider === "minimax-cn";
}

export function currentTextModelChoices(
  provider: string,
  models: readonly string[],
  selected?: string,
  custom = false,
): string[] {
  if (custom || provider.startsWith("custom:") || provider === "custom-draft") {
    return Array.from(new Set([...models, ...(selected ? [selected] : [])]));
  }
  // Filter only the MiniMax text family. Speech, image and other providers' IDs
  // are not text catalog migrations. Gateway routes must already be advertised.
  const current = models.filter((id) => !/(?:^|\/)minimax-m\d/i.test(id)
    || /(?:^|\/)minimax-m3(?:\.1-flash(?:-free)?|)(?::free)?$/i.test(id));
  const textFamily = /(?:^|\/)minimax-m\d/i;
  const ordered = current.filter((id) => textFamily.test(id))
    .sort((a, b) => Number(!/m3\.1-flash/i.test(a)) - Number(!/m3\.1-flash/i.test(b)));
  let index = 0;
  const choices = isDirectMiniMaxProvider(provider)
    ? [...MINIMAX_TEXT_MODELS, ...current]
    : current.map((id) => textFamily.test(id) ? ordered[index++]! : id);
  return Array.from(new Set([...choices, ...(selected ? [selected] : [])]));
}
