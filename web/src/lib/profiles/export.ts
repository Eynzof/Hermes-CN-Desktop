export interface ExportOptions {
  extraFiles?: Record<string, string>;
}

export async function exportProfile(
  _hermesHome: string,
  _name: string,
  _dest: string,
  _opts?: ExportOptions,
): Promise<string> {
  // Stub: actual archive creation delegated to Rust `export_profile` command.
  return `${_dest}\\${_name}.tar.gz`;
}

export function scrubSecret(text: string): string {
  // Naive redaction stub for parity.
  return text.replace(/(?:api[_-]?key|token|secret)\s*[:=]\s*[^\s]+/gi, (m) => `${m.split(/[:=]/)[0]}: ***`);
}
