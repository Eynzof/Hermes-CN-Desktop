import { useStatus } from "@/hooks/use-status";
import { HealthGrid } from "@/components/panel/health-grid";
import { formatHealthSubtitle } from "@/lib/health-subtitle";
import { SectionShell } from "./section-shell";

export function HealthRoute() {
  const { data: status, isError } = useStatus();
  const sub = formatHealthSubtitle(status, isError);
  return (
    <SectionShell title="健康检查" sub={sub}>
      <HealthGrid />
    </SectionShell>
  );
}
