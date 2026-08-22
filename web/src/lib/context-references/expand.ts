// Expander for `@` context references.
// Replaces `@file`, `@folder`, `@diff`, `@staged`, `@git:N`, and `@url` tokens
// with attached context blocks, respecting a soft/hard token budget.

import { parseMentions } from "./parse";
import { makeDefaultHooks, resolveMention, type ResolverHooks } from "./resolve";
import type { ExpandOptions, ExpandResult } from "./types";

const SOFT_LIMIT_RATIO = 0.25;
const HARD_LIMIT_RATIO = 0.5;

export async function expandContextReferences(
  message: string,
  options: ExpandOptions,
): Promise<ExpandResult> {
  const mentions = parseMentions(message);
  if (mentions.length === 0) {
    return {
      message,
      originalMessage: message,
      mentions: [],
      warnings: [],
      injectedTokens: 0,
      expanded: false,
      blocked: false,
    };
  }

  const allowedRoot = options.allowedRoot || options.cwd;
  const hooks = makeEffectiveHooks(options);
  const ctx = { cwd: options.cwd, allowedRoot, hooks };

  const results = await Promise.all(mentions.map((m) => resolveMention(m, ctx)));

  const warnings: string[] = [];
  const blocks: string[] = [];
  let injectedTokens = 0;

  for (const res of results) {
    warnings.push(...res.warnings);
    if (res.text) {
      blocks.push(res.text);
      injectedTokens += res.tokens;
    }
  }

  const contextLength = Math.max(1, options.contextLength || 8192);
  const softLimit = Math.floor(contextLength * SOFT_LIMIT_RATIO);
  const hardLimit = Math.floor(contextLength * HARD_LIMIT_RATIO);

  const budgetWarnings: string[] = [];
  if (injectedTokens > hardLimit) {
    return {
      message,
      originalMessage: message,
      mentions,
      warnings: [
        ...warnings,
        `注入上下文约 ${injectedTokens} tokens，超出硬上限 ${hardLimit} tokens（模型上下文 ${contextLength}）。消息未发送。`,
      ],
      injectedTokens,
      expanded: false,
      blocked: true,
    };
  }
  if (injectedTokens > softLimit) {
    budgetWarnings.push(
      `注入上下文约 ${injectedTokens} tokens，已超过软上限 ${softLimit} tokens（模型上下文 ${contextLength}）。`,
    );
  }

  let expandedMessage = message;
  if (blocks.length) {
    expandedMessage = `${message}\n\n--- Context Warnings ---\n${[...warnings, ...budgetWarnings].join("\n")}\n\n--- Attached Context ---\n\n${blocks.join("\n\n")}`;
  } else if (warnings.length || budgetWarnings.length) {
    expandedMessage = `${message}\n\n--- Context Warnings ---\n${[...warnings, ...budgetWarnings].join("\n")}`;
  }

  return {
    message: expandedMessage,
    originalMessage: message,
    mentions,
    warnings: [...warnings, ...budgetWarnings],
    injectedTokens,
    expanded: blocks.length > 0,
    blocked: false,
  };
}

function makeEffectiveHooks(options: ExpandOptions): ResolverHooks {
  const defaults = makeDefaultHooks();
  return {
    readFile: options.readFile ?? defaults.readFile,
    listFolder: options.listFolder ?? defaults.listFolder,
    gitCapture: options.gitCapture ?? defaults.gitCapture,
    fetchUrl: options.fetchUrl ?? defaults.fetchUrl,
  };
}

/** Re-export types and helpers used by callers/tests. */
export { parseMentions };
