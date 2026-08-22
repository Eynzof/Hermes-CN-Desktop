export type ModelSwitchScope = "per-session" | "global" | "once";

export interface ParsedModelFlags {
  target: string;
  provider?: string;
  scope: ModelSwitchScope;
  forceRefresh: boolean;
  errors: string[];
}

const SCOPE_FLAGS: Record<string, ModelSwitchScope> = {
  "--global": "global",
  "--session": "per-session",
  "--once": "once",
  "-g": "global",
  "-s": "per-session",
  "-o": "once",
};

const UNICODE_DASHES = /[\u2013\u2014]/g;

function normalizeFlagToken(token: string): string {
  // Telegram/iOS auto-convert turns "--" into an en/em dash. Normalize any
  // leading run of ASCII/Unicode dashes to a canonical double dash.
  return token.replace(/^[-\u2013\u2014]+/, "--");
}

/**
 * Parse the `/model` slash command arguments.
 *
 * Supported flags:
 *   --global / -g        persist as the global default model
 *   --session / -s       switch for the current session only (default)
 *   --once / -o          switch for a single turn only
 *   --provider <name>    explicit provider slug
 *   --refresh            hint to refresh the provider model list (no-op in scaffold)
 *
 * Conflicts are reported as errors without mutating state.
 */
export function parseModelSwitchArgs(raw: string): ParsedModelFlags {
  const normalized = raw.replace(UNICODE_DASHES, "-").trim();
  const tokens = normalized.split(/\s+/).filter(Boolean);

  let target = "";
  let provider: string | undefined;
  let scope: ModelSwitchScope = "per-session";
  let forceRefresh = false;
  const errors: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = normalizeFlagToken(tokens[i]);
    const lower = token.toLowerCase();

    if (lower === "--provider") {
      const next = tokens[++i];
      if (!next) {
        errors.push("--provider requires a value");
      } else {
        provider = next;
      }
      continue;
    }

    if (lower === "--refresh") {
      forceRefresh = true;
      continue;
    }

    if (lower in SCOPE_FLAGS) {
      const nextScope = SCOPE_FLAGS[lower];
      if (scope !== "per-session" && scope !== nextScope) {
        errors.push(`Cannot combine ${token} with other scope flags`);
      }
      scope = nextScope;
      continue;
    }

    if (!target) {
      target = token;
    } else {
      target += ` ${token}`;
    }
  }

  if (!target && scope === "once") {
    errors.push("--once requires a target model");
  }

  return { target, provider, scope, forceRefresh, errors };
}

/**
 * Build the display string for a `/model` slash command.
 */
export function formatModelSwitchCommand(args: {
  target?: string;
  provider?: string;
  scope?: ModelSwitchScope;
}): string {
  const parts = ["/model"];
  if (args.scope === "global") parts.push("--global");
  if (args.scope === "once") parts.push("--once");
  if (args.provider) parts.push(`--provider ${args.provider}`);
  if (args.target) parts.push(args.target);
  return parts.join(" ");
}
