// 供应商品牌图标注册表。大部分图标文件取自 cc-switch（MIT）的 extracted
// 图标集；Agnes 使用其官方文档站 favicon。素材按目录 icon key 重命名后
// 存放在 assets/provider-icons/ 下。
// key 与 ProviderPreset.icon 对应；远端 catalog 下发未知 key 时由调用方
// 回退到首字母色块。
import aicodemirror from "@/assets/provider-icons/aicodemirror.svg";
import aigocode from "@/assets/provider-icons/aigocode.svg";
import agnes from "@/assets/provider-icons/agnes.png";
import anthropic from "@/assets/provider-icons/anthropic.svg";
import apikeyfun from "@/assets/provider-icons/apikeyfun.png";
import baidu from "@/assets/provider-icons/baidu.svg";
import bailian from "@/assets/provider-icons/bailian.svg";
import ccsub from "@/assets/provider-icons/ccsub.svg";
import compshare from "@/assets/provider-icons/compshare.svg";
import cubence from "@/assets/provider-icons/cubence.svg";
import deepseek from "@/assets/provider-icons/deepseek.svg";
import gemini from "@/assets/provider-icons/gemini.svg";
import hunyuan from "@/assets/provider-icons/hunyuan.svg";
import kimi from "@/assets/provider-icons/kimi.svg";
import longcat from "@/assets/provider-icons/longcat.svg";
import micu from "@/assets/provider-icons/micu.svg";
import minimax from "@/assets/provider-icons/minimax.svg";
import modelscope from "@/assets/provider-icons/modelscope.svg";
import nekocode from "@/assets/provider-icons/nekocode.png";
import nvidia from "@/assets/provider-icons/nvidia.svg";
import opencodeGo from "@/assets/provider-icons/opencode-go.svg";
import openrouter from "@/assets/provider-icons/openrouter.svg";
import openai from "@/assets/provider-icons/openai.svg";
import packycode from "@/assets/provider-icons/packycode.svg";
import rightcode from "@/assets/provider-icons/rightcode.svg";
import siliconflow from "@/assets/provider-icons/siliconflow.svg";
import sssaicode from "@/assets/provider-icons/sssaicode.svg";
import stepfun from "@/assets/provider-icons/stepfun.svg";
import volcengine from "@/assets/provider-icons/volcengine.png";
import xiaomiMimo from "@/assets/provider-icons/xiaomi-mimo.svg";
import xai from "@/assets/provider-icons/xai.svg";
import zhipu from "@/assets/provider-icons/zhipu.svg";

const PROVIDER_ICON_URLS: Record<string, string> = {
  aicodemirror,
  aigocode,
  agnes,
  anthropic,
  apikeyfun,
  baidu,
  bailian,
  ccsub,
  compshare,
  cubence,
  deepseek,
  gemini,
  hunyuan,
  kimi,
  longcat,
  micu,
  minimax,
  modelscope,
  nekocode,
  nvidia,
  "opencode-go": opencodeGo,
  openai,
  openrouter,
  packycode,
  rightcode,
  siliconflow,
  sssaicode,
  stepfun,
  volcengine,
  xai,
  "xiaomi-mimo": xiaomiMimo,
  zhipu,
};

export function getProviderIconUrl(icon: string | undefined): string | undefined {
  if (!icon) return undefined;
  return PROVIDER_ICON_URLS[icon];
}
