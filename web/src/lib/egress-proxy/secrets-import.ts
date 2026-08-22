import type { SecretBundle, SecretImport } from "./types.js";

export function collectSecrets(inputs: SecretImport[]): SecretBundle {
  const secrets: Record<string, string> = {};
  for (const input of inputs) {
    secrets[input.key] = input.value;
  }
  return {
    secrets,
    importedAt: new Date().toISOString(),
  };
}

export function maskSecrets(text: string, secrets: Record<string, string>): string {
  let out = text;
  for (const [k, v] of Object.entries(secrets)) {
    if (v.length > 0) {
      out = out.split(v).join(`[MASKED:${k}]`);
    }
  }
  return out;
}
