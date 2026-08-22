export interface ImportResult {
  name: string;
  root: string;
}

export async function importProfile(_archivePath: string, _name: string): Promise<ImportResult> {
  // Stub: actual extraction delegated to Rust `import_profile` command.
  return { name: _name, root: `~/.hermes/profiles/${_name}` };
}
