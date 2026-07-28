import hermesLogo from "@/assets/hermes-default-avatar.png";

interface HermesLogoMarkProps {
  size?: number;
  className?: string;
  title?: string;
  /** 黑白灰位图在所有主题下保持一致，保留 tone 仅兼容既有调用。 */
  tone?: "light" | "dark";
}

/** Hermes 中文社区桌面版统一使用的黑白灰品牌标。 */
export function HermesLogoMark({ size = 22, className, title }: HermesLogoMarkProps) {
  return (
    <img
      src={hermesLogo}
      width={size}
      height={size}
      className={className}
      alt={title ?? ""}
      aria-hidden={title ? undefined : true}
      style={{
        borderRadius: Math.min(8, Math.max(3, Math.round(size * 0.12))),
        objectFit: "cover",
        display: "block",
      }}
      draggable={false}
    />
  );
}
