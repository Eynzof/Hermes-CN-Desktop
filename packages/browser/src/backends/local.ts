import type { BrowserConfig, BrowserSessionRecord } from "../schemas.js";
import { BrowserBackendKind } from "../schemas.js";
import type {
  BrowserOperationResult,
  BrowserProvider,
  CreateSessionResult,
} from "../provider.js";
import { evaluateUrlSafety, assertSafeUrl } from "../ssrf.js";

export interface LocalBackendOptions {
  /** Optional bridge used to talk to the Rust sidecar; mockable in tests. */
  invoke?: (command: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Local browser backend implemented via a Rust/Node sidecar that owns the
 * Playwright/CDP connection. The TS side only holds metadata and forwards
 * commands through the supplied invoker.
 */
export class LocalBrowserProvider implements BrowserProvider {
  readonly name = BrowserBackendKind.Enum.local;
  readonly displayName = "Local Browser (CDP / agent-browser)";

  constructor(private readonly options: LocalBackendOptions = {}) {}

  async isAvailable(_config: BrowserConfig): Promise<boolean> {
    // Local is always available as a fallback; actual binary presence is checked
    // lazily by the sidecar launcher.
    return true;
  }

  async createSession(taskId: string, config: BrowserConfig): Promise<CreateSessionResult> {
    const result = (await this.invoke("browser_sidecar_start", {
      taskId,
      engine: config.engine,
      headed: config.headed,
      recordSessions: config.recordSessions,
    })) as { cdpUrl?: string; sessionName?: string };
    return {
      taskId,
      backend: this.name,
      cdpUrl: result.cdpUrl,
      sessionName: result.sessionName ?? `local-${taskId}`,
    };
  }

  async closeSession(session: BrowserSessionRecord): Promise<void> {
    await this.invoke("browser_sidecar_stop", { taskId: session.taskId });
  }

  async emergencyCleanup(): Promise<void> {
    await this.invoke("browser_sidecar_stop", { taskId: "*", emergency: true });
  }

  async navigate(
    session: BrowserSessionRecord,
    url: string,
    timeout?: number,
  ): Promise<BrowserOperationResult> {
    const safeUrl = assertSafeUrl(url, { allowPrivateUrls: false });
    return (await this.invoke("browser_navigate", {
      taskId: session.taskId,
      url: safeUrl,
      timeout,
    })) as BrowserOperationResult;
  }

  async snapshot(session: BrowserSessionRecord, full?: boolean): Promise<BrowserOperationResult> {
    return (await this.invoke("browser_snapshot", { taskId: session.taskId, full })) as BrowserOperationResult;
  }

  async click(session: BrowserSessionRecord, ref: string): Promise<BrowserOperationResult> {
    return (await this.invoke("browser_click", { taskId: session.taskId, ref })) as BrowserOperationResult;
  }

  async type(
    session: BrowserSessionRecord,
    ref: string,
    text: string,
    submit?: boolean,
  ): Promise<BrowserOperationResult> {
    return (await this.invoke("browser_type", {
      taskId: session.taskId,
      ref,
      text,
      submit,
    })) as BrowserOperationResult;
  }

  async scroll(
    session: BrowserSessionRecord,
    direction: string,
    amount?: number,
  ): Promise<BrowserOperationResult> {
    return (await this.invoke("browser_scroll", {
      taskId: session.taskId,
      direction,
      amount,
    })) as BrowserOperationResult;
  }

  async back(session: BrowserSessionRecord): Promise<BrowserOperationResult> {
    return (await this.invoke("browser_back", { taskId: session.taskId })) as BrowserOperationResult;
  }

  async press(session: BrowserSessionRecord, key: string): Promise<BrowserOperationResult> {
    return (await this.invoke("browser_press", { taskId: session.taskId, key })) as BrowserOperationResult;
  }

  async console(
    session: BrowserSessionRecord,
    expression?: string,
    clear?: boolean,
  ): Promise<BrowserOperationResult> {
    return (await this.invoke("browser_console", {
      taskId: session.taskId,
      expression,
      clear,
    })) as BrowserOperationResult;
  }

  private async invoke(command: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.options.invoke) {
      return { success: false, error: "No local browser sidecar invoker configured" };
    }
    return this.options.invoke(command, args);
  }
}

export { evaluateUrlSafety, assertSafeUrl, BrowserSessionRecord };
