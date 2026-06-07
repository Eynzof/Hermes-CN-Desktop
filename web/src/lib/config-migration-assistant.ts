import type { RuntimeInfo } from "@hermes/protocol";

export interface ConfigMigrationRuntimeConfig {
  platform?: string;
  apiBaseUrl?: string;
  dashboardApiBaseUrl?: string;
  gatewayUrl?: string;
  currentProfile?: string;
  transport?: string;
}

export interface ConfigMigrationAssistantContext {
  runtimeConfig?: ConfigMigrationRuntimeConfig | null;
  runtimeInfo?: RuntimeInfo | null;
  collectedAt?: string;
}

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function display(value: unknown, fallback = "未知，需要在会话中探测"): string {
  return clean(value) ?? fallback;
}

function runtimeProcess(context: ConfigMigrationAssistantContext) {
  return context.runtimeInfo?.process;
}

export function summarizeConfigMigrationRuntimeContext(
  context: ConfigMigrationAssistantContext = {},
): string {
  const process = runtimeProcess(context);
  const runtimeConfig = context.runtimeConfig;
  const currentProfile =
    clean(process?.currentProfile) ??
    clean(runtimeConfig?.currentProfile) ??
    "未知，需要在会话中探测";
  const dashboardUrl =
    clean(runtimeConfig?.dashboardApiBaseUrl) ??
    clean(runtimeConfig?.apiBaseUrl) ??
    clean(process?.apiBaseUrl) ??
    "未知，需要在会话中探测";

  return [
    `- 当前桌面端 profile：${currentProfile}`,
    `- 当前配置目录：${display(process?.hermesHome)}`,
    `- 桌面端配置根目录：${display(process?.hermesHomeBase)}`,
    `- Dashboard API：${dashboardUrl}`,
    `- Gateway URL：${display(runtimeConfig?.gatewayUrl ?? process?.gatewayUrl)}`,
    `- 运行模式：${display(context.runtimeInfo?.mode)}`,
    `- Hermes 程序路径：${display(context.runtimeInfo?.current?.executablePath)}`,
    `- 采集时间：${display(context.collectedAt, "未记录")}`,
  ].join("\n");
}

export function buildConfigMigrationAssistantPrompt(
  context: ConfigMigrationAssistantContext = {},
): string {
  const contextSummary = summarizeConfigMigrationRuntimeContext(context);

  return `你是 Hermes Agent 的配置迁移助手。请帮我把已有 Hermes / hermes-agent 配置迁移到当前桌面端环境，但必须先诊断、再给计划、等我明确确认后才能做任何写入或覆盖性操作。

当前桌面端运行信息如下：
${contextSummary}

迁移目标：
1. 找到我机器上可能存在的旧 Hermes 配置来源，例如 HERMES_HOME、~/.hermes、桌面端其它 profile、旧 hermes-agent 安装目录、WSL 内的 Hermes home，或者我在后续消息里提供的目录。
2. 判断哪些内容适合迁移到当前桌面端 profile，至少覆盖 config.yaml、.env、auth/OAuth 文件、skills、plugins、memories、SOUL.md、MCP server 配置、脚本和本地路径依赖。
3. 识别不能直接迁移或需要改写的内容，例如 WSL/Linux 路径、绝对路径、shell 命令、MCP command、Python/Node 解释器路径、浏览器工具路径、OAuth token 可用性和 provider/model 字段差异。
4. 在我确认后，优先以可回滚方式迁移：先备份目标 profile，再复制或合并配置，避免覆盖已有有效配置；如果需要新建 profile，请说明 profile 名和原因。
5. 迁移后验证基础可用性：模型 provider/API Key 状态、当前模型、MCP 列表、skills、memory、gateway/dashboard 状态，并给出失败项的修复建议。

安全和行为约束：
- 第一轮请只做诊断和提问，不要写文件、不要删除文件、不要重启服务，除非我明确确认迁移计划。
- 不要在回复中打印原始 API Key、OAuth token、cookie、auth.json 内容或其它密钥；如果需要展示，只能展示脱敏摘要。
- 任何写入前都要说明来源路径、目标路径、会改哪些文件、备份放在哪里，以及如何回滚。
- 不要假设旧配置目录就是正确来源；如果发现多个候选，请按可信度排序并解释证据。
- 如果你需要执行命令，请先说明命令目的；对可能修改文件或重启进程的命令，必须等我确认。

请先从“迁移前诊断”开始：列出你准备检查的来源、需要我补充的信息，以及第一批只读检查命令。`;
}
