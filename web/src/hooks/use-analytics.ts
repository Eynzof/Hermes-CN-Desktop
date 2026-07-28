import { useQuery } from "@tanstack/react-query";
import { fetchJSON } from "@/lib/transport";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { AnalyticsResponse } from "@hermes/protocol";

export function analyticsPath(days: number, profileOverride?: string | null): string {
  const params = new URLSearchParams({ days: String(days) });
  if (profileOverride) params.set("profile", profileOverride);
  return `/api/analytics/usage?${params.toString()}`;
}

export function useAnalytics(days = 30, profileOverride?: string | null) {
  const activeProfile = useActiveProfileName();
  const profile = profileOverride || activeProfile;
  return useQuery<AnalyticsResponse>({
    queryKey: ["analytics", profile, days],
    queryFn: ({ signal }) =>
      fetchJSON(analyticsPath(days, profileOverride), { signal }, AnalyticsResponse),
    staleTime: 60_000,
  });
}
