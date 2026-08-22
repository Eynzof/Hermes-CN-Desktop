import { useMemo } from "react";
import { Sparkles } from "lucide-react";
import { describePersonality, type PersonalityDefinition } from "@/lib/personality";
import s from "./personality-picker.module.css";

export interface PersonalityItem {
  name: string;
  definition: PersonalityDefinition;
  emoji?: string;
}

export interface PersonalityPickerProps {
  /** Available personalities (built-ins + custom overrides). */
  personalities: PersonalityItem[];
  /** Active personality name, or empty string for neutral. */
  activeName?: string;
  /** Called when the user selects a personality. */
  onSelect?: (name: string, item: PersonalityItem) => void;
  /** Called when the user resets to neutral. */
  onReset?: () => void;
  /** Optional header label. */
  title?: string;
}

export function PersonalityPicker({
  personalities,
  activeName = "",
  onSelect,
  onReset,
  title = "人格",
}: PersonalityPickerProps) {
  const sorted = useMemo(
    () => [...personalities].sort((a, b) => a.name.localeCompare(b.name)),
    [personalities],
  );

  return (
    <div className={s.picker} role="listbox" aria-label={title}>
      <div className={s.header}>
        <Sparkles size={16} aria-hidden="true" />
        <span>{title}</span>
        {activeName && (
          <span className={s.badge} data-testid="active-personality-badge">
            {activeName}
          </span>
        )}
      </div>

      {sorted.length === 0 ? (
        <div className={s.empty}>No personalities available.</div>
      ) : (
        <div className={s.list}>
          {sorted.map((item) => {
            const isActive = activeName.toLowerCase() === item.name.toLowerCase();
            return (
              <button
                key={item.name}
                type="button"
                role="option"
                aria-selected={isActive}
                data-active={isActive ? "true" : undefined}
                className={s.item}
                onClick={() => onSelect?.(item.name, item)}
              >
                <span className={s.emoji} aria-hidden="true">
                  {item.emoji || "🎭"}
                </span>
                <span className={s.meta}>
                  <span className={s.name}>{item.name}</span>
                  <span className={s.description}>
                    {describePersonality(item.definition, 40)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {activeName && (
        <button type="button" className={s.reset} onClick={() => onReset?.()}>
          Reset to neutral
        </button>
      )}
    </div>
  );
}
