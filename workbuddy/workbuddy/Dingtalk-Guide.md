> 来源：[CodeBuddy 官方文档](https://www.codebuddy.cn/docs/workbuddy/Dingtalk-Guide)

# WorkBuddy 接入钉钉指南

本指南将帮助您在钉钉中配置 WorkBuddy 机器人，让您可以通过钉钉随时随地远程操控电脑上的 WorkBuddy 完成编程任务。

## 一、前提条件

在开始之前，请确保您已满足以下条件：

- 已在电脑上安装 WorkBuddy，并开启了 **助理** 远程控制功能
- 拥有一个具有**企业管理员权限**的钉钉账号

> **提示**
>
> 如果您还没有钉钉账号，请前往 [钉钉官网](https://www.dingtalk.com/download) 下载客户端并创建团队。

## 二、创建钉钉应用

### 1）登录开发者后台

打开浏览器，访问 [钉钉开发者后台](https://open.dingtalk.com/)，使用管理员账号登录。

![登录开发者后台](https://www.codebuddy.cn/docs/static/login-developer-console.CLo2owy8.png)

> **首次使用**
>
> 如果系统提示「该账号还未加入组织」，您可以创建一个个人企业，按需填写信息即可。

![创建个人企业](https://www.codebuddy.cn/docs/static/create-personal-org.CCdsgAJ_.png)

### 2）创建应用

1. 在开发者后台首页，点击「应用开发」，并点击「创建应用」

![创建应用](https://www.codebuddy.cn/docs/static/create-app.BYp0m06K.png)

2. 在弹出的创建窗口中，填写以下信息：

| 配置项 | 填写内容（后续都可以随意修改） | 说明 |
| --- | --- | --- |
| 应用名称 | （内容随便写） | 自定义名称 |
| 应用描述 | （内容随便写） | 简单描述用途 |
| 应用类型 | 可以暂时不传 |  |

![填写应用信息](https://www.codebuddy.cn/docs/static/fill-app-info.BYBmvoBC.png)

3. 填写完成后，点击「保存」

### 3）添加机器人能力

应用创建成功后，会自动跳转到「添加应用能力」页面：

1. 找到「机器人」选项，点击「添加机器人」

![添加机器人能力](https://www.codebuddy.cn/docs/static/add-robot-capability.CZkfvmyl.png)

2. 填写机器人的基本信息：
   - **机器人名称**：给机器人起一个名字
   - **机器人描述**：简单描述功能
   - **预览图**：上传一张机器人头像

![配置机器人信息](https://www.codebuddy.cn/docs/static/config-robot-info.DY4EBXm0.png)

3. 点击「确认发布」

![确认发布机器人](https://www.codebuddy.cn/docs/static/confirm-publish-robot.gisNfn0e.png)

## 三、配置应用权限

为了让机器人能够正常收发消息，需要开通以下权限：

1. 在应用详情页左侧菜单中，点击「权限管理」
2. 在搜索框中分别搜索以下权限，并点击「立即开通」：
   - `Card.Streaming.Write`
   - `Card.Instance.Write`
   - `qyapi_robot_sendmsg`

![添加权限](https://www.codebuddy.cn/docs/static/add-permissions.DF98JOdW.png)

## 四、获取应用凭证

### 1）查看凭证信息

1. 在应用详情页左侧菜单中，点击「凭证与基础信息」
2. 在页面中找到以下两个重要信息：
   - **Client ID**（也叫 AppKey）
   - **Client Secret**（也叫 AppSecret）

> **重要**
>
> 这两个凭证非常重要，请务必妥善保存，不要泄露给他人！

![获取凭证](https://www.codebuddy.cn/docs/static/get-credentials.GWm559Bt.png)

### 2）获取 AES Key 和 Token

在应用详情页左侧菜单中，点击「开发配置 - 事件订阅」，在「推送方式」中选择「HTTP推送」。

您可以点击刷新按钮自动生成您的 AES Key 和 Token。

![AES Key 和 Token](https://www.codebuddy.cn/docs/static/dingtalk-aes-token.C5mRmrgS.png)

> **重要**
>
> 请务必妥善保管 AES Key 和 Token，不要泄露给他人！

## 五、在 WorkBuddy 中配置钉钉

### 1）填写凭证

打开 WorkBuddy，点击助理的**设置⚙️**图标后进入**助理设置**，选择**钉钉集成**：

![钉钉集成入口](https://www.codebuddy.cn/docs/static/dingtalk-1.HLe1RdDx.png)

将刚才获取的 Client ID 和 Client Secret 填入对应输入框：

- **WebSocket 长连接**模式 适用于个人/家庭/办公室用户（没有公网 IP）。配置更简单，不需要公网地址，开箱即用。

![WebSocket长连接模式](https://www.codebuddy.cn/docs/static/dingtalk-2.BlZP-Yfa.png)

- **使用 URL 回调**模式 适用于有服务器、有公网 IP 的用户，需要额外在钉钉开发者后台填写生成的 Webhook 地址。

![URL回调模式](https://www.codebuddy.cn/docs/static/dingtalk-3.BWbUQV9Z.png)

### 2）注册

- WebSocket 长连接：点击「注册」配置成功后显示「已连接」：

![WebSocket已连接](https://www.codebuddy.cn/docs/static/dingtalk-4.B5dZu0o2.png)

- 使用 URL 回调：点击注册后显示「已注册」，系统会生成一个 Webhook 地址，点击复制保存：

![URL回调已注册](https://www.codebuddy.cn/docs/static/dingtalk-5.CfyUyl-J.png)

选择「使用 URL 回调」，还需要返回钉钉开发者后台，配置钉钉消息接收地址：

1. 进入机器人配置页面
2. 下滑到页面底部，找到消息接收配置
3. 将「Stream 模式」切换为「**HTTP 模式**」

![切换HTTP模式](https://www.codebuddy.cn/docs/static/switch-http-mode.BA2uojja.png)

4. 在「消息接收地址」中粘贴 Webhook 地址
5. **重要**：将地址中的 `http` 改为 `https`
6. 点击「发布」保存配置

![配置Webhook地址](https://www.codebuddy.cn/docs/static/config-webhook.UDh3FyeJ.png)

## 六、发布应用

应用必须发布后才能在钉钉中使用。

### 1）创建版本

1. 点击页面上方的「查看版本详情」

![查看版本详情](https://www.codebuddy.cn/docs/static/view-version-details.0yAIXXq8.png)

2. 填写版本描述信息

![填写版本描述](https://www.codebuddy.cn/docs/static/fill-version-desc._FOw3HqW.png)

### 2）提交发布

1. 点击「确认发布」提交审核

![确认发布版本](https://www.codebuddy.cn/docs/static/confirm-publish-version.nHnfEK4L.png)

2. 等待审核通过（通常会很快自动审批）

![审批通过](https://www.codebuddy.cn/docs/static/approval-passed.Cg9e4SLR.png)

## 七、开始使用

钉钉机器人支持两种使用方式：**群聊使用**和**单聊使用**。

### 1）在群聊中使用

如果您想在群里使用机器人：

**第一步**：创建或选择一个群聊

创建群聊时，请确保群的「归属组织」与创建机器人时的组织相同。

**第二步**：添加机器人到群聊

1. 点击群右上角的设置按钮

![群聊设置](https://www.codebuddy.cn/docs/static/group-settings.Dnq0n7SX.png)

2. 选择「机器人」

![机器人设置](https://www.codebuddy.cn/docs/static/robot-settings.DLLx4rNs.png)

3. 点击「添加机器人」

![添加机器人到群聊](https://www.codebuddy.cn/docs/static/add-robot-to-group.hm8ha6Sf.png)

4. 搜索并选择您创建的机器人

![搜索机器人](https://www.codebuddy.cn/docs/static/search-robot-group.LpBU0LAt.png)

5. 确认添加

![确认添加机器人](https://www.codebuddy.cn/docs/static/confirm-add-robot.C3aLkqs-.png)

**第三步**：开始使用

在群里 @机器人 并发送您的需求，WorkBuddy 会自动执行任务并回复结果。

![群聊使用效果](https://www.codebuddy.cn/docs/static/chat-usage.BdwPRh3l.png)

### 2）单聊使用

如果您想直接与机器人私聊：

1. 在钉钉顶部搜索框中，搜索机器人的名称

![搜索机器人私聊](https://www.codebuddy.cn/docs/static/search-robot-private.DzOR9AIx.png)

2. 点击机器人进入对话窗口，直接发送消息即可

![单聊使用效果](https://www.codebuddy.cn/docs/static/chat-usage.BdwPRh3l.png)

> **恭喜**
>
> 您已成功将 WorkBuddy 接入钉钉！现在可以通过钉钉随时随地远程控制 WorkBuddy 完成各种编程任务了。

## 八、常见问题

### 1）机器人没有响应怎么办？

请按以下步骤排查：

1. **检查应用状态**：确认应用已发布并通过审批
2. **检查 Webhook 配置**：确认地址正确，且使用的是 `https` 协议
3. **检查 WorkBuddy**：确保电脑上的 WorkBuddy 正在运行，且 **助理** 已开启
4. **检查权限**：确认三个权限都已正确开通

### 2）在群里找不到机器人怎么办？

1. 确认机器人应用已发布
2. 确认群聊的「归属组织」与机器人所属组织相同
3. 尝试重启钉钉客户端
