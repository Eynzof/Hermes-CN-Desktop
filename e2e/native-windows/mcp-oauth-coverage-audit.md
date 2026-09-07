# MCP OAuth 验收边界核对

原清单把 MCP-004 整项归为缺少 OAuth 账号。标准 MCP OAuth 可以使用框架自有的本地授权服务验证，无需第三方账号；当前的实际阻塞是 Desktop 缺少授权操作入口。

## 安装版复现

`runs/20260907T104625Z` 在 Windows Acceptance 安装版中执行 `60-mcp-oauth.spec.ts`：

1. 启动独立回环端口上的真实 MCP SDK 2.0.0 服务和 OAuth 授权服务。
2. 独立服务自检通过匿名拒绝、授权发现、取消和 state、错误 PKCE 拒绝、正确 PKCE 和授权码防重放、真实 SHA256 工具调用、刷新轮换以及撤销后拒绝访问。此处是测试设施验证，不是 Desktop 验收。
3. 通过 Desktop 的添加对话框保存 HTTP 地址，点击测试连接。服务端记录 10 次 HEAD / POST 请求，全部返回 401；没有客户端注册、授权或令牌请求。
4. 页面显示 `Server returned an error response`，服务卡片仅有禁用、测试连接和删除；保存的配置为 `auth: null`。授权入口断言失败。
5. 通过 UI 删除测试服务，结束该服务的进程树，核对端口关闭。

已有 UI 快照、截图、配置读取及分阶段服务事件附件。服务日志不记录授权码、令牌或请求认证头。所有身份和令牌只属于本次独立内存服务。

## 对应实现

- Desktop `web/src/components/mcp/mcp-add-dialog.tsx` 没有认证方式字段；`mcp-server-card.tsx` 没有授权、取消或退出操作。
- `web/src/hooks/use-mcp.ts` 只调用测试连接接口。注释声称 OAuth 服务会触发浏览器授权，与当前实现不一致。
- 对应 Core `hermes_cli/web_routers/mcp.py` 的 `/api/mcp/servers/{name}/test` 只探测；另有独立的 `/auth`、授权流查询和取消端点。
- 协议类型包含可选 `auth`，不能据此认定界面已实现。

MCP-004 因 WIN-023 保持失败。脚本目前自动复现到最早的授权入口门槛；Desktop 登录后的取消、刷新和退出尚未执行，也未声称完成脚本化。入口出现后脚本会明确要求接管新增界面继续补齐，不会仅凭入口存在把整项判为通过。没有直接调用 Core 授权接口来替代用户操作，也未修改产品。

探索记录 `104443Z`（HTTP 客户端包名）和 `104522Z`（SDK 撤销请求字段）属于 TEST-037，不作为产品缺陷证据。固定 SDK 依赖为 `httpx2`；其公开客户端撤销请求仍要求显式空 `client_secret` 字段，测试已适配该实际版本。
