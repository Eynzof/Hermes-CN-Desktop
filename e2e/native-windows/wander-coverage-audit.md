# Wander 流程清单修正

2026-09-07 对照安装版对应的 Desktop 提交 `55c672c` 重新核查七个 Wander 路由。此前六项前置条件写成“Wander 测试账号或服务配置”，过早把本地服务测试归入账号阻塞；这是测试清单错误。

实际页面调用独立的 MemOS REST / WS / FS 服务，默认端口 18400 / 18401 / 18402，无云账号鉴权。`docs/wander-memory-merge.md` 的第 1、3、5 节，以及 `web/src/lib/wander-memory/endpoints.ts`、`client.ts` 与各路由是事实来源。服务代码采用 Desktop 现有集成固定的 `Wander-Minds/Wander-Memory@efea8c6b0ea8c16cf1593082a93905acd7a055e3`，不是当前 Wander-Memory 本地默认分支的旧实现。

| 编号 | 当前页面实际提供的操作 | 旧清单中误写的操作 |
|---|---|---|
| WANDER-001 | health/models/backends、端点展示、重新发现端点、run maintenance | 云账号登录、空间选择、退出 |
| WANDER-002 | 创建、元数据校验、库存及 top_k 搜索、JSON 查看、取消和确认删除 | 独立编辑入口；页面明确说明写入走 add + collision merge |
| WANDER-003 | 目录扫描、文件详情、关联记忆、自定义 ingest、reload | 文件上传、目录管理、删除文件；这些是后端能力，当前 Desktop 页面没有入口 |
| WANDER-004 | 粘贴文本或 JSON 对话、提取导入、结果卡片及库存验证 | 对话记录管理和历史检索 |
| WANDER-005 | 基于记忆的聊天、WS 状态、生成结果、来源片段、清空对话 | 无账号前置条件 |
| WANDER-006 | query/top_k、上下文构建展示、复制 | 无账号前置条件 |

上述纠正不把原本未运行的项目记为通过。每项仍以安装版真实执行结果为准。后端存在而 Desktop 尚无 UI 的功能不宣称已通过界面验收。

模型配置固定为 DeepSeek 官方 flash。`wander-observer.py` 启动未经修改的 MemOS 模块，仅旁路记录原 `urllib` 请求和原响应读取返回的 SSE 字节；传给服务的内容、TLS 校验、HTTP 目标和异常均保持原样。真实调用的证明包含官方请求地址、模型、响应 ID、结束事件和供应商返回的正输出 Token，不使用原网页 E2E 中的 dummy backend。
