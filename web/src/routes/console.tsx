import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { ExternalLink, Play, Power, RotateCcw, TerminalSquare } from "lucide-react";
import type { TerminalEventPayload, TerminalStartResult } from "@/lib/runtime";
import { openExternalUrl } from "@/lib/external-links";
import { runtime } from "@/lib/runtime";
import { SectionShell } from "./section-shell";
import s from "./console.module.css";

type ConsoleStatus = "starting" | "ready" | "error" | "closed" | "unsupported";

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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const pendingEventsRef = useRef<TerminalEventPayload[]>([]);
  const [status, setStatus] = useState<ConsoleStatus>("starting");
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<TerminalStartResult | null>(null);
  const [lastCommand, setLastCommand] = useState<string | null>(null);
  const [externalOpening, setExternalOpening] = useState(false);
  const [externalOpened, setExternalOpened] = useState<string | null>(null);

  const isDesktopTerminalAvailable = Boolean(window.hermesDesktop?.terminalStart);
  const isExternalTerminalAvailable = Boolean(window.hermesDesktop?.terminalOpenExternal);
  const autoPurpose = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const run = params.get("run") ?? params.get("command") ?? "";
    if (["gateway-setup", "gatewaySetup", "gateway_setup"].includes(run)) return "gatewaySetup" as const;
    if (["gateway-status", "gatewayStatus", "gateway_status"].includes(run)) return "gatewayStatus" as const;
    return "shell" as const;
  }, [location.search]);

  const statusText = useMemo(() => {
    if (status === "ready") return "已连接";
    if (status === "starting") return "正在打开终端…";
    if (status === "closed") return "终端已关闭";
    if (status === "unsupported") return "请在桌面端使用";
    return "终端不可用";
  }, [status]);

  useEffect(() => {
    if (!containerRef.current) return;

    if (!isDesktopTerminalAvailable) {
      setStatus("unsupported");
      setError("Hermes Console 需要在桌面端中打开。浏览器预览只能查看页面，不能启动本地终端。");
      return;
    }

    let disposed = false;
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: "JetBrains Mono, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13.5,
      lineHeight: 1.22,
      letterSpacing: 0.1,
      scrollback: 4000,
      convertEol: true,
      theme: {
        background: "#080807",
        foreground: "#f5efe5",
        cursor: "#ffb35c",
        selectionBackground: "#5a3b22",
        black: "#191714",
        red: "#d76f54",
        green: "#7fc083",
        yellow: "#d7a84d",
        blue: "#7aa7d9",
        magenta: "#b989d6",
        cyan: "#74b8c4",
        white: "#f3eee6",
        brightBlack: "#6f675d",
        brightRed: "#ff8b6e",
        brightGreen: "#9fe1a5",
        brightYellow: "#ffd074",
        brightBlue: "#9cc9ff",
        brightMagenta: "#d9a9ff",
        brightCyan: "#9be7ef",
        brightWhite: "#fffaf1",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_event, uri) => {
      void openExternalUrl(uri);
    }));
    term.open(containerRef.current);
    fit.fit();
    term.focus();
    terminalRef.current = term;
    fitRef.current = fit;

    const writeBanner = () => {
      term.writeln("\x1b[38;5;214mHermes\x1b[0m \x1b[38;5;81mConsole\x1b[0m");
      term.writeln("这里是真实终端。你可以直接输入 Hermes 命令，也可以点下方常用操作自动填入。推荐先运行 hermes。");
      if (autoPurpose === "gatewaySetup") {
        term.writeln("正在为你打开消息平台接入向导\r\n");
      } else if (autoPurpose === "gatewayStatus") {
        term.writeln("正在为你查看消息平台接入状态\r\n");
      } else {
        term.writeln("");
      }
    };
    writeBanner();

    const writeEvent = (event: TerminalEventPayload) => {
      const id = terminalIdRef.current;
      if (!id) {
        pendingEventsRef.current.push(event);
        return;
      }
      if (event.terminalId !== id) return;
      if (event.kind === "data" && event.data) {
        term.write(event.data);
      } else if (event.kind === "error") {
        term.writeln(`\r\n\x1b[31m终端错误：${event.message ?? "未知错误"}\x1b[0m`);
        setError(event.message ?? "终端错误");
        setStatus("error");
      } else if (event.kind === "exit") {
        const suffix = typeof event.exitCode === "number" ? `，退出码 ${event.exitCode}` : "";
        term.writeln(`\r\n\x1b[90m终端已结束${suffix}。\x1b[0m`);
        setStatus("closed");
      }
    };

    const unlisten = window.hermesDesktop?.onTerminalOutput?.(writeEvent);
    const disposable = term.onData((data) => {
      const id = terminalIdRef.current;
      if (!id) return;
      void window.hermesDesktop?.terminalWrite?.({ terminalId: id, data }).catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });
    });

    const resize = () => {
      if (disposed) return;
      try {
        fit.fit();
        const id = terminalIdRef.current;
        if (id) {
          void window.hermesDesktop?.terminalResize?.({ terminalId: id, cols: term.cols, rows: term.rows });
        }
      } catch {
        // xterm fit may throw while the container is being mounted or hidden; the next resize fixes it.
      }
    };

    const scheduleResize = () => {
      window.requestAnimationFrame(() => {
        resize();
        window.requestAnimationFrame(resize);
      });
      window.setTimeout(resize, 160);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(containerRef.current);
    scheduleResize();

    window.hermesDesktop
      ?.terminalStart?.({ purpose: autoPurpose, cols: term.cols, rows: term.rows })
      .then((result) => {
        if (disposed) return;
        terminalIdRef.current = result.terminalId;
        setSession(result);
        setStatus("ready");
        const pending = pendingEventsRef.current.splice(0);
        pending.forEach(writeEvent);
        scheduleResize();
      })
      .catch((err) => {
        if (disposed) return;
        const message = err instanceof Error ? err.message : String(err);
        term.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
        setError(message);
        setStatus("error");
      });

    return () => {
      disposed = true;
      observer.disconnect();
      disposable.dispose();
      unlisten?.();
      const id = terminalIdRef.current;
      terminalIdRef.current = null;
      if (id) void window.hermesDesktop?.terminalClose?.({ terminalId: id });
      term.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [autoPurpose, isDesktopTerminalAvailable]);

  const runCommand = (command: string) => {
    const id = terminalIdRef.current;
    const term = terminalRef.current;
    if (!id || !term || status !== "ready") return;
    setLastCommand(command);
    term.focus();
    void window.hermesDesktop?.terminalWrite?.({ terminalId: id, data: `${command}\r` });
  };

  const restartTerminal = () => {
    window.location.reload();
  };

  const closeTerminal = () => {
    const id = terminalIdRef.current;
    if (!id) return;
    terminalIdRef.current = null;
    void window.hermesDesktop?.terminalClose?.({ terminalId: id });
    setStatus("closed");
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
          <button type="button" className={s.dangerButton} onClick={closeTerminal} disabled={!terminalIdRef.current}>
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
            <div ref={containerRef} className={s.terminalSurface} />
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
