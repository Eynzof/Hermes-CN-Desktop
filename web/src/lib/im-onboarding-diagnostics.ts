import type {
  ImCredentialSummary,
  ImOnboardingApplyResult,
  ImPlatform,
  ImRedactedValue,
  MessagingPlatformInfo,
  MessagingPlatformTestResponse,
  StatusResponse,
} from "@hermes/protocol";

const FEISHU_RECEIVE_EVENT = "im.message.receive_v1";

type ImDiagnosticLevel = "ok" | "warn" | "error";

export interface ImDiagnosticIssue {
  level: ImDiagnosticLevel;
  title: string;
  detail: string;
  nextStep: string;
  evidence?: string | null;
}

interface ImDiagnosticConfigKey {
  key: string;
  isSet: boolean;
  redactedValue?: string | null;
  fingerprint?: string | null;
}

export interface ImDiagnosticBundle {
  kind: "hermes-im-onboarding-diagnosis";
  version: 1;
  generatedAt: string;
  platform: ImPlatform;
  platformLabel: string;
  currentProfile: string;
  hermesHome?: string | null;
  envPath?: string | null;
  gateway: {
    running?: boolean;
    state?: string | null;
    platformState?: string | null;
    platformErrorCode?: string | null;
    platformErrorMessage?: string | null;
    updatedAt?: string | null;
  };
  officialPlatform: {
    available: boolean;
    enabled?: boolean;
    configured?: boolean;
    gatewayRunning?: boolean;
    state?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    homeChannel?: string | null;
    envVars?: Array<{
      key: string;
      required?: boolean;
      isSet?: boolean;
      redactedValue?: string | null;
      advanced?: boolean;
    }>;
  };
  onboarding: {
    qrStatus?: string | null;
    qrMessage?: string | null;
    credentialReturned?: boolean;
    lastApplyOk?: boolean | null;
    restartOk?: boolean | null;
    restartMessage?: string | null;
  };
  configuration: {
    requiredKeys: ImDiagnosticConfigKey[];
    policyKeys: ImDiagnosticConfigKey[];
  };
  test: {
    ran: boolean;
    ok?: boolean | null;
    state?: string | null;
    message?: string | null;
  };
  issues: ImDiagnosticIssue[];
}

export interface BuildImDiagnosticInput {
  platform: ImPlatform;
  currentProfile?: string | null;
  hermesHome?: string | null;
  envPath?: string | null;
  configured?: Record<string, ImRedactedValue>;
  statusData?: StatusResponse;
  platformInfo?: MessagingPlatformInfo | null;
  testResult?: MessagingPlatformTestResponse | null;
  testError?: unknown;
  applyResult?: ImOnboardingApplyResult | null;
  beginError?: unknown;
  pollError?: unknown;
  applyError?: unknown;
  stateError?: unknown;
  qrStatus?: string | null;
  qrMessage?: string | null;
  credential?: ImCredentialSummary | null;
}

const DIAGNOSTIC_REQUIRED_KEYS: Record<ImPlatform, string[]> = {
  feishu: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"],
  weixin: ["WEIXIN_ACCOUNT_ID", "WEIXIN_TOKEN"],
};

const DIAGNOSTIC_POLICY_KEYS: Record<ImPlatform, string[]> = {
  feishu: ["FEISHU_DM_POLICY", "FEISHU_ALLOWED_USERS", "FEISHU_HOME_CHANNEL", "FEISHU_GROUP_POLICY"],
  weixin: ["WEIXIN_DM_POLICY", "WEIXIN_ALLOWED_USERS", "WEIXIN_HOME_CHANNEL", "WEIXIN_ALLOW_ALL_USERS"],
};

