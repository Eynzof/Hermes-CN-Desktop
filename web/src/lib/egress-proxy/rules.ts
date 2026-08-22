import { EgressProxyRuleSchema, type EgressProxyRule } from "@hermes/protocol/egress-proxy";

export function compileEgressRule(rule: unknown): EgressProxyRule {
  return EgressProxyRuleSchema.parse(rule);
}

export function evaluateEgressRules(rules: EgressProxyRule[], url: string): EgressProxyRule | null {
  for (const rule of rules) {
    const re = new RegExp(rule.pattern);
    if (re.test(url)) return rule;
  }
  return null;
}
