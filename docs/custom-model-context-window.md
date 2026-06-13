# 用户自定义模型上下文窗口（Custom Model Context Window）

> 目标：让用户在桌面端「模型设置」里，对**当前主模型**手动声明上下文窗口长度（context window，单位 token），
> 填 `0` 则回退到运行时自动探测值。前端把该值作为顶层字段 `model_context_length` 写入 `POST /api/config`，
> 后端（hermes-agent dashboard）已支持该契约并将其作为**最高优先级**覆盖一切自动探测。
>
> 分支：`feat/custom-model-context-window`（worktree 基线 `origin/main` = `2a513b5`）
> 本文件是**活文档**，每完成一步就更新「进度跟踪」表。

---

## 1. 背景与动机

不同 provider 对同一模型上报的上下文长度经常不一致，自定义/本地（vLLM、Ollama、LM Studio、自建 OpenAI 兼容
端点）更是探测不到准确值。运行时 `get_model_context_length()` 的兜底默认是 256K，对很多本地小模型偏大，会导致：

- 上下文用量百分比（状态栏 / 编辑器旁的 context 指示）算错，用户以为还有余量，实际已超模型真实窗口 → 报错或被服务端截断；
- 压缩（compaction）触发时机错位。

让用户对单个模型显式声明上下文长度，是补齐探测不到时的最后一公里。**后端这条路已经完全打通，缺的只是桌面端的输入入口。**

## 2. 后端契约（已就绪，无需改动 Core）

来源：`../Hermes-CN-Core` `origin/main`。

| 端点 | 字段 | 语义 |
|--|--|--|
| `GET /api/config` | 顶层 `model_context_length: number` | 由后端从 `model.context_length` 扁平化得到（`web_server.py:2100-2105`）；`0` = 未设置 |
| `POST /api/config` | 顶层 `model_context_length: number` | `_denormalize_config_from_web()` 取出后写回 `model.context_length`；`0` 或缺省 = 删除该 key 走自动探测（`web_server.py:2497-2530`） |
| `GET /api/model/info` | `auto_context_length` / `config_context_length` / `effective_context_length` | 分别是「自动探测值 / 用户覆盖值 / 实际生效值」（`web_server.py:2129-2205`） |

解析优先级（`agent/model_metadata.py:get_model_context_length()` 第 0 步）：
**显式配置覆盖 `> 0` → 直接返回，优先于缓存、各家 provider 实时探测、models.dev、硬编码默认（256K 兜底）。**
注释原话：`Explicit config override — user knows best`。

⚠️ **语义要点**：覆盖值绑定在「当前 `model.*`」上，不是 per-provider-per-model 持久表。切换主模型时，旧的
`model.context_length` 应当清掉，否则会把 A 模型的窗口串到 B 模型（Core 侧已有同类修复，见其 `#15779`）。

## 3. 桌面端现状盘点（关键：90% 已具备）

| 能力 | 状态 | 位置 |
|--|--|--|
| `ModelInfo` 三字段类型 | ✅ 已定义 | `packages/protocol/src/hermes-api.ts:374-382` |
| `useModelInfo()` 拉取 `/api/model/info` | ✅ 已有 | `web/src/hooks/use-config.ts:34-40` |
| `model_context_length` 中文翻译 | ✅ 已有 | `web/src/lib/config-translations.ts:19` |
| 上下文长度解析（多来源兼容 `context_length`/`context_window`） | ✅ 已有 | `web/src/lib/model-context.ts:resolveModelContextWindow()` |
| 上下文用量百分比 / 风险等级 | ✅ 已有并多处集成（状态栏、编辑器、健康面板） | `web/src/lib/context-usage.ts` |
| 配置读写链路（透传任意字段、保存后失效 `model-info`） | ✅ 已有 | `web/src/hooks/use-config.ts:42-53` |
| **让用户填写覆盖值的 UI 输入框** | ❌ **缺失** | 待新增于 `settings-models-section.tsx` |
| 保存路径把输入值映射成顶层 `model_context_length` | ❌ **缺失** | 待新增于 `provider-catalog.ts` 的 build 函数 |

结论：**纯前端改动，不碰 Rust、不碰 Core。** 主要工作是一个数字输入框 + 在 `buildCurrentModelConfigUpdate`
里多写一个顶层字段，再加上「切模型清空 / 三值回显」两个体验项。

## 4. 实现方案

### 4.1 数据流