function textFromUnknownError(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

function platformStateLabel(state?: string | null): string {
  switch (state) {
    case "connected": return "已连接";
    case "disabled": return "未启用";
    case "not_configured": return "配置不完整";
    case "pending_restart": return "等待重启";
    case "gateway_stopped": return "接收服务未运行";
    case "error": return "连接错误";
    default: return state || "暂无状态";
  }
}

function safeDiagnosticValue(key: string, value?: string | null): string | null {
  if (!value) return null;
  if (!/(SECRET|TOKEN|PASSWORD|COOKIE|PRIVATE)/i.test(key)) return value;
  if (/[•*…]/.test(value) || value.length <= 8) return value;
  return "已设置（已隐藏）";
}

function configuredKey(configured: Record<string, ImRedactedValue> | undefined, key: string): ImDiagnosticConfigKey {
  const value = configured?.[key];
  return {
    key,
    isSet: Boolean(value?.isSet),
    redactedValue: safeDiagnosticValue(key, value?.redactedValue),
    fingerprint: value?.fingerprint ?? null,
  };
}

function isConfigured(configured: Record<string, ImRedactedValue> | undefined, key: string): boolean {
  return Boolean(configured?.[key]?.isSet);
}

function addIssue(issues: ImDiagnosticIssue[], issue: ImDiagnosticIssue | null | undefined) {
  if (!issue) return;
  const id = `${issue.level}:${issue.title}:${issue.nextStep}`;
  if (issues.some((item) => `${item.level}:${item.title}:${item.nextStep}` === id)) return;
  issues.push(issue);
}

export function explainMessagingFailure(platform: ImPlatform, rawMessage?: string | null): ImDiagnosticIssue | null {
  const raw = rawMessage?.trim();
  if (!raw) return null;
  const message = raw.toLowerCase();

  if (/address already in use|eaddrinuse|\bport\b|端口|占用/.test(message)) {
    return {
      level: "error",
      title: "接收服务端口被占用",
      detail: "Hermes 的接收服务没有成功启动，通常是已有网关进程占用了端口。",
      nextStep: "先关闭另一个 Hermes/Gateway，再回到本页点击保存并重启。",
      evidence: raw,
    };
  }

  if (/gateway|接收服务|not running|stopped|未运行|停止/.test(message)) {
    return {
      level: "error",
      title: "接收服务未运行",
      detail: "消息平台无法把消息交给 Hermes，当前阻断点在本机接收服务。",
      nextStep: "点击“保存并启动接收服务”，再点一次平台检测。",
      evidence: raw,
    };
  }

  if (platform === "feishu") {
    if (/permission|scope|forbidden|unauthori[sz]ed|401|403|权限|授权|scope/.test(message)) {
      return {
        level: "error",
        title: "飞书权限或版本发布未完成",
        detail: "飞书后台缺少收消息/发消息权限，或者权限加完后还没有创建版本并发布。",
        nextStep: "打开飞书开发者后台，确认机器人能力、私聊消息权限、发送消息权限都已勾选，并创建版本发布。",
        evidence: raw,
      };
    }
    if (/event|subscribe|subscription|callback|websocket|receive|事件|订阅|回调|长连接/.test(message)) {
      return {
        level: "error",
        title: "飞书消息事件没有正确订阅",
        detail: "机器人可能能发消息，但飞书没有把用户消息投递到桌面端。",
        nextStep: `在飞书后台「事件与回调」里选择长连接，并订阅 ${FEISHU_RECEIVE_EVENT} 后发布版本。`,
        evidence: raw,
      };
    }
    if (/bot|机器人|bot disabled|not enabled|未启用/.test(message)) {
      return {
        level: "error",
        title: "飞书机器人能力未启用",
        detail: "应用凭据存在，但机器人能力没有打开时，用户私聊看起来会没有响应。",
        nextStep: "在飞书开发者后台打开「机器人」能力，然后重新发布应用。",
        evidence: raw,
      };
    }
  }

  if (platform === "weixin") {
    if (/expired|expire|过期|timeout waiting qr|二维码/.test(message)) {
      return {
        level: "warn",
        title: "微信二维码已过期或未确认",
        detail: "微信扫码凭据没有在有效期内确认，桌面端拿不到账号和口令。",
        nextStep: "重新生成二维码，用微信扫码后在手机上确认，再回到桌面端保存。",
        evidence: raw,
      };
    }
    if (/aiohttp|cryptography|module|importerror|dependency|依赖|模块/.test(message)) {
      return {
        level: "error",
        title: "微信接入运行依赖缺失",
        detail: "iLink 拉消息需要的 Python 依赖没有安装完整。",
        nextStep: "按错误提示安装缺失依赖，或重新安装/更新桌面端后再检测微信连接。",
        evidence: raw,
      };
    }
    if (/token|account|unauthori[sz]ed|401|403|认证|口令|账号/.test(message)) {
      return {
        level: "error",
        title: "微信账号或口令不可用",
        detail: "当前保存的 iLink 账号、Token 可能已经失效，或者不是同一次扫码得到的组合。",
        nextStep: "重新扫码绑定微信，不要手动混用旧账号和旧 Token。",
        evidence: raw,
      };
    }
    if (/ilink|base url|network|econn|fetch|connect|连接|网络|拉取|轮询/.test(message)) {
      return {
        level: "warn",
        title: "微信 iLink 服务暂时不可达",
        detail: "桌面端已经尝试连接微信 iLink，但网络、服务地址或服务状态可能异常。",
        nextStep: "确认网络可用；如果你改过高级接口地址，先恢复默认地址后重新检测。",
        evidence: raw,
      };
    }
  }

  return {
    level: "warn",
    title: `${platform === "feishu" ? "飞书" : "微信"}检测返回异常`,
    detail: "检测接口返回了错误，但当前无法自动归类。",
    nextStep: "复制诊断包让 Hermes Agent 根据上下文继续排查。",
    evidence: raw,
  };
}

export function buildImDiagnosticBundle(input: BuildImDiagnosticInput): ImDiagnosticBundle {
  const platformLabel = input.platform === "feishu" ? "飞书" : "微信";
  const configured = input.configured ?? {};
  const statusPlatform = input.statusData?.gateway_platforms?.[input.platform];
  const testMessage = input.testResult?.message ?? textFromUnknownError(input.testError);
  const testFailureMessage = input.testResult?.ok === false
    ? input.testResult.message
    : textFromUnknownError(input.testError);
  const errorMessages = [
    textFromUnknownError(input.beginError),
    textFromUnknownError(input.pollError),
    textFromUnknownError(input.applyError),
    textFromUnknownError(input.stateError),
    input.platformInfo?.state === "connected" ? null : input.platformInfo?.error_message ?? null,
    testFailureMessage,
  ].filter(Boolean) as string[];
  const issues: ImDiagnosticIssue[] = [];

  const hasRequiredCredential = DIAGNOSTIC_REQUIRED_KEYS[input.platform].every((key) => isConfigured(configured, key));
  if (!hasRequiredCredential) {
    addIssue(issues, {
      level: "warn",
      title: `${platformLabel}凭据还没保存完整`,
      detail: input.platform === "feishu"
        ? "还没有完整的 App ID 和 App Secret，飞书无法建立长连接。"
        : "还没有完整的 iLink 账号和 Token，微信消息轮询无法启动。",
      nextStep: input.platform === "feishu" ? "先扫码绑定飞书应用，或在高级配置里恢复已有应用密钥。" : "优先重新扫码绑定微信，不建议小白手填账号和 Token。",
    });
  }

  if (input.statusData && !input.statusData.gateway_running) {
    addIssue(issues, {
      level: "error",
      title: "接收服务未运行",
      detail: "Hermes Gateway 当前没有运行，消息平台无法投递消息。",
      nextStep: "点击保存并启动接收服务；如果仍失败，再复制诊断包让 Hermes 排查端口和日志。",
      evidence: input.statusData.gateway_exit_reason ?? input.statusData.gateway_state ?? null,
    });
  }

  if (input.applyResult && !input.applyResult.restart.ok) {
    addIssue(issues, {
      level: "error",
      title: "保存后重启接收服务失败",
      detail: "配置已经写入，但新配置没有被正在运行的接收服务加载。",
      nextStep: "根据重启消息处理后再次点击保存；常见原因是端口占用或已有 Gateway 进程未退出。",
      evidence: input.applyResult.restart.message ?? null,
    });
  }

  const officialState = input.platformInfo?.state ?? statusPlatform?.state ?? null;
  if (officialState && officialState !== "connected") {
    const stateLabel = platformStateLabel(officialState);
    addIssue(issues, {
      level: officialState === "pending_restart" ? "warn" : "error",
      title: `${platformLabel}平台状态：${stateLabel}`,
      detail: officialState === "not_configured"
        ? "运行时认为这个平台的必填配置还不完整。"
        : officialState === "gateway_stopped"
          ? "运行时提示接收服务没有启动。"
          : officialState === "disabled"
            ? "运行时认为这个平台尚未启用。"
            : "运行时没有进入已连接状态。",
      nextStep: officialState === "pending_restart"
        ? "先保存并重启接收服务，再重新检测。"
        : `按照本页 ${platformLabel} 接入步骤补齐配置后重新检测。`,
      evidence: input.platformInfo?.error_message ?? statusPlatform?.error_message ?? officialState,
    });
  }

  if (input.testResult && !input.testResult.ok) {
    addIssue(issues, explainMessagingFailure(input.platform, input.testResult.message));
  }
  for (const message of errorMessages) {
    addIssue(issues, explainMessagingFailure(input.platform, message));
  }

  if (input.platform === "feishu") {
    if (hasRequiredCredential && !isConfigured(configured, "FEISHU_ALLOWED_USERS") && configured.FEISHU_DM_POLICY?.redactedValue !== "open") {
      addIssue(issues, {
        level: "warn",
        title: "飞书允许用户列表为空",
        detail: "如果私聊策略不是开放模式，允许用户为空会导致用户发消息后无法使用。",
        nextStep: "推荐使用扫码用户作为默认允许用户，或手动补充 open_id 后保存。",
      });
    }
    if (input.applyResult?.restart.ok && !input.testResult?.ok) {
      addIssue(issues, {
        level: "warn",
        title: "还需要确认飞书后台发布",
        detail: "桌面端保存成功只代表本机配置完成，飞书后台权限和事件订阅仍需要发布后才生效。",
        nextStep: `确认已订阅 ${FEISHU_RECEIVE_EVENT}，并在飞书开发者后台创建版本发布。`,
      });
    }
  } else {
    if (input.qrStatus === "expired" || input.qrStatus === "denied") {
      addIssue(issues, explainMessagingFailure("weixin", input.qrStatus === "expired" ? "二维码已过期" : "二维码已拒绝"));
    }
    if (hasRequiredCredential && configured.WEIXIN_DM_POLICY?.redactedValue === "allowlist" && !isConfigured(configured, "WEIXIN_ALLOWED_USERS")) {
      addIssue(issues, {
        level: "warn",
        title: "微信允许用户列表为空",
        detail: "白名单模式下如果没有写入扫码用户，私聊消息会被过滤。",
        nextStep: "重新扫码后保存，或在额外允许用户里补充微信 user_id。",
      });
    }
  }

  if (issues.length === 0) {
    addIssue(issues, {
      level: "ok",
      title: "暂未发现明显阻断点",
      detail: "本页可见状态没有显示配置缺失或运行错误。",
      nextStep: `点击“检测${platformLabel}连接”，再去${platformLabel}私聊机器人发送 hi 验证。`,
    });
  }

  return {
    kind: "hermes-im-onboarding-diagnosis",
    version: 1,
    generatedAt: new Date().toISOString(),
    platform: input.platform,
    platformLabel,
    currentProfile: input.currentProfile || "default",
    hermesHome: input.hermesHome ?? input.statusData?.hermes_home ?? null,
    envPath: input.envPath ?? input.statusData?.env_path ?? null,
    gateway: {
      running: input.statusData?.gateway_running,
      state: input.statusData?.gateway_state ?? null,
      platformState: statusPlatform?.state ?? null,
      platformErrorCode: statusPlatform?.error_code ?? null,
      platformErrorMessage: statusPlatform?.error_message ?? null,
      updatedAt: statusPlatform?.updated_at ?? null,
    },
    officialPlatform: {
      available: input.platformInfo !== undefined && input.platformInfo !== null,
      enabled: input.platformInfo?.enabled,
      configured: input.platformInfo?.configured,
      gatewayRunning: input.platformInfo?.gateway_running,
      state: input.platformInfo?.state ?? null,
      errorCode: input.platformInfo?.error_code ?? null,
      errorMessage: input.platformInfo?.error_message ?? null,
      homeChannel: input.platformInfo?.home_channel?.chat_id ? "已设置" : null,
      envVars: input.platformInfo?.env_vars?.map((item) => ({
        key: item.key,
        required: item.required,
        isSet: item.is_set,
        redactedValue: safeDiagnosticValue(item.key, item.redacted_value),
        advanced: item.advanced,
      })),
    },
    onboarding: {
      qrStatus: input.qrStatus ?? null,
      qrMessage: input.qrMessage ?? null,
      credentialReturned: Boolean(input.credential),
      lastApplyOk: input.applyResult?.ok ?? null,
      restartOk: input.applyResult?.restart.ok ?? null,
      restartMessage: input.applyResult?.restart.message ?? null,
    },
    configuration: {
      requiredKeys: DIAGNOSTIC_REQUIRED_KEYS[input.platform].map((key) => configuredKey(configured, key)),
      policyKeys: DIAGNOSTIC_POLICY_KEYS[input.platform].map((key) => configuredKey(configured, key)),
    },
    test: {
      ran: Boolean(input.testResult || input.testError),
      ok: input.testResult?.ok ?? null,
      state: input.testResult?.state ?? null,
      message: testMessage ?? null,
    },
    issues,
  };
}

export function buildImDiagnosticPrompt(bundle: ImDiagnosticBundle): string {
  return `你是 Hermes Agent 的消息平台接入排障助手。请根据下面的诊断包，帮助小白用户排查 ${bundle.platformLabel} 接入失败问题。

要求：
1. 不要展示、索要或还原 token、secret、cookie、完整 user_id/open_id 等敏感信息。
2. 先判断最可能的阻断点，再给出最多 3 个下一步操作，每一步都要能在桌面端或平台后台完成。
3. 如果是飞书，优先检查应用发布、机器人能力、消息事件订阅、收发消息权限和允许用户列表。
4. 如果是微信，优先检查二维码是否过期、扫码是否确认、iLink 服务是否可用、扫码用户是否写入允许列表、接收服务是否已重启。
5. 如果证据不足，请让用户回到接入页点击“检测连接”或“重新扫码”，不要让小白执行复杂命令。

诊断包 JSON：
\`\`\`json
${JSON.stringify(bundle, null, 2)}
\`\`\``;
}
