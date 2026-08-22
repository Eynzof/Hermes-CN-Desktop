/**
 * React hooks for skill state.
 */

import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { skillCategoriesAtom, skillListAtom, skillStoreAtom } from "./store.js";

export function useSkills() {
  const list = useAtomValue(skillListAtom);
  const categories = useAtomValue(skillCategoriesAtom);
  const state = useAtomValue(skillStoreAtom);

  return useMemo(
    () => ({
      skills: list,
      categories,
      isLoading: state.isLoading,
      error: state.error,
      registry: state.service.registry,
      service: state.service,
    }),
    [list, categories, state],
  );
}

export function useSkill(id: string | undefined) {
  const { registry } = useSkills();
  return useMemo(() => {
    if (!id) return undefined;
    return registry.resolve(id);
  }, [registry, id]);
}
