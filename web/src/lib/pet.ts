import { getGatewayClient } from "@/lib/gateway-client";

export type PetState = "idle" | "wave" | "run" | "failed" | "review" | "jump" | "waiting";

export interface PetInfo {
  enabled: boolean;
  slug?: string;
  displayName?: string;
  mime?: string;
  spritesheetBase64?: string;
  spritesheetRevision?: string;
  frameW?: number;
  frameH?: number;
  framesPerState?: number;
  framesByState?: Record<string, number>;
  framesByRow?: Record<string, number>;
  loopMs?: number;
  scale?: number;
  stateRows?: string[];
}

export interface GalleryPet {
  slug: string;
  displayName: string;
  installed: boolean;
  spritesheetUrl?: string;
  curated?: boolean;
  generated?: boolean;
}

export interface PetGallery {
  enabled: boolean;
  active: string;
  pets: GalleryPet[];
}

export interface PetDraft {
  index: number;
  dataUri: string;
}

export interface PetGenerateResult {
  ok: boolean;
  token: string;
  drafts: PetDraft[];
}

export interface PetHatchResult {
  ok: boolean;
  slug: string;
  displayName: string;
  warnings?: string[];
  pet?: PetInfo;
}

export function derivePetState(input: {
  busy?: boolean;
  toolRunning?: boolean;
  error?: boolean;
  complete?: boolean;
}): PetState {
  if (input.error) return "failed";
  if (input.complete) return "jump";
  if (input.toolRunning) return "run";
  if (input.busy) return "review";
  return "idle";
}

function withProfile(params: Record<string, unknown> = {}, profile?: string) {
  return profile ? { ...params, profile } : params;
}

export function petRpc<T>(method: string, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
  return getGatewayClient().request<T>(method, params, { timeoutMs });
}

export function getPetInfo(profile?: string): Promise<PetInfo> {
  return petRpc("pet.info", withProfile({}, profile));
}

export function getPetGallery(profile?: string, localOnly = false): Promise<PetGallery> {
  return petRpc("pet.gallery", withProfile(localOnly ? { localOnly: true } : {}, profile), 60_000);
}

export function getPetThumb(slug: string, url?: string, profile?: string): Promise<{ ok: boolean; dataUri?: string }> {
  return petRpc("pet.thumb", withProfile({ slug, url: url ?? "" }, profile), 60_000);
}

export function selectPet(slug: string, profile?: string): Promise<{ ok: boolean; slug: string; displayName?: string }> {
  return petRpc("pet.select", withProfile({ slug }, profile), 60_000);
}

export function disablePet(profile?: string): Promise<{ ok: boolean }> {
  return petRpc("pet.disable", withProfile({}, profile), 30_000);
}

export function setPetScale(scale: number, profile?: string): Promise<{ ok: boolean; scale?: number }> {
  return petRpc("pet.scale", withProfile({ scale }, profile), 30_000);
}

export function generatePet(
  input: { prompt: string; count: number; style?: string; provider?: string; referenceImage?: string },
  profile?: string,
): Promise<PetGenerateResult> {
  return petRpc("pet.generate", withProfile(input, profile), 10 * 60_000);
}

export function hatchPet(
  input: { token: string; index: number; name: string; description?: string; prompt?: string; style?: string; provider?: string },
  profile?: string,
): Promise<PetHatchResult> {
  return petRpc("pet.hatch", withProfile(input, profile), 15 * 60_000);
}
