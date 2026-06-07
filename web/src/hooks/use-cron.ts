import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJSON, postJSON, putJSON, deleteJSON } from "@/lib/transport";
import { useActiveProfileName } from "@/hooks/use-profiles";
import {
  CronJob as CronJobSchema,
  CronJobsResponse,
  CronRunDetail,
  CronRunsResponse,
  MutationOkResponse,
  type CronJob,
  type CronRun,
} from "@hermes/protocol";

function encodePart(value: string): string {
  return encodeURIComponent(value || "default");
}

export function cronJobProfile(job: Pick<CronJob, "profile" | "profile_name"> | null | undefined): string {
  return job?.profile || job?.profile_name || "default";
}

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
    mutationFn: (job: { prompt: string; schedule: string; name?: string; deliver?: string; profile?: string }) => {
      const { profile = "default", ...body } = job;
      return postJSON(`/api/cron/jobs?profile=${encodePart(profile)}`, body, CronJobSchema);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cron-jobs"] }),
  });
}

export function useUpdateCronJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, profile = "default", updates }: { id: string; profile?: string; updates: Record<string, any> }) =>
      putJSON(`/api/cron/jobs/${encodePart(id)}?profile=${encodePart(profile)}`, { updates }, CronJobSchema),
    onSuccess: (_job, vars) => {
      qc.invalidateQueries({ queryKey: ["cron-jobs"] });
      qc.invalidateQueries({ queryKey: ["cron-runs", vars.profile ?? "default", vars.id] });
    },
  });
}

export function useDeleteCronJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, profile = "default" }: { id: string; profile?: string }) =>
      deleteJSON(`/api/cron/jobs/${encodePart(id)}?profile=${encodePart(profile)}`, undefined, MutationOkResponse),
    onSuccess: (_result, vars) => {
      qc.invalidateQueries({ queryKey: ["cron-jobs"] });
      qc.removeQueries({ queryKey: ["cron-runs", vars.profile ?? "default", vars.id] });
    },
  });
}

export function useCronAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, profile = "default", action }: { id: string; profile?: string; action: "pause" | "resume" | "trigger" }) =>
      postJSON(`/api/cron/jobs/${encodePart(id)}/${action}?profile=${encodePart(profile)}`, {}, CronJobSchema),
    onSuccess: (_job, vars) => {
      qc.invalidateQueries({ queryKey: ["cron-jobs"] });
      qc.invalidateQueries({ queryKey: ["cron-runs", vars.profile ?? "default", vars.id] });
    },
  });
}

export function useCronRuns(job: CronJob | null | undefined, limit = 30) {
  const profile = cronJobProfile(job);
  const id = job?.id ?? "";
  return useQuery<CronRun[]>({
    queryKey: ["cron-runs", profile, id, limit],
    enabled: Boolean(job?.id),
    queryFn: async () => {
      const result = await fetchJSON(
        `/__hermes_cron_runs/${encodePart(profile)}/${encodePart(id)}?limit=${limit}`,
        undefined,
        CronRunsResponse,
      );
      return result.runs;
    },
    retry: 1,
    staleTime: 10_000,
  });
}

export function useCronRunDetail(run: CronRun | null | undefined) {
  const profile = run?.profile ?? "default";
  const jobId = run?.job_id ?? "";
  const filename = run?.filename ?? "";
  return useQuery({
    queryKey: ["cron-run-detail", profile, jobId, filename],
    enabled: Boolean(run?.job_id && run?.filename),
    queryFn: () => fetchJSON(
      `/__hermes_cron_runs/${encodePart(profile)}/${encodePart(jobId)}/${encodePart(filename)}`,
      undefined,
      CronRunDetail,
    ),
    retry: 1,
    staleTime: 60_000,
  });
}
