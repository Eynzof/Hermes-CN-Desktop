import { useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { ExternalLink, Play, Power, RotateCcw, TerminalSquare } from "lucide-react";
import type { TerminalStartResult } from "@/lib/runtime";
import {
  EmbeddedTerminal,
  type EmbeddedTerminalHandle,
  type TerminalPurpose,
  type TerminalStatus,
} from "@/components/console/embedded-terminal";
import { SectionShell } from "./section-shell";
import s from "./console.module.css";

interface CommandAction {
  label: string;
  command: string;
  desc: string;
}

const QUICK_COMMANDS: CommandAction[] = [
  {
    label: "打开 Hermes",
    command: "hermes",
    desc: "进入 Hermes 命令入口，直接按提示完成对话、配置和接入操作。",
  },
  {
    label: "查看接入状态",
    command: "hermes gateway status",
    desc: "确认当前消息网关是否在线，以及正在使用哪个配置。",
  },
  {
    label: "检查 Hermes 配置",
    command: "hermes setup",
    desc: "重新进入 Hermes 基础配置向导，补齐模型、密钥和本地目录。",
  },
  {
    label: "查看可用命令",
    command: "hermes --help",
    desc: "打开命令帮助，了解当前版本支持的操作。",
  },
];

function normalizePath(path?: string | null) {
  if (!path) return "—";
  if (path.length <= 58) return path;
  return `…${path.slice(-55)}`;
}

export function ConsoleRoute() {
  const location = useLocation();
  const terminalRef = useRef<EmbeddedTerminalHandle | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("starting");
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<TerminalStartResult | null>(null);
  const [lastCommand, setLastCommand] = useState<string | null>(null);
  const [externalOpening, setExternalOpening] = useState(false);
  const [externalOpened, setExternalOpened] = useState<string | null>(null);

  const isExternalTerminalAvailable = Boolean(window.hermesDesktop?.terminalOpenExternal);
  const autoPurpose = useMemo<TerminalPurpose>(() => {
    const params = new URLSearchParams(location.search);
    const run = params.get("run") ?? params.get("command") ?? "";
    if (["gateway-setup", "gatewaySetup", "gateway_setup"].includes(run)) return "gatewaySetup";
    if (["gateway-status", "gatewayStatus", "gateway_status"].includes(run)) return "gatewayStatus";
    return "shell";
  }, [location.search]);

  const statusText = useMemo(() => {
    if (status === "ready") return "已连接";
    if (status === "starting") return "正在打开终端…";
    if (status === "closed") return "终端已关闭";
    if (status === "unsupported") return "请在桌面端使用";
    return "终端不可用";
  }, [status]);

  const runCommand = (command: string) => {
    if (status !== "ready") return;
    setLastCommand(command);
    terminalRef.current?.runCommand(command);
  };

  const restartTerminal = () => {
    window.location.reload();
  };

  const closeTerminal = () => {
    terminalRef.current?.close();
  };

  const openExternalTerminal = () => {
    if (!window.hermesDesktop?.terminalOpenExternal || externalOpening) return;
    setExternalOpening(true);
    setExternalOpened(null);
    setError(null);
    window.hermesDesktop
      .terminalOpenExternal({ purpose: autoPurpose })
      .then((result) => {
        setExternalOpened(`已在 ${result.terminal} 打开：${result.command}`);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setExternalOpening(false));
  };

  return (
    <SectionShell
      title="Hermes Console"
      sub={statusText}
      right={
        <div className={s.topActions}>
          <button
            type="button"
            className={s.secondaryButton}
            onClick={openExternalTerminal}
            disabled={!isExternalTerminalAvailable || externalOpening}
          >
            <ExternalLink size={13} />
            {externalOpening ? "正在打开…" : "在外部终端打开"}
          </button>
          <button type="button" className={s.secondaryButton} onClick={restartTerminal}>
            <RotateCcw size={13} />
            重新打开
          </button>
          <button type="button" className={s.dangerButton} onClick={closeTerminal} disabled={status !== "ready"}>
            <Power size={13} />
            关闭终端
          </button>
        </div>
      }
    >
      <div className={s.layout}>
        <section className={s.mainColumn}>
          <div className={s.summaryCard}>
            <div>
              <div className={s.eyebrow}>本地命令环境</div>
              <h2>直接操作 Hermes，不需要离开桌面端。</h2>
              <p>
                这里会使用桌面端已经准备好的 Hermes 运行环境。你输入的命令会真实执行，适合配置接入、排查状态，或按文档执行高级操作。
              </p>
            </div>
            <div className={s.summaryStats}>
              <div>
                <span>Hermes 命令</span>
                <strong>{session?.managedRuntime ? "已就绪" : "等待运行时"}</strong>
              </div>
              <div>
                <span>工作目录</span>
                <strong title={session?.cwd}>{normalizePath(session?.cwd)}</strong>
              </div>
            </div>
          </div>

          <div className={s.terminalCard} data-status={status}>
            <div className={s.terminalHeader}>
              <div className={s.terminalTitle}>
                <TerminalSquare size={15} />
                <span>终端</span>
              </div>
              <div className={s.terminalMeta}>
                <span className={s.statusDot} />
                {statusText}
              </div>
            </div>
            <EmbeddedTerminal
              ref={terminalRef}
              purpose={autoPurpose}
              className={s.terminalSurface}
              onStatusChange={setStatus}
              onSession={setSession}
              onError={setError}
            />
          </div>

          {error && <div className={s.errorBox}>{error}</div>}
          {externalOpened && <div className={s.infoBox}>{externalOpened}</div>}
        </section>

        <aside className={s.sideColumn}>
          <div className={s.panel}>
            <div className={s.panelTitle}>常用操作</div>
            <div className={s.commandList}>
              {QUICK_COMMANDS.map((item) => (
                <button
                  key={item.command}
                  type="button"
                  className={s.commandCard}
                  onClick={() => runCommand(item.command)}
                  disabled={status !== "ready"}
                  data-active={lastCommand === item.command ? "true" : undefined}
                >
                  <span className={s.commandCardHead}>
                    <Play size={12} />
                    {item.label}
                  </span>
                  <code>{item.command}</code>
                  <span>{item.desc}</span>
                </button>
              ))}
            </div>
          </div>

          <div className={s.panel}>
            <div className={s.panelTitle}>接入提示</div>
            <p className={s.helpText}>
              推荐先点击“打开 Hermes”。进入 Hermes 命令入口后，你可以按提示完成对话、配置和飞书、微信等消息入口接入。
            </p>
            <p className={s.helpText}>
              这个终端默认使用当前档案的 <code>HERMES_HOME</code>，不会切到其它档案，也不会读浏览器里的临时状态。
            </p>
          </div>
        </aside>
      </div>
    </SectionShell>
  );
}
