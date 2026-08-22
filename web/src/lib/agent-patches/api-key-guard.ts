/**
 * Python `_api_key_required` parity layer.
 *
 * Returns `true` when the chosen provider genuinely needs a non-empty API key
 * and the supplied key is empty or missing. Exempts Azure Entra callable
 * tokens, literal "aws-sdk"/"no-key-required" strings, and the Bedrock provider.
 */

export const EXEMPT_LITERAL_KEYS = new Set(["aws-sdk", "no-key-required"]);

export function apiKeyRequired(
  provider: string,
  apiKey: unknown,
  _baseUrl?: string,
): boolean {
  // Non-empty string key => guard not needed.
  if (typeof apiKey === "string" && apiKey.trim().length > 0) {
    return false;
  }

  // Azure Foundry Entra ID / callable bearer token.
  if (typeof apiKey === "function") {
    return false;
  }

  // Literal exempt tokens.
  if (
    typeof apiKey === "string" &&
    EXEMPT_LITERAL_KEYS.has(apiKey.trim())
  ) {
    return false;
  }

  // Bedrock uses boto3 credential chain, not a literal API key.
  if (provider === "bedrock") {
    return false;
  }

  return true;
}

export function assertApiKey(
  provider: string,
  apiKey: unknown,
  baseUrl?: string,
): void {
  if (apiKeyRequired(provider, apiKey, baseUrl)) {
    throw new Error("no API key (param empty, env vars unset)");
  }
}
