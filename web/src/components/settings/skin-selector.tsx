import { listSkins, type SkinPreset, type SkinSlug } from "@/lib/skins";
import s from "./skin-selector.module.css";

export interface SkinSelectorProps {
  value: SkinSlug;
  onChange: (skin: SkinSlug) => void;
}

export function SkinSelector({ value, onChange }: SkinSelectorProps) {
  const skins = listSkins();
  return (
    <div className={s.skinPicker} role="radiogroup" aria-label="皮肤预设">
      {skins.map((skin) => (
        <SkinCard key={skin.slug} skin={skin} active={skin.slug === value} onClick={() => onChange(skin.slug)} />
      ))}
    </div>
  );
}

function SkinCard({
  skin,
  active,
  onClick,
}: {
  skin: SkinPreset;
  active: boolean;
  onClick: () => void;
}) {
  const accent = skin.tokenOverrides.accent ?? "var(--h-accent)";
  return (
    <button
      type="button"
      className={s.skinCard}
      role="radio"
      aria-checked={active}
      data-active={active ? "true" : undefined}
      onClick={onClick}
      title={skin.description}
    >
      <span className={s.skinPreview} aria-hidden="true" style={{ ["--h-accent" as string]: accent }}>
        <span className={s.skinPreviewTop} />
        <span className={s.skinPreviewBody}>
          <span />
          <span />
          <span />
        </span>
        <span className={s.skinPreviewAccent} />
      </span>
      <span className={s.skinCopy}>
        <span className={s.skinTitle}>{skin.name}</span>
        <span className={s.skinDescription}>{skin.description}</span>
      </span>
    </button>
  );
}
