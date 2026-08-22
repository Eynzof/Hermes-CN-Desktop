import type { BrowserConfig, BrowserSessionRecord } from "../schemas.js";
import { BrowserBackendKind } from "../schemas.js";
import type {
  BrowserOperationResult,
  BrowserProvider,
  CreateSessionResult,
} from "../provider.js";

function envKeyAvailable(env: Record<string, string | undefined>, key: string): boolean {
  const value = env[key];
  return Boolean(value && value.length > 0 && !value.startsWith("xoxb-"));
}

abstract class CloudBrowserProvider implements BrowserProvider {
  abstract readonly name: BrowserBackendKind;
  abstract readonly displayName: string;
  abstract readonly requiredEnvKey: string;

  constructor(protected readonly env: Record<string, string | undefined> = {}) {}

  async isAvailable(_config: BrowserConfig): Promise<boolean> {
    return envKeyAvailable(this.env, this.requiredEnvKey);
  }

  abstract createSession(taskId: string, config: BrowserConfig): Promise<CreateSessionResult>;

  async closeSession(_session: BrowserSessionRecord): Promise<void> {
    // Stub: cloud sessions are reaped server-side in this minimal cut.
  }

  async emergencyCleanup(): Promise<void> {
    // Stub.
  }

  async navigate(_session: BrowserSessionRecord, _url: string, _timeout?: number): Promise<BrowserOperationResult> {
    return { success: false, error: `${this.name} navigate not yet implemented` };
  }

  async snapshot(_session: BrowserSessionRecord, _full?: boolean): Promise<BrowserOperationResult> {
    return { success: false, error: `${this.name} snapshot not yet implemented` };
  }
}

export class BrowserbaseProvider extends CloudBrowserProvider {
  readonly name = BrowserBackendKind.Enum.browserbase;
  readonly displayName = "Browserbase";
  readonly requiredEnvKey = "BROWSERBASE_API_KEY";

  async createSession(taskId: string, _config: BrowserConfig): Promise<CreateSessionResult> {
    return {
      taskId,
      backend: this.name,
      sessionName: `bb-${taskId}`,
      bbSessionId: undefined,
      features: { proxies: false, advancedStealth: false, keepAlive: false },
    };
  }
}

export class BrowserUseCloudProvider extends CloudBrowserProvider {
  readonly name = BrowserBackendKind.Enum["browser-use"];
  readonly displayName = "Browser Use Cloud";
  readonly requiredEnvKey = "BROWSER_USE_API_KEY";

  async createSession(taskId: string, _config: BrowserConfig): Promise<CreateSessionResult> {
    return {
      taskId,
      backend: this.name,
      sessionName: `bu-${taskId}`,
      features: {},
    };
  }
}

export class FirecrawlProvider extends CloudBrowserProvider {
  readonly name = BrowserBackendKind.Enum.firecrawl;
  readonly displayName = "Firecrawl";
  readonly requiredEnvKey = "FIRECRAWL_API_KEY";

  async createSession(taskId: string, _config: BrowserConfig): Promise<CreateSessionResult> {
    return {
      taskId,
      backend: this.name,
      sessionName: `fc-${taskId}`,
      features: { ttl: 300 },
    };
  }
}

export class CamofoxProvider extends CloudBrowserProvider {
  readonly name = BrowserBackendKind.Enum.camofox;
  readonly displayName = "Camofox";
  readonly requiredEnvKey = "CAMOFOX_URL";

  async createSession(taskId: string, config: BrowserConfig): Promise<CreateSessionResult> {
    return {
      taskId,
      backend: this.name,
      sessionName: `camo-${taskId}`,
      cdpUrl: config.camofox.url,
      features: { managedPersistence: config.camofox.managedPersistence },
    };
  }
}
