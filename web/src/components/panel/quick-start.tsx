import { useSetAtom } from "jotai";
import { composerPrefillAtom } from "@/stores/panel";
import s from "./quick-start.module.css";

export interface Recipe {
  num: string;
  title: string;
  desc: string;
  prompt: string;
}

export const RECIPES_PANEL: Recipe[] = [
  {
    num: "[ 01 ] CODE",
    title: "代码评审 + PR 草稿",
    desc: "对比基线分支差异，标记风险，撰写 PR 正文。",
    prompt:
      "请评审当前分支与 main 的差异：\n1. 标记潜在风险（破坏性变更 / 遗漏测试 / 性能回归 / 安全问题）。\n2. 按文件归类列出主要改动。\n3. 给一段可粘贴的 PR 描述（中英都可）。",
  },
  {
    num: "[ 02 ] SPEC",
    title: "需求转 PRD",
    desc: "先反问澄清，再补全目标 / 非目标 / 方案。",
    prompt:
      "把以下需求扩展成一份 PRD：先反问 3-5 个澄清问题，等我回答后再输出。最终格式：\n- 目标 / 非目标\n- 用户故事\n- 方案概述\n- 验收标准\n- 风险与开放问题\n\n需求：",
  },
  {
    num: "[ 03 ] TEST",
    title: "排查失败测试",
    desc: "运行测试，归类失败类型，提出修复建议。",
    prompt:
      "运行项目的单元/集成测试，归类失败：\n- 环境/依赖问题\n- 断言期望过严\n- 被测代码 bug\n- flaky\n\n每类给一个最简修复建议；如果是真实 bug 顺手起一个 issue 草稿（标题 + 一段复现步骤）。",
  },
  {
    num: "[ 04 ] DAILY",
    title: "每日简报",
    desc: "总结收件箱与日历，输出当日要务。",
    prompt:
      "把今天的会议、邮件、PR 评论、待办整合成一份每日简报：\n- 今日 3 条要务（按重要性排序，每条注明截止/相关人）\n- 其它进展（按时间顺序，单行简述）\n- 需要我决定的事项",
  },
];

export const RECIPES_NEW_TASK: Recipe[] = [
  RECIPES_PANEL[0],
  RECIPES_PANEL[1],
  RECIPES_PANEL[2],
  {
    num: "[ 04 ] DOCS",
    title: "生成开发文档",
    desc: "读懂模块，写参考 + 教程，捕捉边界与警告。",
    prompt:
      "为指定的模块生成开发文档：\n- 模块概述与使用场景\n- 主要 API / 函数参考（参数、返回、异常）\n- 一段最小可运行示例\n- 已知边界条件与警告\n\n模块路径：",
  },
  {
    num: "[ 05 ] DATA",
    title: "抓取 + 综合多源",
    desc: "拉取 URL 列表，提取结构化字段，带引用做摘要。",
    prompt:
      "我会给你一组 URL。请逐个拉取并提取：\n- 标题 / 作者 / 发布时间\n- 核心论点（3-5 条）\n- 数据 / 数字\n\n最后输出一份带原文引用的综合摘要（每条结论后注明来自哪个 URL）。\n\nURL 列表：",
  },
  {
    num: "[ 06 ] PLAN",
    title: "规划多阶段迁移",
    desc: "盘点表面，提出阶段拆分，生成带 checkpoint 的步骤。",
    prompt:
      "帮我把以下迁移任务拆成多阶段执行：\n- 先盘点改动表面（涉及的文件/模块/接口）\n- 按风险与依赖顺序提出 3-5 个阶段\n- 每阶段有明确的 checkpoint（通过哪个测试 / 通过谁的 review 才进下一阶段）\n\n迁移任务：",
  },
];

interface QuickStartProps {
  recipes?: Recipe[];
  columns?: number;
}

export function QuickStart({ recipes = RECIPES_PANEL, columns }: QuickStartProps) {
  const setPrefill = useSetAtom(composerPrefillAtom);
  const gridStyle = columns
    ? ({ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } as React.CSSProperties)
    : undefined;

  return (
    <div className={s.grid} style={gridStyle}>
      {recipes.map((recipe) => (
        <button
          key={recipe.num}
          type="button"
          className={s.card}
          onClick={() => setPrefill({ text: recipe.prompt, nonce: Date.now() })}
          title="点击填入输入框"
        >
          <div className={s.num}>{recipe.num}</div>
          <div className={s.title}>{recipe.title}</div>
          <div className={s.desc}>{recipe.desc}</div>
        </button>
      ))}
    </div>
  );
}
