import { useEffect, useState } from "react";
import { RefreshCw, ReceiptText } from "lucide-react";
import { TopBarActionButton } from "@/components/top-bar/top-bar";
import { SectionShell } from "./section-shell";
import { useAccountStatus } from "@/hooks/use-account";
import { runtime } from "@/lib/runtime";
import type { AccountTransactionInfo, AccountTransactionsInfo } from "@/lib/runtime";
import s from "./usage.module.css";

export function UsageRoute() {
  const { data: status } = useAccountStatus();
  const [data, setData] = useState<AccountTransactionsInfo | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const load = async () => {
    setLoading(true); setError("");
    try {
      if (!window.hermesDesktop?.accountTransactions) throw new Error("账单仅支持桌面版账号");
      setData(await window.hermesDesktop.accountTransactions({ limit: 20, offset: page * 20 }));
    } catch (e) { setError(e instanceof Error ? e.message : "无法加载 ccwork 账单"); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (status?.loggedIn) void load(); }, [page, status?.loggedIn]);
  const rows: AccountTransactionInfo[] = data?.transactions ?? [];
  return <SectionShell title="使用情况" sub="ccwork 组织账单与模型消费明细" right={<TopBarActionButton onClick={() => void load()} loading={loading} leadingIcon={<RefreshCw size={12} />}>刷新</TopBarActionButton>}>
    <div className={s.page}>
      {!status?.loggedIn ? <div className={s.state}><ReceiptText size={24} /><div><strong>请先登录 ccwork</strong><p>登录后可以查看钱包扣费和具体模型。</p></div></div> : error ? <div className={s.state} data-tone="error"><ReceiptText size={24} /><div><strong>无法加载 ccwork 账单</strong><p>{error}</p></div></div> : loading && !data ? <div className={s.state}>正在加载账单…</div> : rows.length ? <div className={s.tableWrap}><table><thead><tr><th>时间</th><th>模型</th><th>说明</th><th>消耗额度</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{new Date(row.createdAt).toLocaleString()}</td><td><strong>{row.modelName || "未知模型"}</strong>{row.providerKey && <small>{row.providerKey}</small>}</td><td>{row.description}{row.meterKey && <small>{row.meterKey}{row.quantity && row.unit ? ` · ${row.quantity} ${row.unit}` : ""}</small>}</td><td>{Math.abs(Number(row.amountPrecise)).toLocaleString(undefined, { maximumFractionDigits: 6 })}</td></tr>)}</tbody></table></div> : <div className={s.state}>暂无 ccwork 消费记录。</div>}
      {data && <div className={s.pagination}><button disabled={page === 0 || loading} onClick={() => setPage((v) => v - 1)}>上一页</button><span>{page + 1} / {Math.max(1, Math.ceil(data.total / 20))}</span><button disabled={(page + 1) * 20 >= data.total || loading} onClick={() => setPage((v) => v + 1)}>下一页</button></div>}
    </div>
  </SectionShell>;
}
