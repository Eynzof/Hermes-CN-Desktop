import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../utils/cn";
import s from "./page-tabs.module.css";

export interface PageTabItem<Value extends string> {
  value: Value;
  label: ReactNode;
  icon?: ReactNode;
  count?: ReactNode;
  disabled?: boolean;
}

export interface PageTabsProps<Value extends string> {
  "aria-label": string;
  items: readonly PageTabItem<Value>[];
  value: Value;
  onValueChange: (value: Value) => void;
  end?: ReactNode;
  className?: string;
}

export function PageTabs<Value extends string>({
  "aria-label": ariaLabel,
  items,
  value,
  onValueChange,
  end,
  className,
}: PageTabsProps<Value>) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    const enabledIndexes = items.flatMap((item, index) => (item.disabled ? [] : [index]));
    const currentPosition = enabledIndexes.indexOf(currentIndex);
    if (currentPosition < 0) return;

    let targetPosition: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      targetPosition = (currentPosition + 1) % enabledIndexes.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      targetPosition = (currentPosition - 1 + enabledIndexes.length) % enabledIndexes.length;
    } else if (event.key === "Home") {
      targetPosition = 0;
    } else if (event.key === "End") {
      targetPosition = enabledIndexes.length - 1;
    }

    if (targetPosition === null) return;
    event.preventDefault();
    const targetIndex = enabledIndexes[targetPosition];
    tabRefs.current[targetIndex]?.focus();
    onValueChange(items[targetIndex].value);
  }

  return (
    <div className={cn(s.root, className)}>
      <div className={s.inner}>
        <div className={s.list} role="tablist" aria-label={ariaLabel}>
          {items.map((item, index) => {
            const active = item.value === value;
            return (
              <button
                key={item.value}
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                type="button"
                className={s.tab}
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                data-active={active ? "true" : undefined}
                disabled={item.disabled}
                onClick={() => onValueChange(item.value)}
                onKeyDown={(event) => handleKeyDown(event, index)}
              >
                {item.icon ? (
                  <span className={s.icon} aria-hidden="true">
                    {item.icon}
                  </span>
                ) : null}
                <span>{item.label}</span>
                {item.count !== undefined ? <span className={s.count}>{item.count}</span> : null}
              </button>
            );
          })}
        </div>
        {end ? <div className={s.end}>{end}</div> : null}
      </div>
    </div>
  );
}
