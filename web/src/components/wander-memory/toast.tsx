// ─────────────────────────────────────────────────────────────────────────────
// components/wander-memory/toast.tsx — route-local toast (Plan B.8.2), scoped
// to the wander-memory subtree. Kept deliberately tiny: a context provider
// renders a fixed-position stack of auto-dismissing notices (role="status"),
// and routes call useWanderMemoryToast().push(kind, message). It does NOT
// replace the app-level toast surface — routes under WanderMemoryLayout may
// use either; this one needs no external plumbing.
// ─────────────────────────────────────────────────────────────────────────────

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import s from "./toast.module.css";

export type WanderMemoryToastKind = "info" | "success" | "error";

interface WanderMemoryToastItem {
  id: number;
  kind: WanderMemoryToastKind;
  message: string;
}

export interface WanderMemoryToastApi {
  push: (kind: WanderMemoryToastKind, message: string) => void;
}

const AUTO_DISMISS_MS = 3000;
const MAX_STACK = 3;

const WanderMemoryToastContext = createContext<WanderMemoryToastApi | null>(null);

export function WanderMemoryToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<WanderMemoryToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef<Map<number, number>>(new Map());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (kind: WanderMemoryToastKind, message: string) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev.slice(-(MAX_STACK - 1)), { id, kind, message }]);
      timers.current.set(id, window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS));
    },
    [dismiss],
  );

  // Clear any pending timers when the provider unmounts.
  useEffect(
    () => () => {
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current.clear();
    },
    [],
  );

  const api = useMemo(() => ({ push }), [push]);

  return (
    <WanderMemoryToastContext.Provider value={api}>
      {children}
      {toasts.length > 0 ? (
        <div className={s.stack} role="status" aria-live="polite">
          {toasts.map((toast) => (
            <div key={toast.id} className={s.toast} data-kind={toast.kind}>
              <span className={s.statusDot} aria-hidden="true" />
              <span className={s.message}>{toast.message}</span>
              <button
                type="button"
                className={s.close}
                aria-label="关闭提示"
                onClick={() => dismiss(toast.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </WanderMemoryToastContext.Provider>
  );
}

export function useWanderMemoryToast(): WanderMemoryToastApi {
  const ctx = useContext(WanderMemoryToastContext);
  if (!ctx) {
    throw new Error("useWanderMemoryToast must be used within WanderMemoryToastProvider");
  }
  return ctx;
}
