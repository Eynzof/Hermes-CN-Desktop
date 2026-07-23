import { useState } from "react";
import { useSetAtom } from "jotai";
import {
  BarChart3,
  Bug,
  Code2,
  FileText,
  FileEdit,
  Palette,
  Rocket,
  BookOpenText,
  GitPullRequest,
  Newspaper,
} from "lucide-react";
import { composerPrefillAtom } from "@/stores/panel";
import { PanelComposer } from "@/components/panel/panel-composer";
import { RECIPES_NEW_TASK, RECIPES_PANEL } from "@/components/panel/quick-start";
import s from "./panel.module.css";

type HomeMode = "office" | "code";

interface ScenarioChip {
  label: string;
  icon: typeof FileText;
  prompt: string;
}

const OFFICE_CHIPS: readonly ScenarioChip[] = [
  {
    label: "文档处理",
    icon: FileText,
    prompt:
      "帮我处理文档：\n- 提取核心要点\n- 按需要改写 / 翻译 / 排版\n输出结构化结果并与原文对照。\n\n文档路径：",
  },
  {
    label: "数据分析及可视化",
    icon: BarChart3,
    prompt:
      "分析我指定的数据文件，输出：\n- 关键指标概览\n- 趋势与异常点\n- 可视化图表（生成 HTML 报表）\n\n数据文件：",
  },
  {
    label: "写周报",
    icon: Newspaper,
    prompt:
      "帮我整理本周工作并生成周报：\n- 本周完成的事项（按项目分组）\n- 关键数据与成果\n- 下周计划\n\n工作材料位置：",
  },
  {
    label: RECIPES_PANEL[3].title,
    icon: BookOpenText,
    prompt: RECIPES_PANEL[3].prompt,
  },
];

const CODE_CHIPS: readonly ScenarioChip[] = [
  {
    label: "修一个 Bug",
    icon: Bug,
    prompt:
      "项目里有一个待修复的 bug：\n\n现象：\n期望行为：\n复现步骤：\n\n请先定位根因，给出修复方案并实施，最后运行相关测试验证。",
  },
  {
    label: RECIPES_PANEL[0].title,
    icon: GitPullRequest,
    prompt: RECIPES_PANEL[0].prompt,
  },
  {
    label: RECIPES_PANEL[2].title,
    icon: FileEdit,
    prompt: RECIPES_PANEL[2].prompt,
  },
  {
    label: RECIPES_NEW_TASK[3].title,
    icon: BookOpenText,
    prompt: RECIPES_NEW_TASK[3].prompt,
  },
];

export function PanelRoute() {
  const [mode, setMode] = useState<HomeMode>("office");
  const setPrefill = useSetAtom(composerPrefillAtom);
  const chips = mode === "office" ? OFFICE_CHIPS : CODE_CHIPS;

  return (
    <div className={s.home} data-window-drag data-tauri-drag-region="deep">
      <div className={s.homeCol}>
        <div className={s.hero} data-no-drag>
          Hermes
        </div>
        <div className={s.hero2} data-no-drag>
          你的职场超能力
        </div>

        <div className={s.modeTabs} data-no-drag>
          <button
            type="button"
            className={s.modeTab}
            data-active={mode === "office" ? "true" : undefined}
            onClick={() => setMode("office")}
          >
            <Rocket size={14} />
            日常办公
          </button>
          <button
            type="button"
            className={s.modeTab}
            data-active={mode === "code" ? "true" : undefined}
            onClick={() => setMode("code")}
          >
            <Code2 size={14} />
            代码开发
          </button>
          <button
            type="button"
            className={s.modeTab}
            disabled
            title="依赖 Core 支持，预留"
          >
            <Palette size={14} />
            设计创意
          </button>
        </div>

        <div className={s.chips} data-no-drag>
          {chips.map((chip) => {
            const Icon = chip.icon;
            return (
              <button
                key={chip.label}
                type="button"
                className={s.chip}
                title="点击填入输入框"
                onClick={() => setPrefill({ text: chip.prompt, nonce: Date.now() })}
              >
                <Icon size={13} />
                {chip.label}
              </button>
            );
          })}
        </div>

        <div data-no-drag>
          <PanelComposer />
        </div>

        <div className={s.disclaimer} data-no-drag>
          内容由 AI 生成，请核实重要信息
        </div>
      </div>
    </div>
  );
}
