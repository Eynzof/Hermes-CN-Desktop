import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJSON, putJSON, deleteJSON, postJSON } from "@/lib/transport";
import { useActiveProfileName } from "@/hooks/use-profiles";
import {
  EnvVarsResponse,
  MutationOkResponse,
  RevealEnvResponse,
  type EnvVarInfo,
} from "@hermes/protocol";

export function useEnvVars() {
  const profile = useActiveProfileName();
  return useQuery<Record<string, EnvVarInfo>>({
    queryKey: ["env", profile],
    queryFn: ({ signal }) => fetchJSON("/api/env", { signal }, EnvVarsResponse),
  });
}

export function useSetEnv() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { key: string; value: string }) =>
      putJSON("/api/env", vars, MutationOkResponse),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["env"] }),
  });
}

export function useDeleteEnv() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => deleteJSON("/api/env", { key }, MutationOkResponse),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["env"] }),
  });
}

export function useRevealEnv() {
  return useMutation<{ value: string }, Error, string>({
    mutationFn: (key: string) => postJSON("/api/env/reveal", { key }, RevealEnvResponse),
  });
}
