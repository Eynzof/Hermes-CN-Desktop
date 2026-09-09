import { Link } from "react-router-dom";
import { ArrowUpCircle, Download, LoaderCircle } from "lucide-react";
import { useSoftwareUpdate } from "@/hooks/use-software-update";
import { updateStatusLabel } from "@/lib/software-update";
import s from "./app-status-bar.module.css";

export function SoftwareUpdateStatus() {
  const { state, supported } = useSoftwareUpdate();
  if (!supported) return null;
  const label = updateStatusLabel(state);
  return <Link to="/updates" className={s.updateLink} data-attention={!["idle", "completed", "checking"].includes(state.phase)}
    aria-label={`软件更新：${label}`} title="打开软件更新">
    {state.phase === "downloading" ? <Download size={12} /> : state.phase === "checking" || state.phase === "applying" ? <LoaderCircle size={12} /> : <ArrowUpCircle size={12} />}
    <span>{label}</span>
  </Link>;
}
