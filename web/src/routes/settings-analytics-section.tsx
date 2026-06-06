import { useState } from "react";
import { useAnalytics } from "@/hooks/use-analytics";
import s from "./settings.module.css";

function formatLargeNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function RadioGroup({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className={s.radioGroup}>
      {options.map((option) => (
        <button
          key={option.value}
          className={s.radioBtn}
          data-active={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className={s.providerMini}>
      <div className={s.providerInfo}>
        <span className={s.providerVendor}>{label}</span>
        <span className={s.providerName}>{value}</span>
      </div>
    </div>
  );
}

export function AnalyticsSection({ showHeading = true }: { showHeading?: boolean }) {
  const [days, setDays] = useState(30);
  const { data, isLoading } = useAnalytics(days);

  if (isLoading) return <div className={s.desc}>加载中…</div>;
  if (!data) return null;

  const totals = data.totals ?? {};

  return (
    <div>
      {showHeading && <h2 className={s.heading}>数据分析</h2>}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <span className={s.desc} style={{ margin: 0 }}>时间范围:</span>
        <RadioGroup
          value={String(days)}
          options={[
            { value: "7", label: "7 天" },
            { value: "30", label: "30 天" },
            { value: "90", label: "90 天" },
          ]}
          onChange={(value) => setDays(Number(value))}
        />
      </div>

      <div className={s.providerGrid}>
        <StatCard
          label="总 Tokens"
          value={formatLargeNum((totals.total_input ?? 0) + (totals.total_output ?? 0))}
        />
        <StatCard label="会话数" value={String(totals.total_sessions ?? 0)} />
        <StatCard label="API 调用" value={String(totals.total_api_calls ?? 0)} />
      </div>

      <div className={s.modelsLabel}>按模型</div>
      {data.by_model.map((model) => (
        <div key={model.model} className={s.row}>
          <div className={s.rowLeft}>
            <div className={s.rowLabel}>{model.model}</div>
          </div>
          <div className={s.rowRight}>
            <span className={s.rowSub}>{formatLargeNum(model.input_tokens + model.output_tokens)} tok</span>
          </div>
        </div>
      ))}

      <div className={s.modelsLabel} style={{ marginTop: 16 }}>每日明细</div>
      <div className={s.logBlock}>
        {data.daily.map((day) => (
          <div key={day.day} className={s.logLine}>
            {day.day} — {day.sessions} 会话 · {formatLargeNum(day.input_tokens + day.output_tokens)} tok
          </div>
        ))}
      </div>
    </div>
  );
}
