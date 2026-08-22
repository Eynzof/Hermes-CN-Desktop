import type {
  ApprovalDecision,
  ApprovalPolicy,
  ApprovalPolicyResult,
  ApprovalRequest,
  ApprovalMode,
  DangerLevel,
} from "./types.js";

const DANGER_RANK: Record<DangerLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function dangerRank(level: DangerLevel): number {
  return DANGER_RANK[level] ?? 0;
}

/**
 * Policy driven by a static danger-level threshold.
 *
 * - Operations at or above `hardline` are blocked immediately.
 * - Operations at or above `threshold` trigger an approval request.
 * - Safer operations fall through to the next policy.
 */
export class DangerLevelPolicy implements ApprovalPolicy {
  readonly name = "danger-level";

  constructor(
    private readonly threshold: DangerLevel = "high",
    private readonly hardline: DangerLevel = "critical",
  ) {}

  evaluate(request: ApprovalRequest): ApprovalPolicyResult | undefined {
    const rank = dangerRank(request.dangerLevel);
    if (rank >= dangerRank(this.hardline)) {
      return { decision: "deny", reason: `Hardline: ${request.dangerLevel}` };
    }
    if (rank >= dangerRank(this.threshold)) {
      return { decision: "ask", reason: `Danger level ${request.dangerLevel}` };
    }
    return undefined;
  }
}

/** Match a request field against an allow/deny list. */
function matchesList(value: string | undefined, list: string[]): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return list.some((entry) => normalized === entry.toLowerCase());
}

/**
 * Policy driven by configured toolset allow/deny lists.
 *
 * Deny entries win over allow entries. Wildcards are not supported here; use
 * `GlobToolPolicy` (or a future `picomatch`-backed policy) for wildcard rules.
 */
export class ToolsetPolicy implements ApprovalPolicy {
  readonly name = "toolset";

  constructor(
    private readonly options: {
      deny?: string[];
      allow?: string[];
    } = {},
  ) {}

  evaluate(request: ApprovalRequest): ApprovalPolicyResult | undefined {
    const { deny = [], allow = [] } = this.options;
    if (request.toolset && matchesList(request.toolset, deny)) {
      return { decision: "deny", reason: `Denied toolset: ${request.toolset}` };
    }
    if (request.toolset && matchesList(request.toolset, allow)) {
      return { decision: "approve", reason: `Allowed toolset: ${request.toolset}` };
    }
    return undefined;
  }
}

/** Policy driven by configured tool name allow/deny lists. */
export class ToolNamePolicy implements ApprovalPolicy {
  readonly name = "tool";

  constructor(
    private readonly options: {
      deny?: string[];
      allow?: string[];
    } = {},
  ) {}

  evaluate(request: ApprovalRequest): ApprovalPolicyResult | undefined {
    const { deny = [], allow = [] } = this.options;
    if (matchesList(request.toolName, deny)) {
      return { decision: "deny", reason: `Denied tool: ${request.toolName}` };
    }
    if (matchesList(request.toolName, allow)) {
      return { decision: "approve", reason: `Allowed tool: ${request.toolName}` };
    }
    return undefined;
  }
}

/**
 * YOLO bypass policy.
 *
 * Approves every request unless an earlier policy already denied it. The gate
 * is expected to run user-deny and hardline policies *before* this one.
 */
export class YoloPolicy implements ApprovalPolicy {
  readonly name = "yolo";

  constructor(
    private readonly isActive: (request: ApprovalRequest) => boolean,
  ) {}

  evaluate(request: ApprovalRequest): ApprovalPolicyResult | undefined {
    if (this.isActive(request)) {
      return { decision: "approve", reason: "YOLO mode active" };
    }
    return undefined;
  }
}

/** Smart approval policy placeholder. */
export class SmartPolicy implements ApprovalPolicy {
  readonly name = "smart";

  constructor(
    private readonly isActive: (request: ApprovalRequest) => boolean,
    private readonly smartApprove: (request: ApprovalRequest) => Promise<ApprovalDecision> = () =>
      Promise.resolve("ask"),
  ) {}

  private pending = new Map<string, Promise<ApprovalPolicyResult>>();

  evaluate(request: ApprovalRequest): ApprovalPolicyResult | undefined {
    if (!this.isActive(request)) return undefined;
    // Smart approval is asynchronous; the gate handles async policies by
    // awaiting the returned promise. We memoize per request id to stay stable.
    const existing = this.pending.get(request.id);
    if (existing) {
      return undefined; // gate should await the first promise
    }
    const promise = this.smartApprove(request).then((decision) => ({
      decision,
      reason: "Smart approval",
    }));
    this.pending.set(request.id, promise);
    return undefined;
  }
}

/** Run an ordered list of policies; the first non-undefined result wins. */
export class CompositePolicy implements ApprovalPolicy {
  readonly name = "composite";

  constructor(private readonly policies: ApprovalPolicy[]) {}

  evaluate(request: ApprovalRequest): ApprovalPolicyResult | undefined {
    for (const policy of this.policies) {
      const result = policy.evaluate(request);
      if (result) return result;
    }
    return undefined;
  }
}

/** Helper to build the canonical Hermes policy ordering. */
export function buildDefaultApprovalPolicy(options: {
  mode: ApprovalMode;
  sessionYolo?: Set<string>;
  denyToolsets?: string[];
  denyTools?: string[];
  allowToolsets?: string[];
  allowTools?: string[];
  dangerThreshold?: DangerLevel;
  dangerHardline?: DangerLevel;
}): CompositePolicy {
  const isYolo = (request: ApprovalRequest) =>
    options.mode === "yolo" ||
    options.mode === "off" ||
    (!!options.sessionYolo && options.sessionYolo.has(request.sessionId));

  return new CompositePolicy([
    new ToolsetPolicy({ deny: options.denyToolsets }),
    new ToolNamePolicy({ deny: options.denyTools }),
    // Hardline blocks (e.g. rm -rf /) are evaluated before YOLO.
    new DangerLevelPolicy(options.dangerHardline ?? "critical", options.dangerHardline ?? "critical"),
    new YoloPolicy(isYolo),
    new ToolsetPolicy({ allow: options.allowToolsets }),
    new ToolNamePolicy({ allow: options.allowTools }),
    // General danger-level threshold asks for user review in non-YOLO modes.
    new DangerLevelPolicy(options.dangerThreshold ?? "high", "critical"),
  ]);
}
