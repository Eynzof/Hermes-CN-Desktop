import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtom } from "jotai";
import {
  ArrowUpRight,
  CheckCircle2,
  CircleDollarSign,
  CreditCard,
  Loader2,
  LogIn,
  RefreshCw,
  ShieldCheck,
  TicketCheck,
} from "lucide-react";
import type {
  WanderPortalAccountState,
  WanderPortalOrder,
  WanderPortalPlan,
  WanderPortalUsageItem,
} from "@hermes/protocol";
import { wandermindsAuthAtom } from "@/stores/auth";
import { wandermindsIdLogin, wandermindsIdStatus } from "@/lib/wanderminds-id";
import {
  createWanderCheckout,
  formatFen,
  formatMicroCny,
  getWanderPortalAccountState,
  getWanderPortalOrder,
  getWanderPortalPlans,
  getWanderPortalUsage,
  openWanderCheckout,
  openWanderPortal,
  redeemWanderInvite,
} from "@/lib/wander-portal";
import type { TauriIpcError } from "@/lib/tauri-bridge";
import { SectionShell } from "./section-shell";
import s from "./portal.module.css";

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

export function PortalRoute() {
  const [user, setUser] = useAtom(wandermindsAuthAtom);
  const [account, setAccount] = useState<WanderPortalAccountState | null>(null);
  const [plans, setPlans] = useState<WanderPortalPlan[]>([]);
  const [usage, setUsage] = useState<WanderPortalUsageItem[]>([]);
  const [usageCursor, setUsageCursor] = useState<string | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [inviteCode, setInviteCode] = useState("");
  const [pendingOrder, setPendingOrder] = useState<WanderPortalOrder | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const betaPlan = useMemo(
    () => plans.find((plan) => plan.slug === "wander-beta-monthly") ?? plans[0],
    [plans],
  );

  const refresh = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const [nextAccount, nextPlans, nextUsage] = await Promise.all([
        getWanderPortalAccountState(),
        getWanderPortalPlans(),
        getWanderPortalUsage(),
      ]);
      setAccount(nextAccount);
      setPlans(nextPlans);
      setUsage(nextUsage.items);
      setUsageCursor(nextUsage.next_cursor ?? null);
    } catch (reason) {
      const portalError = reason as TauriIpcError;
      if (portalError.code === "login_required" || portalError.code === "reauth_required") {
        setUser(null);
        setAccount(null);
      }
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [setUser, user]);

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
        if (!cancelled) setCheckingAuth(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setUser]);

  useEffect(() => {
    if (user) void refresh();
  }, [refresh, user]);

  useEffect(() => {
    const handleFocus = async () => {
      if (!user) return;
      if (pendingOrder) {
        try {
          const order = await getWanderPortalOrder(pendingOrder.id);
          setPendingOrder(order);
          if (order.status === "fulfilled") {
            setNotice("测试支付已入账，Wander 额度已更新。无需重启即可继续使用。");
          } else if (order.status === "failed" || order.status === "cancelled") {
            setNotice(`订单状态：${order.status}`);
          }
        } catch (reason) {
          setError(errorMessage(reason));
        }
      }
      await refresh();
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [pendingOrder, refresh, user]);

  const login = async () => {
    setAction("login");
    setError(null);
    try {
      setUser(await wandermindsIdLogin());
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setAction(null);
      setCheckingAuth(false);
    }
  };

  const redeemInvite = async () => {
    const code = inviteCode.trim();
    if (!code) return;
    setAction("invite");
    setError(null);
    try {
      await redeemWanderInvite(code);
      setInviteCode("");
      setNotice("邀请码已绑定到当前 Wanderminds ID。");
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setAction(null);
    }
  };

  const checkout = async (kind: "subscription" | "topup") => {
    setAction(kind);
    setError(null);
    setNotice(null);
    try {
      const session = await createWanderCheckout(
        kind,
        kind === "subscription" ? betaPlan?.slug : undefined,
      );
      setPendingOrder({
        id: session.order_id,
        kind,
        status: "pending",
        amount_fen: kind === "subscription" ? betaPlan?.price_fen ?? 0 : 1,
        grant_micro_cny: kind === "subscription" ? betaPlan?.included_micro_cny ?? 0 : 10_000_000,
        checkout_expires_at: session.expires_at,
        created_at: new Date().toISOString(),
      });
      await openWanderCheckout(session);
      setNotice("结算页已在系统浏览器打开。完成后回到桌面端，余额会自动刷新。");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setAction(null);
    }
  };

  const loadMore = async () => {
    if (!usageCursor) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await getWanderPortalUsage(usageCursor);
      setUsage((current) => [...current, ...page.items]);
      setUsageCursor(page.next_cursor ?? null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoadingMore(false);
    }
  };

  if (checkingAuth) {
    return (
      <SectionShell title="Wander Portal" sub="Wanderminds ID、套餐、余额与用量">
        <div className={s.loading}><Loader2 size={20} /> 正在检查 Wanderminds ID…</div>
      </SectionShell>
    );
  }

  if (!user) {
    return (
      <SectionShell title="Wander Portal" sub="一次登录，在社区桌面端直接使用 Wander 模型">
        <div className={s.hero}>
          <div className={s.heroIcon}><ShieldCheck size={24} /></div>
          <div>
            <div className={s.eyebrow}>TOKYO STAGING · INVITE ONLY</div>
            <h1>使用 Wanderminds ID 接入 Wander 模型</h1>
            <p>登录在系统浏览器中完成。Refresh Token 只保存在 macOS Keychain，managed Core 只取得短期 Access Token。</p>
          </div>
          <button type="button" className={s.primaryButton} onClick={login} disabled={action === "login"}>
            {action === "login" ? <Loader2 size={16} /> : <LogIn size={16} />}
            登录 Wanderminds ID
          </button>
        </div>
        {error ? <div className={s.alert} data-tone="danger" role="alert">{error}</div> : null}
        <div className={s.testNotice}>测试环境，不代表正式售价。当前仅面向受邀社区成员。</div>
      </SectionShell>
    );
  }

  return (
    <SectionShell
      title="Wander Portal"
      sub="套餐、额度与不含正文的模型用量"
      right={
        <button type="button" className={s.refreshButton} onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={12} /> 刷新
        </button>
      }
    >
      <div className={s.page}>
        <div className={s.testNotice}>{account?.environment_notice ?? "测试环境，不代表正式售价"}</div>
        {notice ? <div className={s.alert} data-tone="success"><CheckCircle2 size={16} /> {notice}</div> : null}
        {error ? <div className={s.alert} data-tone="danger" role="alert">{error}</div> : null}

        {!account && loading ? (
          <div className={s.loading}><Loader2 size={20} /> 正在读取 Wander Portal…</div>
        ) : account ? (
          <>
            <section className={s.summaryGrid} aria-label="Wander 账户摘要">
              <div className={s.metricCard}>
                <span>可用总额度</span>
                <strong>{formatMicroCny(account.balance.total_micro_cny)}</strong>
                <small>订阅额度优先消耗</small>
              </div>
              <div className={s.metricCard}>
                <span>当期包含额度</span>
                <strong>{formatMicroCny(account.balance.included_micro_cny)}</strong>
                <small>到期清零</small>
              </div>
              <div className={s.metricCard}>
                <span>充值余额</span>
                <strong>{formatMicroCny(account.balance.purchased_micro_cny)}</strong>
                <small>预发布阶段不失效</small>
              </div>
              <div className={s.metricCard}>
                <span>当期用量</span>
                <strong>{formatMicroCny(account.current_period_usage_micro_cny)}</strong>
                <small>仅保存计量元数据</small>
              </div>
            </section>

            {!account.invite_eligible ? (
              <section className={s.panel}>
                <div className={s.panelHeading}>
                  <TicketCheck size={20} />
                  <div><h2>兑换内测资格</h2><p>邀请码只会绑定到当前 Wanderminds ID。</p></div>
                </div>
                <div className={s.inviteForm}>
                  <input
                    value={inviteCode}
                    onChange={(event) => setInviteCode(event.target.value)}
                    placeholder="输入社区邀请码"
                    autoComplete="off"
                  />
                  <button type="button" className={s.primaryButton} onClick={redeemInvite} disabled={!inviteCode.trim() || action === "invite"}>
                    {action === "invite" ? <Loader2 size={16} /> : <TicketCheck size={16} />}
                    兑换
                  </button>
                </div>
              </section>
            ) : (
              <section className={s.planGrid}>
                <div className={s.panel}>
                  <div className={s.panelHeading}>
                    <CreditCard size={20} />
                    <div><h2>{account.subscription?.plan.name ?? betaPlan?.name ?? "Wander Beta"}</h2><p>30 天月度测试套餐</p></div>
                  </div>
                  <dl className={s.detailList}>
                    <div><dt>状态</dt><dd>{account.subscription?.status ?? "未开通"}</dd></div>
                    <div><dt>测试价格</dt><dd>{formatFen(betaPlan?.price_fen ?? 1)}</dd></div>
                    <div><dt>包含额度</dt><dd>{formatMicroCny(betaPlan?.included_micro_cny ?? 10_000_000)}</dd></div>
                    <div><dt>自动续费</dt><dd>{account.subscription?.auto_renew ? "已开启" : "未开启"}</dd></div>
                    <div><dt>当期结束</dt><dd>{formatDate(account.subscription?.current_period_end)}</dd></div>
                  </dl>
                  <div className={s.actions}>
                    {!account.subscription ? (
                      <button type="button" className={s.primaryButton} onClick={() => void checkout("subscription")} disabled={action !== null}>
                        {action === "subscription" ? <Loader2 size={16} /> : <CreditCard size={16} />}
                        开通测试套餐
                      </button>
                    ) : null}
                    <button type="button" className={s.secondaryButton} onClick={() => void openWanderPortal(account.portal_url)}>
                      管理订阅 <ArrowUpRight size={12} />
                    </button>
                  </div>
                </div>

                <div className={s.panel}>
                  <div className={s.panelHeading}>
                    <CircleDollarSign size={20} />
                    <div><h2>测试充值</h2><p>支付 ¥0.01，授予 ¥10.00 测试额度。</p></div>
                  </div>
                  <p className={s.panelCopy}>充值余额不会转换为现金。预发布测试支付不会产生真实资金。</p>
                  <div className={s.actions}>
                    <button type="button" className={s.primaryButton} onClick={() => void checkout("topup")} disabled={action !== null}>
                      {action === "topup" ? <Loader2 size={16} /> : <CircleDollarSign size={16} />}
                      充值测试额度
                    </button>
                  </div>
                </div>
              </section>
            )}

            {pendingOrder ? (
              <section className={s.orderStrip}>
                <span>最近订单</span>
                <code>{pendingOrder.id}</code>
                <strong data-status={pendingOrder.status}>{pendingOrder.status}</strong>
              </section>
            ) : null}

            <section className={s.panel}>
              <div className={s.panelHeading}>
                <ShieldCheck size={20} />
                <div><h2>用量明细</h2><p>不保存提示词、回复正文或工具参数。</p></div>
              </div>
              <div className={s.tableWrap}>
                <table className={s.table}>
                  <thead><tr><th>时间</th><th>模型</th><th>输入</th><th>输出</th><th>缓存</th><th>费用</th><th>状态</th></tr></thead>
                  <tbody>
                    {usage.length === 0 ? (
                      <tr><td colSpan={7} className={s.empty}>暂无用量记录</td></tr>
                    ) : usage.map((item) => (
                      <tr key={item.id}>
                        <td>{formatDate(item.created_at)}</td>
                        <td className={s.model}>{item.model}</td>
                        <td>{formatTokens(item.input_tokens)}</td>
                        <td>{formatTokens(item.output_tokens)}</td>
                        <td>{formatTokens(item.cached_tokens)}</td>
                        <td>{formatMicroCny(item.cost_micro_cny)}</td>
                        <td>{item.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {usageCursor ? (
                <button type="button" className={s.loadMore} onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? <Loader2 size={12} /> : null} 加载更多
                </button>
              ) : null}
            </section>
          </>
        ) : null}
      </div>
    </SectionShell>
  );
}
