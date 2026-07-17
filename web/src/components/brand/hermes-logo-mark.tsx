import hermesLogo from "@/assets/hermes-default-avatar.png";

interface HermesLogoMarkProps {
  size?: number;
  className?: string;
  title?: string;
  /** 保留旧「H」立体 SVG 标的接口签名；位图 logo 不再区分明暗色调。 */
  tone?: "light" | "dark";
}

/** 品牌标：与 Hermes 默认头像同源的位图（原为「H」立体 SVG 标）。 */
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
        borderRadius: Math.max(4, Math.round(size * 0.22)),
        objectFit: "cover",
        display: "block",
      }}
      draggable={false}
    />
  );
}
