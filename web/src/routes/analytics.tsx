import { AnalyticsSection } from "./settings-analytics-section";
import { SectionShell } from "./section-shell";

export function AnalyticsRoute() {
  return (
    <SectionShell title="数据分析" sub="查看 Token、会话与模型维度的使用趋势。">
      <AnalyticsSection showHeading={false} />
    </SectionShell>
  );
}