```
[设置 → 模型 → 主模型卡片]  新增「上下文窗口」数字输入框（providerForm.contextWindow）
      │  空串 / "0" = 自动
      ▼
handleProviderSave / handleSetCurrentModel
      │  ProviderConfigInput 增加 contextWindow?: string
      ▼
buildCurrentModelConfigUpdate(config, preset, input)
      │  顶层写入 model_context_length = parsePositiveInt(input.contextWindow) ?? 0
      ▼
useSaveConfig() → PUT /api/config  →  后端 denormalize → model.context_length
      │  onSuccess 失效 ["config"] 与 ["model-info"]
      ▼
useModelInfo() 重新拉取 → effective_context_length 更新 → 上下文用量指示自动刷新
```

### 4.2 改动清单（按文件）

**A. `web/src/lib/provider-catalog.ts`**

1. `ProviderConfigInput`（`:202-206`）新增可选字段：
   ```ts
   export interface ProviderConfigInput {
     apiKey: string;
     baseUrl: string;
     model: string;
     contextWindow?: string; // 用户输入的字符串，空/"0" 表示自动
   }
   ```
2. 新增纯函数 `parseContextWindowInput(raw: string | undefined): number`：去空白；空串 / 非数字 / `<0` → `0`；
   否则向下取整。**单测覆盖**（见 §6）。
3. `buildCurrentModelConfigUpdate()`（`:704-729`）在返回对象里多写一个**顶层**字段（注意是顶层，
   不是 `model.context_length`——交给后端 denormalize 落盘）：
   ```ts
   return {
     ...config,
     model: { ...existingModel, provider: preset.id, default: model, /* ... */ },
     model_context_length: parseContextWindowInput(input.contextWindow),
   };
   ```
   - `buildProviderConfigUpdate()`（设置当前模型路径）经由它，自动带上该字段。
   - `buildProviderSettingsUpdate()`（只存 provider、不切当前模型的「保存」路径）**不写**该字段——
     因为覆盖值是绑定到「当前模型」语义的，仅在 set-current 时落。

   ⚠️ **切模型清空**：`buildCurrentModelConfigUpdate` 始终输出 `model_context_length`（用户没填即 `0`），
   因此切到新模型并保存时会把旧覆盖重置为 `0`（= 自动），符合 §2 的语义要点。

**B. `web/src/routes/settings-models-section.tsx`**

4. `providerForm` 初始 state（`:639-643`）增加 `contextWindow: ""`；切换 provider / 选中模型时
   从 `config.model_context_length` 回填（仅当该 provider 是当前 provider 时；`>0` 才填，`0` 显示空串）。
5. 主模型卡片的 Base URL / 模型名称下方，新增一个数字输入框，**复用既有 timeout 字段写法**
   （`:2146-2155` 的 `.fieldRow` + `.fieldLabel` + `.fieldInput` + `inputMode="numeric"` + `data-mono`）：
   - 标签：`上下文窗口（token，0 = 自动探测）`
   - 占位：当前 `effective_context_length`（来自 `useModelInfo()`）格式化为 `128,000` 作为 placeholder，提示自动值；
   - `onChange` → `updateProviderForm({ contextWindow: e.target.value })`。
6. `handleProviderSave` / `handleSetCurrentModel` 透传 `providerForm`（已自动含新字段，无需改函数签名）。
7. 表单 dirty 判定（`:974-976`）把 `contextWindow` 纳入，否则只改窗口值时保存按钮不亮。

**C. （可选，建议同 PR）三值回显**

8. 在主模型卡片显示一行只读说明，消费 `useModelInfo()`：
   - `自动探测 {auto_context_length} · 当前覆盖 {config_context_length || '无'} · 实际生效 {effective_context_length}`。
   - 让用户清楚「我填的」与「系统探测的」「最终用的」三者关系，补齐上游 Electron 端都没做的展示空白。

### 4.3 边界与校验

- **输入校验**：仅接受非负整数；建议软上限提示（如 `> 5,000,000` 时给一句 warning 文案，但不阻断）。
- **`0` 语义**：空串与 `0` 等价 = 自动；UI 上不要把 `0` 当成「0 长度」。
- **不污染辅助任务**：辅助模型（vision/compression 等）走另一套 `auxForm`，本期不加该字段。
- **profile 切换**：`useModelInfo` / `useConfig` 已按 `profile` 维度 queryKey 缓存，天然隔离。

## 5. UI 文案（zh）

| 元素 | 文案 |
|--|--|
| 字段标签 | 上下文窗口 |
| 字段说明 | 留空或填 0 使用该模型自动探测到的上下文窗口；本地 / 自建模型探测不准时可在此手动指定。 |
| placeholder | 自动（约 {effective}） |
| 三值回显 | 自动探测 {auto} · 覆盖 {config} · 生效 {effective} |

