import { useId, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { LoadingState } from "@hermes/shared-ui";
import type { ComposerModelSelection } from "./composer-types";
import type { ModelSwitchScope } from "@/hooks/use-model-switch";
import { useSessionModelSwitch } from "@/hooks/use-model-switch";
import s from "./model-switcher.module.css";

interface ModelSwitcherProps {
  sessionId: string;
  currentSelection: ComposerModelSelection;
  models: string[];
  onSwitch?: (selection: ComposerModelSelection) => void;
  disabled?: boolean;
}

const SCOPE_LABELS: Record<ModelSwitchScope, string> = {
  "per-session": "本次会话",
  global: "设为默认",
  once: "仅下一条",
};

/**
 * Dropdown model switcher supporting per-session, global, and single-turn scopes.
 *
 * This is a scaffold component: it accepts a flat list of model IDs and uses
 * `@/hooks/use-model-switch` to resolve aliases and persist the choice.
 */
export function ModelSwitcher({
  sessionId,
  currentSelection,
  models,
  onSwitch,
  disabled,
}: ModelSwitcherProps) {
  const labelId = useId();
  const [open, setOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState(currentSelection.model);
  const [scope, setScope] = useState<ModelSwitchScope>("per-session");
  const { switchTo, isPending } = useSessionModelSwitch(sessionId, currentSelection);

  const activeModel = selectedModel || currentSelection.model;

  async function handleConfirm() {
    if (!activeModel) return;
    const result = await switchTo(activeModel, scope);
    onSwitch?.({
      model: result.model,
      provider: result.provider,
    });
    setOpen(false);
  }

  return (
    <div className={s.modelPickerContainer}>
      <button
        type="button"
        className={s.modelPickerButton}
        aria-labelledby={labelId}
        disabled={disabled || isPending}
        onClick={() => setOpen((v) => !v)}
      >
        <span id={labelId}>{activeModel || "切换模型"}</span>
        <ChevronDown size={12} />
      </button>

      {open && (
        <div className={s.modelPickerDropdown} role="listbox" aria-label="选择模型">
          <div className={s.modelPickerSection}>
            <span className={s.modelPickerSectionTitle}>生效范围</span>
            <div className={s.modelPickerScopeRow}>
              {(Object.keys(SCOPE_LABELS) as ModelSwitchScope[]).map((sKey) => (
                <button
                  key={sKey}
                  type="button"
                  className={s.scopeButton + (scope === sKey ? " " + s.scopeButtonActive : "")}
                  onClick={() => setScope(sKey)}
                  aria-pressed={scope === sKey}
                >
{scope === sKey && <Check size={12} />}
                  {SCOPE_LABELS[sKey]}
                </button>
              ))}
            </div>
          </div>

          <div className={s.modelPickerSection}>
            <span className={s.modelPickerSectionTitle}>模型</span>
            {models.map((model) => (
              <button
                key={model}
                type="button"
                role="option"
                aria-selected={model === activeModel}
                className={s.modelPickerItem + (model === activeModel ? " " + s.modelPickerItemActive : "")}
                onClick={() => setSelectedModel(model)}
              >
                {model}
                {model === activeModel && <Check size={12} />}
              </button>
            ))}
          </div>

          <div className={s.modelPickerFooter}>
            <button
              type="button"
              className={s.modelPickerConfirm}
              disabled={!activeModel || isPending}
              onClick={handleConfirm}
            >
              {isPending ? <LoadingState size="sm" /> : "切换"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
