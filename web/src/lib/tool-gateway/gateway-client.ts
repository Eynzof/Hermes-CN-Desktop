import { isManagedNousGatewayUrl } from "./origins.js";
import type { ToolGatewayVendor, NousToken } from "./types.js";

export interface GatewayClientDeps {
  fetch: typeof fetch;
  getToken(): Promise<string | null>;
}

export class GatewayClient {
  constructor(private deps: GatewayClientDeps) {}

  async call(vendor: ToolGatewayVendor, path: string, init: RequestInit): Promise<Response> {
    const url = `${this.buildBaseUrl(vendor)}${path}`;
    const headers = new Headers(init.headers);
    if (isManagedNousGatewayUrl(url)) {
      const token = await this.deps.getToken();
      if (token) headers.set("Authorization", `Bearer ${token}`);
    }
    return this.deps.fetch(url, { ...init, headers });
  }

  async upload(vendor: ToolGatewayVendor, data: Blob, mime: string): Promise<string> {
    // v1 stub: real implementation presigns then PUTs to the presigned URL.
    return `nous-upload:${vendor}:${mime}:${data.size}`;
  }

  private buildBaseUrl(vendor: ToolGatewayVendor): string {
    return `https://${vendor}-gateway.nousresearch.com/api/${vendor}`;
  }
}
