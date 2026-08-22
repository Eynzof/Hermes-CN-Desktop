/**
 * Home Assistant REST client.
 *
 * Thin wrapper around HA's REST API. By default uses native `fetch`; in the
 * Tauri desktop shell it routes through the origin-locked `ha_request` Rust
 * command so LAN/private origins like `http://homeassistant.local:8123` are
 * reachable without opening `external_request` SSRF policy.
 */

import type { HaRequestFn, HaRequestInput, HaRequestResult } from "@hermes/protocol";
import type { ToolContext } from "../types.js";
import { isBlockedDomain, isValidEntityId, isValidServiceName } from "./security.js";
import {
  filterAndSummarize,
  parseServiceResponse,
  summarizeServices,
  type HassAffectedEntity,
  type HassEntitiesSummary,
  type HassServiceDescription,
  type HassServiceResult,
  type HassServicesSummary,
  type HassState,
} from "./format.js";

const DEFAULT_TIMEOUT_MS = 15_000;

export type HaInvoker = (command: string, args: Record<string, unknown>) => Promise<unknown>;

export interface HassClientOptions {
  /** HASS_URL, trailing slash stripped. */
  url: string;
  /** HASS_TOKEN or HOME_ASSISTANT_TOKEN. */
  token: string;
  /**
   * Optional origin-locked HA transport. Preferred over `invoke` when both are
   * provided. When neither is set, native `fetch` is used.
   */
  haRequest?: HaRequestFn;
  /**
   * Optional generic Rust IPC invoker. Used as a fallback to call the
   * `ha_request` command when `haRequest` is not supplied.
   */
  invoke?: HaInvoker;
  timeoutMs?: number;
}

export class HassClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly haRequest?: HaRequestFn;
  private readonly invoke?: HaInvoker;
  private readonly timeoutMs: number;

  constructor(opts: HassClientOptions) {
    this.baseUrl = opts.url.trim().replace(/\/$/, "");
    this.token = opts.token;
    this.haRequest = opts.haRequest;
    this.invoke = opts.invoke;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  static fromContext(ctx: ToolContext): HassClient | undefined {
    const env = ctx.env ?? {};
    const url = env.HASS_URL ?? env.HOME_ASSISTANT_URL ?? "http://homeassistant.local:8123";
    const token = env.HASS_TOKEN ?? env.HOME_ASSISTANT_TOKEN;
    if (!token) return undefined;
    return new HassClient({ url, token, haRequest: ctx.haRequest, invoke: ctx.invoke, timeoutMs: DEFAULT_TIMEOUT_MS });
  }

  private buildInput(input: HaRequestInput): HaRequestInput {
    return {
      ...input,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...(input.headers ?? {}),
      },
    };
  }

  private async request(input: HaRequestInput): Promise<HaRequestResult> {
    const authed = this.buildInput(input);
    if (this.haRequest) {
      return this.haRequest(authed);
    }
    if (this.invoke) {
      return (await this.invoke("ha_request", { input: authed })) as HaRequestResult;
    }

    const url = new URL(authed.path, this.baseUrl);
    const init: RequestInit = {
      method: authed.method ?? "GET",
      headers: authed.headers ?? {},
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (input.body !== undefined && input.body !== null && input.method && input.method.toUpperCase() !== "GET") {
      init.body = input.body;
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), init);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: 0,
        statusText: "Network Error",
        headers: {},
        body: `Home Assistant request failed: ${message}`,
      };
    }

    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    };
  }

  private parseBody<T>(result: HaRequestResult): T {
    if (!result.ok) {
      let message: string;
      try {
        const parsed = JSON.parse(result.body);
        message =
          typeof parsed?.message === "string"
            ? parsed.message
            : typeof parsed?.error === "string"
              ? parsed.error
              : result.body;
      } catch {
        message = result.body || `${result.status} ${result.statusText}`;
      }
      throw new Error(`Home Assistant returned HTTP ${result.status}: ${message}`);
    }
    if (result.body === "") return undefined as T;
    try {
      return JSON.parse(result.body) as T;
    } catch {
      throw new Error(`Home Assistant returned invalid JSON: ${result.body.slice(0, 200)}`);
    }
  }

  async listStates(filter?: { domain?: string; area?: string }): Promise<HassEntitiesSummary> {
    const result = await this.request({ url: this.baseUrl, path: "/api/states" });
    const states = this.parseBody<HassState[]>(result);
    return filterAndSummarize(states, filter);
  }

  async getState(entityId: string): Promise<HassState> {
    if (!isValidEntityId(entityId)) {
      throw new Error(`Invalid entity_id: ${entityId}`);
    }
    const result = await this.request({ url: this.baseUrl, path: `/api/states/${entityId}` });
    return this.parseBody<HassState>(result);
  }

  async listServices(domain?: string): Promise<HassServicesSummary> {
    const result = await this.request({ url: this.baseUrl, path: "/api/services" });
    const services = this.parseBody<Record<string, Record<string, HassServiceDescription>>>(result);
    return summarizeServices(services, domain);
  }

  async callService(
    domain: string,
    service: string,
    entityId?: string,
    data?: Record<string, unknown>,
  ): Promise<HassServiceResult> {
    if (!isValidServiceName(service)) {
      throw new Error(`Invalid service name: ${service}`);
    }
    if (!isValidServiceName(domain)) {
      throw new Error(`Invalid domain name: ${domain}`);
    }
    if (isBlockedDomain(domain)) {
      throw new Error(`Domain '${domain}' is blocked for security reasons`);
    }
    if (entityId !== undefined && !isValidEntityId(entityId)) {
      throw new Error(`Invalid entity_id: ${entityId}`);
    }

    const payload: Record<string, unknown> = { ...(data ?? {}) };
    if (entityId) {
      payload.entity_id = entityId;
    }

    const result = await this.request({
      url: this.baseUrl,
      method: "POST",
      path: `/api/services/${domain}/${service}`,
      body: JSON.stringify(payload),
    });
    const responseBody = this.parseBody<unknown>(result);
    return parseServiceResponse(domain, service, responseBody);
  }
}

export type { HassAffectedEntity, HassEntitiesSummary, HassServiceResult, HassServicesSummary, HassState };
