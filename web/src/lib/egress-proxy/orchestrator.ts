import type { EgressProxyClient } from "./client.js";
import type { EgressProxyRule } from "./types.js";

export class EgressOrchestrator {
  constructor(private client: EgressProxyClient) {}

  async deployRulePack(pack: EgressProxyRule[]): Promise<{ applied: number; errors: string[] }> {
    const errors: string[] = [];
    const valid: EgressProxyRule[] = [];
    for (const r of pack) {
      try {
        if (r.pattern && r.action) valid.push(r);
      } catch (e) {
        errors.push(String(e));
      }
    }
    await this.client.setRules(valid);
    return { applied: valid.length, errors };
  }

  async provisionFromUrl(url: string): Promise<{ pack: string; rules: number }> {
    const pack = await this.client.downloadRulePack(url);
    const parsed = JSON.parse(pack);
    const rules = Array.isArray(parsed) ? parsed : parsed.rules ?? [];
    const res = await this.deployRulePack(rules);
    return { pack, rules: res.applied };
  }
}
