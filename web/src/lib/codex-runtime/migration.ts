export interface MigrationReport {
  mcpServers: number;
  plugins: number;
  errors: string[];
}

export function migrateCodexConfig(mcpServers: unknown[], plugins: unknown[]): MigrationReport {
  return {
    mcpServers: Array.isArray(mcpServers) ? mcpServers.length : 0,
    plugins: Array.isArray(plugins) ? plugins.length : 0,
    errors: [],
  };
}

export function renderManagedConfigToml(mcpServers: unknown[], plugins: unknown[]): string {
  return `# managed by hermes-agent
# MCP servers: ${JSON.stringify(mcpServers)}
# Plugins: ${JSON.stringify(plugins)}
default_permissions = ":workspace"
# end hermes-agent managed section
`;
}
