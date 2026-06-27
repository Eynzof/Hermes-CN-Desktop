import { Alert } from "@hermes/shared-ui";

export interface ActiveCurrentBannerProps {
  /** sticky 默认（active_profile 文件里写的）。 */
  active: string;
  /** 运行中 dashboard 实际绑定的档案。 */
  current: string;
}

/**
 * 当 sticky 默认（active）与运行中 dashboard 绑定的档案（current）不一致时提示。
 * 桌面端切换会自动重启 dashboard，二者一般一致，故此横幅主要出现在 web/attached
 * 模式（已写 sticky 但进程还绑着旧档案，需手动重启才生效）。
 */
export function ActiveCurrentBanner({ active, current }: ActiveCurrentBannerProps) {
  if (active === current) return null;
  return (
    <Alert tone="warning" size="sm" title="sticky 默认与运行中档案不一致">
      默认档案已是 <code>{active}</code>，但当前 dashboard 仍在运行 <code>{current}</code>。
      重启 dashboard 后才会真正加载 <code>{active}</code> 的 config / sessions。
    </Alert>
  );
}
