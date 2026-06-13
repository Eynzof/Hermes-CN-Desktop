import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { TerminalEventPayload, TerminalStartResult } from "@/lib/runtime";
import { openExternalUrl } from "@/lib/external-links";

export type TerminalStatus = "starting" | "ready" | "error" | "closed" | "unsupported";
export type TerminalPurpose = "shell" | "gatewaySetup" | "gatewayStatus";

export interface EmbeddedTerminalHandle {
  /** Type a command into the live terminal (no-op until ready). */
  runCommand: (command: string) => void;
  /** Close the underlying terminal process. */
  close: () => void;
  /** Whether a terminal process is currently attached. */
  hasTerminal: () => boolean;
}

interface EmbeddedTerminalProps {
  purpose?: TerminalPurpose;
  /** Applied to the terminal surface element. */
  className?: string;
  /** Write the intro banner on open (default true). */
  showBanner?: boolean;
  onStatusChange?: (status: TerminalStatus) => void;
  onSession?: (session: TerminalStartResult) => void;
  onError?: (message: string | null) => void;
}

/**
 * Self-contained xterm.js terminal bound to the desktop terminal IPC bridge.
 * Encapsulates the open → terminalStart → stream → cleanup lifecycle so both
 * the standalone Console route and the task-detail right rail share one widget.
 */
export const EmbeddedTerminal = forwardRef<EmbeddedTerminalHandle, EmbeddedTerminalProps>(
  function EmbeddedTerminal(
    { purpose = "shell", className, showBanner = true, onStatusChange, onSession, onError },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const terminalIdRef = useRef<string | null>(null);
    const pendingEventsRef = useRef<TerminalEventPayload[]>([]);
    const [status, setStatus] = useState<TerminalStatus>("starting");
    const [armed, setArmed] = useState(false);

    // Notify the consumer of status transitions without coupling its render.
    useEffect(() => {
      onStatusChange?.(status);
    }, [status, onStatusChange]);

    useImperativeHandle(ref, () => ({
      runCommand: (command: string) => {
        const id = terminalIdRef.current;
        const term = terminalRef.current;
        if (!id || !term) return;
        term.focus();
        void window.hermesDesktop?.terminalWrite?.({ terminalId: id, data: `${command}\r` });
      },
      close: () => {
        const id = terminalIdRef.current;
        if (!id) return;
        terminalIdRef.current = null;
        void window.hermesDesktop?.terminalClose?.({ terminalId: id });
        setStatus("closed");
      },
      hasTerminal: () => terminalIdRef.current !== null,
    }));

    // Delay mount briefly so the container has a measured size before xterm fits.
    useEffect(() => {
      const timer = window.setTimeout(() => setArmed(true), 250);
      return () => window.clearTimeout(timer);
    }, []);

    useEffect(() => {
      if (!armed || !containerRef.current) return;

      if (!window.hermesDesktop?.terminalStart) {
        setStatus("unsupported");
        onError?.("Hermes 终端需要在桌面端中打开。");
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
      term.loadAddon(
        new WebLinksAddon((_event, uri) => {
          void openExternalUrl(uri);
        }),
      );
      term.open(containerRef.current);
      fit.fit();
      term.focus();
      terminalRef.current = term;

      if (showBanner) {
        term.writeln("\x1b[38;5;214mHermes\x1b[0m \x1b[38;5;81mConsole\x1b[0m");
        term.writeln(
          "这里是真实终端。你可以直接输入 Hermes 命令，也可以点常用操作自动填入。推荐先运行 hermes。",
        );
        if (purpose === "gatewaySetup") {
          term.writeln("正在为你打开消息平台接入向导\r\n");
        } else if (purpose === "gatewayStatus") {
          term.writeln("正在为你查看消息平台接入状态\r\n");
        } else {
          term.writeln("");
        }
      }

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
          onError?.(event.message ?? "终端错误");
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
          onError?.(err instanceof Error ? err.message : String(err));
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
          // xterm fit may throw while the container is hidden; the next resize fixes it.
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
        ?.terminalStart?.({ purpose, cols: term.cols, rows: term.rows })
        .then((result) => {
          if (disposed) return;
          terminalIdRef.current = result.terminalId;
          onSession?.(result);
          setStatus("ready");
          const pending = pendingEventsRef.current.splice(0);
          pending.forEach(writeEvent);
          scheduleResize();
        })
        .catch((err) => {
          if (disposed) return;
          const message = err instanceof Error ? err.message : String(err);
          term.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
          onError?.(message);
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
      };
      // onStatusChange/onError/onSession are intentionally excluded — they would
      // re-create the whole terminal on every parent render.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [armed, purpose, showBanner]);

    return <div ref={containerRef} className={className} />;
  },
);
