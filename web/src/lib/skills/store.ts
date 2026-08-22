/**
 * Jotai-based skill store.
 *
 * Keeps a single SkillService instance in a jotai atom. The `version` field is
 * bumped whenever skills are loaded/unloaded so derived atoms and components
 * re-render without mutating the service reference.
 */

import { atom } from "jotai";
import { SkillService } from "./service.js";

export interface SkillStoreState {
  service: SkillService;
  version: number;
  isLoading: boolean;
  error: string | null;
}

export const skillStoreAtom = atom<SkillStoreState>({
  service: new SkillService(),
  version: 0,
  isLoading: false,
  error: null,
});

/** Derived atom exposing the sorted L0 skill list. */
export const skillListAtom = atom((get) => {
  const { service, version } = get(skillStoreAtom);
  // `version` is read to ensure the derived atom updates after mutations.
  void version;
  return service.registry.list();
});

/** Derived atom exposing all skill categories. */
export const skillCategoriesAtom = atom((get) => {
  const { service, version } = get(skillStoreAtom);
  void version;
  return service.registry.categories();
});

/** Load an in-memory bundle and bump the store version. */
export const loadSkillBundleAtom = atom(
  null,
  (get, set, bundle: import("./service.js").SkillBundle) => {
    const state = get(skillStoreAtom);
    state.service.loadBundle(bundle);
    set(skillStoreAtom, { ...state, version: state.version + 1 });
  },
);

/** Set loading/error state. */
export const setSkillStoreStatusAtom = atom(
  null,
  (get, set, update: Partial<Pick<SkillStoreState, "isLoading" | "error">>) => {
    const state = get(skillStoreAtom);
    set(skillStoreAtom, { ...state, ...update });
  },
);
