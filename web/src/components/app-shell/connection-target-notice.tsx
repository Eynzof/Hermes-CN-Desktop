import { Cable, Globe2 } from "lucide-react";
import { runtime } from "@/lib/runtime";
import s from "./connection-target-notice.module.css";

export function ConnectionTargetNotice() {
  if (!runtime.isAttached()) return null;
  const remote = runtime.isRemote();
  const target = window.__HERMES_RUNTIME__?.dashboardApiBaseUrl ?? window.__HERMES_RUNTIME__?.apiBaseUrl ?? "外部目标";
  return (
    <div className={s.notice} role="status">
      {remote ? <Globe2 size={13} /> : <Cable size={13} />}
      <strong>{remote ? "远端服务器 Hermes" : "本机其他 Hermes"}</strong>
      <span>{target}</span>
      <em>本页修改将作用于外部目标</em>
    </div>
  );
}
