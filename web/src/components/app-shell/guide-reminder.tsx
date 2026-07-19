import { Compass, X } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { runtime } from "@/lib/runtime";
import s from "./guide-reminder.module.css";

export function GuideReminder() {
  const navigate = useNavigate();
  const [hidden, setHidden] = useState(false);
  if (hidden || runtime.getGuideState() === "completed") return null;
  return (
    <aside className={s.banner} aria-label="使用引导尚未完成">
      <Compass size={16} />
      <div><strong>还没有选择开始方式</strong><span>选择开箱即用，或连接你已经部署好的 Hermes。</span></div>
      <button type="button" onClick={() => navigate("/guide")}>继续引导</button>
      <button type="button" className={s.close} aria-label="暂时关闭提醒" onClick={() => setHidden(true)}><X size={14} /></button>
    </aside>
  );
}
