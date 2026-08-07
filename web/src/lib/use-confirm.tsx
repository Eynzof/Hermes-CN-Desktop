import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ConfirmDialog,
  type ConfirmDialogSpec,
  type ConfirmInputSpec,
} from "@/components/ui/confirm-dialog";

export interface ConfirmApi {
  /**
   * 应用内确认框，替代 `window.confirm`。resolve true = 用户确认，false = 取消。
   * （window.confirm 在 Tauri webview 里不可靠：macOS WKWebView 下静默返回
   * false 且不弹窗，导致「点击按钮没反应」。）
   */
  confirm: (spec: ConfirmDialogSpec) => Promise<boolean>;
  /**
   * 应用内输入框，替代 `window.prompt`。resolve 输入字符串，取消 / 关闭 resolve null。
   */
  prompt: (spec: ConfirmDialogSpec & { input: ConfirmInputSpec }) => Promise<string | null>;
}

const ConfirmContext = createContext<ConfirmApi | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [spec, setSpec] = useState<ConfirmDialogSpec | null>(null);
  const resolverRef = useRef<((value: boolean | string | null) => void) | null>(null);

  const resolve = useCallback((value: boolean | string | null) => {
    // 防抖：关闭动画期间 onOpenChange 也可能触发一次 resolve，忽略重复调用。
    if (!resolverRef.current) return;
    const pending = resolverRef.current;
    resolverRef.current = null;
    setSpec(null);
    pending(value);
  }, []);

  const confirm = useCallback(
    (next: ConfirmDialogSpec) =>
      new Promise<boolean>((pending) => {
        resolverRef.current = (value) => pending(value === true);
        setSpec(next);
      }),
    [],
  );

  const prompt = useCallback(
    (next: ConfirmDialogSpec & { input: ConfirmInputSpec }) =>
      new Promise<string | null>((pending) => {
        resolverRef.current = (value) => pending(typeof value === "string" ? value : null);
        setSpec(next);
      }),
    [],
  );

  const api = useMemo<ConfirmApi>(() => ({ confirm, prompt }), [confirm, prompt]);

  return (
    <ConfirmContext.Provider value={api}>
      {children}
      <ConfirmDialog spec={spec} onResolve={resolve} />
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmApi {
  const api = useContext(ConfirmContext);
  if (!api) {
    throw new Error("useConfirm must be used within <ConfirmProvider>");
  }
  return api;
}