不硬编码颜色/字号，复用 `packages/shared-ui/src/tokens/` 与 `settings.module.css` 既有类。

## 6. 测试

**单元测试（vitest）**

- `web/src/lib/provider-catalog.test.ts`（或新建）：
  - `parseContextWindowInput`：`""`→0、`"0"`→0、`"128000"`→128000、`"128k"/abc`→0、`"-5"`→0、`" 200000 "`→200000、`"100.9"`→100。
  - `buildCurrentModelConfigUpdate`：填值 → 输出含顶层 `model_context_length`；空值 → `0`；切 provider → 重置为 `0`。
  - `buildProviderSettingsUpdate`：**不**输出 `model_context_length`。
- 回填逻辑：`config.model_context_length>0` 且 provider==current → form 显示该值；其它情况显示空串。

**手动冒烟**（参考 `.codex/skills/desktop-dual-repo-test/SKILL.md`，`pnpm tauri:dev -- --source ../Hermes-CN-Core`）：

1. 选一个本地/自定义 provider，填 `200000`，设为当前模型 → 保存成功。
2. `GET /api/config` 顶层 `model_context_length == 200000`；`GET /api/model/info` `config==200000`、`effective==200000`。
3. 状态栏 / 编辑器上下文百分比按 200000 计算。
4. 清空改回空串保存 → 后端 `model.context_length` 被删除，`effective` 回到 `auto`。
5. 切到另一个模型保存 → 旧覆盖被重置为自动。

**改完必跑**：`pnpm typecheck`、`pnpm test:unit`、`cargo check`（本期不改 Rust，仍跑一遍确保未误触）。

## 7. 验收标准（DoD）

- [ ] 主模型卡片有「上下文窗口」数字输入，空/0=自动。
- [ ] 保存后 `POST /api/config` 顶层带正确 `model_context_length`；`/api/model/info` 三值一致。
- [ ] 上下文用量指示按覆盖值刷新。
- [ ] 切换主模型会重置旧覆盖。
- [ ] 三值回显（自动/覆盖/生效）。
- [ ] 单测覆盖解析与 build 函数；`pnpm typecheck` + `pnpm test:unit` 通过。
- [ ] 不改 Rust、不改 Core。

## 8. 非目标（本期不做）

- 辅助任务模型的上下文覆盖。
- per-provider-per-model 的持久覆盖表（后端当前语义是 per-current-model）。
- `custom_providers` 数组内每条模型独立的 `context_length`（后端 `get_custom_provider_context_length` 支持，但 UI 复杂度高，另立 issue）。

## 9. 进度跟踪

| 步骤 | 文件 | 状态 |
|--|--|--|
| 方案文档 | `docs/custom-model-context-window.md` | ✅ 完成 |
| `ProviderConfigInput` + `parseContextWindowInput` | `web/src/lib/provider-catalog.ts` | ✅ 完成 |
| `buildCurrentModelConfigUpdate` 写顶层字段 | `web/src/lib/provider-catalog.ts` | ✅ 完成 |
| 输入框 + 回填 + dirty 判定 | `web/src/routes/settings-models-section.tsx` | ✅ 完成 |
| 三值回显 | `web/src/routes/settings-models-section.tsx` | ✅ 完成 |
| 单元测试 | `web/src/lib/provider-catalog.test.ts` | ✅ 完成（新增 9 例，`provider-catalog.test.ts` 共 35 例通过） |
| `typecheck` / `test:unit` | — | ✅ 通过（full typecheck 绿；web 589 例全过） |
| 打包态手动冒烟 | — | ⬜ 待办（需 `pnpm tauri:dev`，留给本地验证） |

### 实现细节补记（与方案的差异）

- 「保存配置」路径（`buildProviderSettingsUpdate`，只存 provider 不切模型）原计划完全不写
  `model_context_length`。实测发现：当所选 provider 已经是当前模型时，「设为当前模型」按钮被禁用
  （`selectedProviderIsCurrent`），用户将无从修改当前模型的上下文覆盖。故改为：在 `handleProviderSave`
  里**仅当 `selectedProviderIsCurrent` 为真**时，于保存包里附加 `model_context_length`，避免给非当前
  provider 写入而误伤真正当前模型的覆盖。
- 三值回显仅在所选 provider 即当前模型时展示（`/api/model/info` 描述的是当前模型）；非当前 provider
  下给出「该值会在『设为当前模型』时生效」提示。
