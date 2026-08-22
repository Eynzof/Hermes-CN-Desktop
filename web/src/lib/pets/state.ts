import type { PetActivity, PetState } from "./constants.js";

export function derivePetState(activity: PetActivity): PetState {
  if (activity.error) return "failed";
  if (activity.celebrate) return "jump";
  if (activity.justCompleted) return "wave";
  if (activity.awaitingInput) return "waiting";
  if (activity.toolRunning) return "run";
  if (activity.reasoning) return "review";
  if (activity.busy) return "run";
  return "idle";
}
