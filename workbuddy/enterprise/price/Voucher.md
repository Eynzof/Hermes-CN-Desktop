> 来源：[CodeBuddy 官方文档](https://www.codebuddy.cn/docs/enterprise/price/Voucher)

# 代金券

代金券是可抵扣积分购买费用的优惠券，您可以登录 [腾讯云控制台](https://console.cloud.tencent.com/?Is=sdk-topnav)，在**费用中心 - 优惠管理 - 代金券**页面中可查看账户下的代金券情况。

## 如何查看

1. 登录 [腾讯云控制台](https://console.cloud.tencent.com/?Is=sdk-topnav)，选择顶部的 **费用-费用中心**

![费用中心](https://www.codebuddy.cn/docs/static/ctrol-voucher-1.CR7gaXkx.png)

2. 在费用中心页面，选择**优惠管理**，点击**代金券**即可查看账户的代金券列表

![代金券](https://www.codebuddy.cn/docs/static/ctrol-voucher-2.CFm5dk99.png)

> **注意**
>
> 以上页面仅支持**查看**，不支持从**详情**入口进入购买页使用代金券。请从相应的[企业管理后台](https://www.codebuddy.cn/admin/overview)进入购买页使用代金券。

## 使用步骤

在新购、手动续费、变更企业套餐或购买积分加量包时，可在付款页面自主选用代金券。

1. 进入[企业管理后台](https://www.codebuddy.cn/admin/overview)的**组织概览页面**

![购买加量包](https://www.codebuddy.cn/docs/static/voucher-1.DsxEJ2hZ.png)

2. 点击**购买加量包**跳转至购买页，选择产品规格后点击**立即购买**

![购买页](https://www.codebuddy.cn/docs/static/voucher-2.DU8wcKKZ.png)

3. 在跳转页核对信息，页面底部的**选择优惠券**板块展示了账户内可用的代金券，勾选对应代金券后**去支付**即可使用。

![选择优惠券](https://www.codebuddy.cn/docs/static/voucher-3.Bg7JhSbw.png)

## 自动用券开关

可对单张优惠券设置自动用券开关，自动用券包括自动续费、后付费结算等。您可在 [腾讯云控制台](https://console.cloud.tencent.com/?Is=sdk-topnav)的**费用中心 - 优惠管理 - 代金券**中看到自动用券开关。

该开关默认为打开状态，即默认支持自动用券。如需屏蔽自动用券场景，请手动单击关闭，并在弹窗中确认即可关闭；如需恢复自动用券再次单击开启即可。

![自动用券](https://www.codebuddy.cn/docs/static/voucher-4.Be52aiWy.png)

## 使用限制

- **根据订单信息匹配代金券：** 系统会根据订单对应的产品、计费方式、订单金额、购买时长等限制条件匹配可用代金券，只有所有限制条件和订单信息都符合，且状态为待使用的代金券才可用于支付该订单。
- **自动续费时代金券优先抵扣：** 设置了自动续费后，自动续费时优先使用适用代金券抵扣费用，再使用账户余额进行扣费。
- **一次支付只能使用一张代金券：** 支付订单时如果有多张代金券可用，可单击选择框自主选择使用某张代金券，或取消勾选使用代金券选项不用代金券。
- **多个订单合并使用代金券：** 可在**订单管理页**选择多个订单，点击**合并付款**后使用代金券。
- **不支持退还：** 购买时使用的代金券在退款时**不支持退还**。
