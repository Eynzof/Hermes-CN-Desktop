import type { BrowserBackendKind, BrowserConfig, BrowserSessionRecord } from "./schemas.js";

export interface CreateSessionResult {
  taskId: string;
  backend: BrowserBackendKind;
  sessionName?: string;
  bbSessionId?: string;
  cdpUrl?: string;
  expiresAt?: string;
  features?: Record<string, unknown>;
  externalCallId?: string;
}

export interface BrowserOperationResult {
  success: boolean;
  error?: string;
  snapshot?: string;
  url?: string;
  title?: string;
  console?: unknown[];
  pendingDialogs?: unknown[];
  frameTree?: unknown;
  [key: string]: unknown;
}

export interface BrowserProvider {
  readonly name: BrowserBackendKind;
  readonly displayName: string;
  isAvailable(config: BrowserConfig): boolean | Promise<boolean>;
  createSession(taskId: string, config: BrowserConfig): Promise<CreateSessionResult>;
  closeSession(session: BrowserSessionRecord): Promise<void>;
  emergencyCleanup(): Promise<void>;
  navigate?(session: BrowserSessionRecord, url: string, timeout?: number): Promise<BrowserOperationResult>;
  snapshot?(session: BrowserSessionRecord, full?: boolean): Promise<BrowserOperationResult>;
  click?(session: BrowserSessionRecord, ref: string): Promise<BrowserOperationResult>;
  type?(
    session: BrowserSessionRecord,
    ref: string,
    text: string,
    submit?: boolean,
  ): Promise<BrowserOperationResult>;
  scroll?(session: BrowserSessionRecord, direction: string, amount?: number): Promise<BrowserOperationResult>;
  back?(session: BrowserSessionRecord): Promise<BrowserOperationResult>;
  press?(session: BrowserSessionRecord, key: string): Promise<BrowserOperationResult>;
  console?(session: BrowserSessionRecord, expression?: string, clear?: boolean): Promise<BrowserOperationResult>;
}
