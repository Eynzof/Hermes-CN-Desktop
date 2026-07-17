// 右侧面板（子Agent 监视 / 预览）的左缘拖宽控件。
//
// 交互与视觉对齐预览面板内部的目录/内容竖直分割条（file-preview-tab 的
// splitter）：7px 条 + 圆角 grip、hover 变 accent；这里旋转 90° 做水平
// 拖宽。宽度是会话内状态（useState），与分割条的高度一样不做持久化。
import { useCallback, useState, type PointerEvent as ReactPointerEvent } from "react";

import s from "./panel-resize.module.css";

/** 右侧面板拖宽：向左拖增宽（dx 取 startX - clientX），夹在 [min, max]。 */
export function usePanelWidth(defaultWidth: number, min: number, max: number) {
  const [width, setWidth] = useState(defaultWidth);
  const onResizeStart = useCallback(
    (event: ReactPointerEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      const onMove = (move: globalThis.PointerEvent) => {
        setWidth(Math.max(min, Math.min(startWidth + (startX - move.clientX), max)));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [max, min, width],
  );
  return { width, onResizeStart };
}

/** 面板左缘的把手；宿主需 position: relative，把手绝对定位吸附左缘。 */
export function PanelResizeHandle({
  ariaLabel,
  onPointerDown,
}: {
  ariaLabel: string;
  onPointerDown: (event: ReactPointerEvent) => void;
}) {
  return (
    <div
      className={s.handle}
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
    >
      <div className={s.grip} />
    </div>
  );
}
