import { useId } from "react";

interface HermesLogoMarkProps {
  size?: number;
  className?: string;
  title?: string;
  tone?: "light" | "dark";
}

const MARK_COLORS = {
  light: {
    background: "#f6f1e3",
    face: "#0a0908",
    side: "#3a3633",
    top: "#2a2620",
    bridgeSide: "#005FF9",
    bridge: "#005FF9",
  },
  dark: {
    background: "#0a0908",
    face: "#f6f1e3",
    side: "#6e685f",
    top: "#3a3633",
    bridgeSide: "#005FF9",
    bridge: "#005FF9",
  },
} as const;

export function HermesLogoMark({
  size = 22,
  className,
  title,
  tone = "light",
}: HermesLogoMarkProps) {
  const clipId = `hermes-logo-${useId().replace(/:/g, "")}`;
  const colors = MARK_COLORS[tone];

  return (
    <svg
      viewBox="0 0 80 80"
      width={size}
      height={size}
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs>
        <clipPath id={clipId}>
          <rect width="80" height="80" rx="18" />
        </clipPath>
      </defs>
      <rect width="80" height="80" rx="18" fill={colors.background} />
      <g clipPath={`url(#${clipId})`}>
        <g transform="translate(-2,2)">
          <polygon points="58,22 58,58 62,54 62,18" fill={colors.side} />
          <polygon points="50,22 58,22 62,18 54,18" fill={colors.top} />
          <polygon points="30,36 50,36 54,32 34,32" fill={colors.bridgeSide} />
          <polygon points="30,22 30,36 34,32 34,18" fill={colors.side} />
          <polygon points="30,44 30,58 34,54 34,40" fill={colors.side} />
          <polygon points="22,22 30,22 34,18 26,18" fill={colors.top} />
          <path d="M22,22 H30 V36 H50 V22 H58 V58 H50 V44 H30 V58 H22 Z" fill={colors.face} />
          <rect x="30" y="36" width="20" height="8" fill={colors.bridge} />
        </g>
      </g>
    </svg>
  );
}
