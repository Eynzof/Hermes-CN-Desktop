/**
 * ByteRover external memory provider stub.
 *
 * ByteRover is backed by the `brv` CLI rather than HTTP.  The adapter spawns
 * `brv query|curate` and parses JSON output.  A `runCommand` seam makes the
 * process dependency testable in unit tests.
 */

import type {
  ExternalMemoryMutationResult,
  ExternalMemoryProvider,
  ExternalMemorySearchResult,
  ExternalProviderConfigSchema,
} from "./types.js";

export interface ByteRoverProviderConfig {
  /** Working directory for the brv context tree. */
  workingDir?: string;
  /** Optional API key. */
  apiKey?: string;
  /** Command runner seam for tests. */
  runCommand?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

async function defaultRunCommand(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // In a real Tauri build this would invoke a Rust child-process command.
  // The stub returns a non-zero exit code so that unconfigured usage fails
  // gracefully; tests override the seam.
  return { stdout: "", stderr: "brv is not installed or runCommand is not injected", exitCode: 127 };
}

export class ByteRoverProvider implements ExternalMemoryProvider {
  readonly name = "byterover";
  readonly displayName = "ByteRover";
  readonly description = "Local context tree via the brv CLI.";
  private readonly workingDir?: string;
  private readonly apiKey?: string;
  private readonly runCommand: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

  constructor(config: ByteRoverProviderConfig = {}) {
    this.workingDir = config.workingDir;
    this.apiKey = config.apiKey;
    this.runCommand = config.runCommand ?? defaultRunCommand;
  }

  getConfigSchema(): ExternalProviderConfigSchema {
    return {
      fields: [
        {
          name: "workingDir",
          kind: "text",
          label: "Working Directory",
          required: true,
          description: "Path to the brv context tree.",
        },
        {
          name: "apiKey",
          kind: "secret",
          label: "API Key",
          description: "Optional ByteRover API key.",
        },
      ],
    };
  }

  validateConfig(config: unknown): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const candidate = (config ?? {}) as Record<string, unknown>;
    if (!candidate.workingDir || typeof candidate.workingDir !== "string") {
      errors.push("workingDir is required");
    }
    return { valid: errors.length === 0, errors };
  }

  private async brv(args: string[]): Promise<unknown> {
    const commandArgs = this.workingDir ? ["-C", this.workingDir, ...args] : args;
    const result = await this.runCommand(commandArgs);
    if (result.exitCode !== 0) {
      throw new Error(`brv failed (${result.exitCode}): ${result.stderr || result.stdout}`);
    }
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      return { status: "ok", stdout: result.stdout };
    }
  }

  async search(
    query: string,
    options: Record<string, unknown> = {},
  ): Promise<ExternalMemorySearchResult> {
    const data = (await this.brv([
      "query",
      query,
      "--top-k",
      String(options.top_k ?? 5),
    ])) as { results?: Array<{ id: string; content: string; score?: number }> };
    return {
      entries: (data.results ?? []).map((r) => ({ id: r.id, content: r.content, score: r.score })),
    };
  }

  async add(
    content: string,
    options: Record<string, unknown> = {},
  ): Promise<ExternalMemoryMutationResult> {
    const data = (await this.brv([
      "curate",
      "--add",
      content,
      ...(options.tags ? ["--tags", String(options.tags)] : []),
    ])) as { id?: string; status?: string };
    return {
      success: true,
      message: data.status ?? "ByteRover memory curated.",
      id: data.id,
    };
  }

  async delete(
    id: string,
    _options: Record<string, unknown> = {},
  ): Promise<ExternalMemoryMutationResult> {
    const data = (await this.brv(["curate", "--remove", id])) as { status?: string };
    return {
      success: true,
      message: data.status ?? "ByteRover memory removed.",
      id,
    };
  }
}

export function createByteRoverProvider(config: Record<string, unknown> = {}): ByteRoverProvider {
  const runCommand =
    typeof config.runCommand === "function"
      ? (config.runCommand as (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>)
      : undefined;
  return new ByteRoverProvider({
    workingDir: typeof config.workingDir === "string" ? config.workingDir : undefined,
    apiKey: typeof config.apiKey === "string" ? config.apiKey : undefined,
    runCommand,
  });
}
