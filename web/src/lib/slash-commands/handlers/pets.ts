import type { CommandResult } from "../types.js";

export interface PetsHandlerContext {
  toggle?: () => void;
  hatch?: (concept: string) => Promise<string>;
}

export function handlePet(args: string, ctx: PetsHandlerContext): CommandResult {
  if (ctx.toggle) {
    ctx.toggle();
    return { type: "exec", output: "Toggled pet display" };
  }
  return { type: "error", message: "/pet not available in this surface" };
}

export async function handleHatch(args: string, ctx: PetsHandlerContext): Promise<CommandResult> {
  const concept = args.trim() || "cute pixel mascot";
  if (ctx.hatch) {
    const slug = await ctx.hatch(concept);
    return { type: "exec", output: `Hatched pet: ${slug}` };
  }
  return { type: "error", message: "/hatch not available in this surface" };
}
