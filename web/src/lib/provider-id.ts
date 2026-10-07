export function normalizeProviderIdForGateway(provider?: string): string | undefined {
  if (provider == null) return undefined;
  const value = provider.trim();
  if (!value) throw new Error("模型服务商标识不能为空。");
  // model.options returns the provider slug that Core can resolve. It is
  // already canonical; changing custom ids (especially ids containing '.')
  // makes the round-trip miss the exact config key and silently reroute.
  if (/[\r\n]/.test(value)) throw new Error("模型服务商标识包含非法字符。");
  return value;
}

export function buildGatewayModelConfigValue(model: string, provider?: string): string {
  const modelId = model.trim();
  if (!modelId) throw new Error("模型标识不能为空。");
  const normalizedProvider = normalizeProviderIdForGateway(provider);
  if (!normalizedProvider) throw new Error("模型必须明确指定服务商。");
  return `${modelId} --provider ${normalizedProvider}`;
}

type GatewayModelConfigValue = {
  model: string;
  provider?: string;
};

function parseGatewayModelConfigValue(value: string): GatewayModelConfigValue {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const providerIndexes = parts
    .map((part, index) => part === "--provider" ? index : -1)
    .filter((index) => index >= 0);

  if (providerIndexes.length > 1) {
    throw new Error(`模型配置包含重复的 --provider：${value}`);
  }

  const providerIndex = providerIndexes[0];
  if (providerIndex == null) {
    return { model: parts.join(" ") };
  }

  const provider = parts[providerIndex + 1];
  if (!provider || providerIndex + 2 !== parts.length) {
    throw new Error(`模型配置中的 --provider 格式无效：${value}`);
  }

  return {
    model: parts.slice(0, providerIndex).join(" "),
    provider,
  };
}

export function assertGatewayModelConfigResult(requested: string, returned?: string): void {
  if (returned == null) return;

  const request = parseGatewayModelConfigValue(requested);
  const result = parseGatewayModelConfigValue(returned);

  // Core's config.set response intentionally returns result.new_model only;
  // the explicit provider is resolved and applied internally but is not
  // repeated in result.value. Always verify the returned model. If a newer
  // Core also echoes --provider, verify that identity as well.
  const modelDiffers = result.model !== request.model;
  const echoedProviderDiffers = result.provider != null && result.provider !== request.provider;
  if (modelDiffers || echoedProviderDiffers) {
    throw new Error(`模型切换结果与请求不一致：请求 ${requested}，后端返回 ${returned}`);
  }
}
