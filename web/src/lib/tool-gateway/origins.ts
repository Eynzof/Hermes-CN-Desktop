import type { ToolGatewayVendor } from "./types.js";

export const DEFAULT_GATEWAY_DOMAIN = "nousresearch.com";

export function buildVendorGatewayUrl(vendor: ToolGatewayVendor, domain = DEFAULT_GATEWAY_DOMAIN): string {
  return `https://${vendor}-gateway.${domain}`;
}

export function managedVendorEndpoints(vendor: ToolGatewayVendor, domain = DEFAULT_GATEWAY_DOMAIN) {
  const origin = buildVendorGatewayUrl(vendor, domain);
  return {
    origin,
    baseUrl: `/api/${vendor}`,
    uploadPath: `/api/uploads/${vendor}`,
  };
}

export function isManagedNousGatewayUrl(url: string, domain = DEFAULT_GATEWAY_DOMAIN): boolean {
  try {
    const u = new URL(url);
    return u.hostname.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}
