> 来源：[CodeBuddy 官方文档](https://www.codebuddy.cn/docs/enterprise/adminguide/%E5%AE%89%E5%85%A8%E7%AE%A1%E7%90%86/IP%20%E7%99%BD%E5%90%8D%E5%8D%95)

# IP 白名单

腾讯云代码助手提供了企业 IP 白名单配置功能，使企业能够通过 IP 限制插件的使用范围。

> **说明：**

> 适用版本：旗舰版、专享版、企业版。

在 [企业设置](https://copilot.tencent.com/admin) > **网络设置**菜单当中，配置企业的 IP 白名单，IP 白名单作用于代码助手插件，被限制的 IP 将无法登录插件并使用。

![](https://write-document-release-1258344699.cos.ap-guangzhou.tencentcos.cn/100039847436/28f10aae113511f0aaa3525400e889b2.png)

IP 限制的生效规则如下：

- 多个 IP 用英文逗号隔开，逗号前后不加空格。
- 仅设置127.0.0.1代表禁止所有 IP 访问。
- 不填写则代表允许所有 IP 访问。
- 设置 IP 段例如10.10.10.0/24代表允许该网段访问。
