# YOLO 模式（自动批准危险命令）

桌面版支持开启 **YOLO 模式**：开启后，Agent 在执行 shell 命令、删除文件等
高危操作时**不再弹出二次确认**，全部自动批准。该能力对应后端的
`HERMES_YOLO_MODE` 环境变量（等同 CLI 的 `--yolo` 参数）。

> ⚠️ **风险提示**：YOLO 模式会绕过所有危险命令审批。Agent 可能在你的工作区
> 内执行不可逆操作（删除文件、改写代码、运行任意命令）。**请仅在受信任的
> 工作区、且你清楚 Agent 将要做什么时启用。**

## 如何开启 / 关闭

桌面端「设置 → 常规 → YOLO 模式」提供开关：

1. 打开设置页，切换到「常规」。
2. 找到「YOLO 模式」，点「开启」或「关闭」。
3. 桌面端会**自动重启内核**（managed runtime）以使设置生效，期间会短暂显示
   重启遮罩。重启完成后即可验证：高危命令将不再触发审批弹窗。

设置按当前 **Profile** 持久化（保存在该 Profile 的 `HERMES_HOME` 下的
`desktop-ui.sqlite` 中），**重启桌面端后仍然生效**。

## 工作原理

后端在进程启动（模块导入）时**一次性冻结** `HERMES_YOLO_MODE` 的值，运行期间
无法再改。因此桌面端的实现是：

1. 把开关偏好持久化到 UI 存储（KV 键 `desktop.yoloMode`，按 `HERMES_HOME`
   维度区分 Profile）。
2. 启动 / 重启 managed dashboard 子进程时（`src/process/dashboard.rs` 的
   `spawn_dashboard`），读取该偏好：
   - 开启 → 注入 `HERMES_YOLO_MODE=1`；
   - 关闭 → 显式 `env_remove`，确保不会被继承的环境变量意外重新打开。
3. 生产模式和开发模式走的是同一条 `spawn_dashboard` 路径，行为一致。

这样无论是「切换开关后立即重启」还是「下次启动桌面端」，配置都会按预期生效。

## 验证是否生效

- **运行时行为**：开启后，让 Agent 执行一条危险命令（如删除文件），应当
  **不再出现审批确认**，直接执行。
- **配置状态**：前端可调用 `get_yolo_mode` 命令，返回
  `{ enabled, effective }`：
  - `enabled` —— 当前持久化的偏好；
  - `effective` —— **正在运行**的内核实际启动时的 YOLO 状态。
  - 切换开关并完成重启后，两者应一致。

## 高级 / 开发用法

如果你通过环境变量启动桌面端，可在桌面端进程的环境里直接设置
`HERMES_YOLO_MODE=1`。该 env 会与界面开关「或」叠加（任一为真即开启），方便
在 dev / 脚本场景下临时启用，而无需先点界面开关。

## 相关代码

| 位置 | 作用 |
| --- | --- |
| `src/ui_store.rs` | `yolo_mode_enabled` / `set_yolo_mode` —— 偏好持久化 |
| `src/process/dashboard.rs` | `yolo_mode_effective` + `spawn_dashboard` 注入 env |
| `src/commands/yolo.rs` | `get_yolo_mode` / `set_yolo_mode` 命令（含重启内核） |
| `web/src/hooks/use-yolo-mode.ts` | 前端查询 / 切换 hook |
| `web/src/routes/settings.tsx` | 设置页「常规」中的开关 UI |
