import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJSON, postJSON, putJSON, deleteJSON } from "@/lib/transport";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { CronJob as CronJobSchema, CronJobsResponse, MutationOkResponse, type CronJob } from "@hermes/protocol";

export function useCronJobs() {
  const profile = useActiveProfileName();
  return useQuery<CronJob[]>({
    queryKey: ["cron-jobs", profile],
    queryFn: () => fetchJSON("/api/cron/jobs?profile=all", undefined, CronJobsResponse),
    retry: 1,
    staleTime: 30_000,
  });
}

export function useCreateCronJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (job: { prompt: string; schedule: string; name?: string; deliver?: string }) =>
      postJSON("/api/cron/jobs", job, CronJobSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cron-jobs"] }),
  });
}

export function useUpdateCronJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Record<string, any> }) =>
      putJSON(`/api/cron/jobs/${id}`, { updates }, CronJobSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cron-jobs"] }),
  });
}

export function useDeleteCronJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteJSON(`/api/cron/jobs/${id}`, undefined, MutationOkResponse),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cron-jobs"] }),
  });
}

export function useCronAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "pause" | "resume" | "trigger" }) =>
      postJSON(`/api/cron/jobs/${id}/${action}`, {}, CronJobSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cron-jobs"] }),
  });
}
