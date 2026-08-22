export interface EnvVarMeta {
  key: string;
  description: string;
  prompt: string;
  url: string | null;
  password: boolean;
  category: "provider" | "tool" | "messaging" | "setting" | "service";
  advanced: boolean;
  tools: string[];
}

export const CN_ENV_VAR_METADATA: Record<string, EnvVarMeta> = {
  ARK_API_KEY: {
    key: "ARK_API_KEY",
    description: "火山方舟（豆包系列）API key",
    prompt: "火山方舟 API key",
    url: "https://www.volcengine.com/docs/82379",
    password: true,
    category: "provider",
    advanced: true,
    tools: [],
  },
  COMPSHARE_API_KEY: {
    key: "COMPSHARE_API_KEY",
    description: "优云智算（Compshare）API key",
    prompt: "Compshare API key",
    url: "https://www.compshare.cn/",
    password: true,
    category: "provider",
    advanced: true,
    tools: [],
  },
  QIANFAN_API_KEY: {
    key: "QIANFAN_API_KEY",
    description: "百度智能云千帆 API key（文心一言 / ERNIE 系列）",
    prompt: "千帆 API key",
    url: "https://cloud.baidu.com/doc/WENXINWORKSHOP/index.html",
    password: true,
    category: "provider",
    advanced: true,
    tools: [],
  },
  HUNYUAN_API_KEY: {
    key: "HUNYUAN_API_KEY",
    description: "腾讯混元 API key",
    prompt: "混元 API key",
    url: "https://cloud.tencent.com/document/product/1729",
    password: true,
    category: "provider",
    advanced: true,
    tools: [],
  },
  SILICONFLOW_API_KEY: {
    key: "SILICONFLOW_API_KEY",
    description: "硅基流动（SiliconFlow）API key",
    prompt: "SiliconFlow API key",
    url: "https://docs.siliconflow.cn/",
    password: true,
    category: "provider",
    advanced: true,
    tools: [],
  },
  MODELSCOPE_API_KEY: {
    key: "MODELSCOPE_API_KEY",
    description: "魔搭 ModelScope 推理服务 API key",
    prompt: "ModelScope API key",
    url: "https://modelscope.cn/docs/model-service/API-Inference/intro",
    password: true,
    category: "provider",
    advanced: true,
    tools: [],
  },
  AI302_API_KEY: {
    key: "AI302_API_KEY",
    description: "302.AI 聚合 API key",
    prompt: "302.AI API key",
    url: "https://302.ai/",
    password: true,
    category: "provider",
    advanced: true,
    tools: [],
  },
  LONGCAT_API_KEY: {
    key: "LONGCAT_API_KEY",
    description: "美团 LongCat API key",
    prompt: "LongCat API key",
    url: "https://longcat.chat/platform/docs",
    password: true,
    category: "provider",
    advanced: true,
    tools: [],
  },
  ARK_BASE_URL: {
    key: "ARK_BASE_URL",
    description: "火山方舟 base URL override (默认: https://ark.cn-beijing.volces.com/api/v3)",
    prompt: "火山方舟 base URL",
    url: null,
    password: false,
    category: "provider",
    advanced: true,
    tools: [],
  },
};

export function envKeyToProvider(envKey: string): string | undefined {
  const map: Record<string, string> = {
    ARK_API_KEY: "volcengine-ark",
    ARK_BASE_URL: "volcengine-ark",
    QIANFAN_API_KEY: "qianfan",
    HUNYUAN_API_KEY: "hunyuan",
    SILICONFLOW_API_KEY: "siliconflow",
    MODELSCOPE_API_KEY: "modelscope",
    COMPSHARE_API_KEY: "compshare",
    AI302_API_KEY: "ai302",
    LONGCAT_API_KEY: "longcat",
  };
  return map[envKey];
}
