import s from "./message-skeleton.module.css";

// 会话切换时右侧详情区的加载骨架：模拟「用户气泡（右）→ 助手段落（左）」的
// 对话布局，替代纯文本占位，切换瞬间版面不塌缩。只在目标会话既无缓存也无
// 实时消息时由 MessageTimeline 的 loading 分支渲染；hover 预取命中时请求
// 通常百毫秒内返回，容器延迟 ~120ms 才淡入（见 CSS），数据先到则骨架根本
// 不会被看到，避免骨架自己成为新的闪烁源。
//
// 宽度是刻意错落的静态值（不随机化）：SSR/重渲染稳定，视觉上足够像对话。
export function MessageSkeleton() {
  return (
    <div className={s.skeleton} role="status" aria-label="加载对话中">
      <div className={s.user} style={{ width: "38%" }} />
      <div className={s.assistant}>
        <div className={s.line} style={{ width: "92%" }} />
        <div className={s.line} style={{ width: "78%" }} />
        <div className={s.line} style={{ width: "55%" }} />
      </div>
      <div className={s.user} style={{ width: "26%" }} />
      <div className={s.assistant}>
        <div className={s.line} style={{ width: "85%" }} />
        <div className={s.line} style={{ width: "64%" }} />
      </div>
    </div>
  );
}
