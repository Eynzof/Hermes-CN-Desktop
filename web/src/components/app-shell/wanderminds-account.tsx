import { useEffect, useMemo, useState } from "react";
import { useAtom } from "jotai";
import { ChevronDown, CreditCard, LogIn, LogOut, Loader2 } from "lucide-react";
import { Popover } from "@hermes/shared-ui";
import { useNavigate } from "react-router-dom";
import { wandermindsAuthAtom } from "@/stores/auth";
import {
  wandermindsIdLogin,
  wandermindsIdLogout,
  wandermindsIdStatus,
  type UserInfo,
} from "@/lib/wanderminds-id";
import s from "./wanderminds-account.module.css";

function displayName(user: UserInfo | null): string {
  return user?.email || user?.name || "Wanderminds ID";
}

function initials(user: UserInfo | null): string {
  const source = displayName(user).trim();
  if (!source || source === "Wanderminds ID") return "W";
  return source.slice(0, 1).toUpperCase();
}

export function WandermindsAccount() {
  const navigate = useNavigate();
  const [user, setUser] = useAtom(wandermindsAuthAtom);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const accountLabel = useMemo(() => displayName(user), [user]);

  useEffect(() => {
    let cancelled = false;
    wandermindsIdStatus()
      .then((next) => {
        if (!cancelled) setUser(next);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setUser]);

  const handleLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await wandermindsIdLogin();
      setUser(next);
      if (next) navigate("/portal");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    setLoading(true);
    setError(null);
    try {
      await wandermindsIdLogout();
      setUser(null);
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const busy = loading || checking;
  if (!user) {
    return (
      <div className={s.root} data-no-drag>
        <button
          type="button"
          className={s.trigger}
          onClick={handleLogin}
          disabled={busy}
          title={error || "登录 Wanderminds ID"}
          aria-label="登录 Wanderminds ID"
        >
          {busy ? <Loader2 size={16} className={s.spin} /> : <LogIn size={16} />}
          <span className={s.triggerLabel}>{checking ? "检查登录" : "Wanderminds ID"}</span>
        </button>
        {error ? <span className={s.error} role="alert">{error}</span> : null}
      </div>
    );
  }

  return (
    <div className={s.root} data-no-drag>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className={s.trigger}
            title={accountLabel}
            aria-haspopup="menu"
            aria-expanded={open}
          >
            <span className={s.avatar} aria-hidden="true">{initials(user)}</span>
            <span className={s.triggerLabel}>{accountLabel}</span>
            {loading ? <Loader2 size={12} className={s.spin} /> : <ChevronDown size={12} />}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className={s.menu} side="bottom" align="end" sideOffset={8} role="menu">
            <div className={s.menuHeader}>
              <span className={s.menuEyebrow}>Wanderminds ID</span>
              <span className={s.menuAccount}>{accountLabel}</span>
            </div>
            <button
              type="button"
              role="menuitem"
              className={s.menuItem}
              onClick={() => {
                setOpen(false);
                navigate("/portal");
              }}
            >
              <CreditCard size={16} />
              <span>Wander Portal</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className={s.menuItem}
              onClick={handleLogout}
              disabled={loading}
            >
              <LogOut size={16} />
              <span>退出账号</span>
            </button>
            {error ? <div className={s.menuError} role="alert">{error}</div> : null}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
