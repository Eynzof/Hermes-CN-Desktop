import { describe, it, expect } from "vitest";
import { TelegramAdapter, telegramConfigSchema } from "./telegram/adapter.js";
import { DiscordAdapter, discordConfigSchema } from "./discord/adapter.js";
import { SlackAdapter, slackConfigSchema } from "./slack/adapter.js";
import { WhatsAppAdapter, whatsAppConfigSchema } from "./whatsapp/adapter.js";
import { SignalAdapter, signalConfigSchema } from "./signal/adapter.js";
import { SmsTwilioAdapter, smsTwilioConfigSchema } from "./sms-twilio/adapter.js";
import { EmailAdapter, emailConfigSchema } from "./email/adapter.js";
import { MatrixAdapter, matrixConfigSchema } from "./matrix/adapter.js";
import { MattermostAdapter, mattermostConfigSchema } from "./mattermost/adapter.js";
import { IrcAdapter, ircConfigSchema } from "./irc/adapter.js";
import { LineAdapter, lineConfigSchema } from "./line/adapter.js";
import { DingTalkAdapter, dingTalkConfigSchema } from "./dingtalk/adapter.js";
import { FeishuLarkAdapter, feishuLarkConfigSchema } from "./feishu-lark/adapter.js";
import { WeComAdapter, weComConfigSchema } from "./wecom/adapter.js";
import { WeixinAdapter, weixinConfigSchema } from "./weixin/adapter.js";
import { QqbotAdapter, qqbotConfigSchema } from "./qqbot/adapter.js";
import { YuanbaoAdapter, yuanbaoConfigSchema } from "./yuanbao/adapter.js";
import { TeamsAdapter, teamsConfigSchema } from "./teams/adapter.js";
import { BluebubblesAdapter, bluebubblesConfigSchema } from "./bluebubbles/adapter.js";
import { PhotonAdapter, photonConfigSchema } from "./photon/adapter.js";
import { NtfyAdapter, ntfyConfigSchema } from "./ntfy/adapter.js";
import { RaftAdapter, raftConfigSchema } from "./raft/adapter.js";
import { SimplexAdapter, simplexConfigSchema } from "./simplex/adapter.js";
import { GoogleChatAdapter, googleChatConfigSchema } from "./google-chat/adapter.js";
import { HomeassistantMessagingAdapter, homeassistantMessagingConfigSchema } from "./homeassistant-messaging/adapter.js";
import { WebhooksAdapter, webhooksConfigSchema } from "./webhooks/adapter.js";
import { HermesRelayAdapter, hermesRelayConfigSchema } from "./hermes-relay/adapter.js";
import { BuzzNostrAdapter, buzzNostrConfigSchema } from "./buzz-nostr/adapter.js";
import { MsgraphWebhookAdapter, msgraphWebhookConfigSchema } from "./msgraph-webhook/adapter.js";

describe("platform adapter registry", () => {
  it("all platforms expose distinct ids", () => {
    const ids = [
      new TelegramAdapter(telegramConfigSchema.parse({})).platform,
      new DiscordAdapter(discordConfigSchema.parse({})).platform,
      new SlackAdapter(slackConfigSchema.parse({})).platform,
      new WhatsAppAdapter(whatsAppConfigSchema.parse({})).platform,
      new SignalAdapter(signalConfigSchema.parse({})).platform,
      new SmsTwilioAdapter(smsTwilioConfigSchema.parse({})).platform,
      new EmailAdapter(emailConfigSchema.parse({})).platform,
      new MatrixAdapter(matrixConfigSchema.parse({})).platform,
      new MattermostAdapter(mattermostConfigSchema.parse({})).platform,
      new IrcAdapter(ircConfigSchema.parse({})).platform,
      new LineAdapter(lineConfigSchema.parse({})).platform,
      new DingTalkAdapter(dingTalkConfigSchema.parse({})).platform,
      new FeishuLarkAdapter(feishuLarkConfigSchema.parse({})).platform,
      new WeComAdapter(weComConfigSchema.parse({})).platform,
      new WeixinAdapter(weixinConfigSchema.parse({})).platform,
      new QqbotAdapter(qqbotConfigSchema.parse({})).platform,
      new YuanbaoAdapter(yuanbaoConfigSchema.parse({})).platform,
      new TeamsAdapter(teamsConfigSchema.parse({})).platform,
      new BluebubblesAdapter(bluebubblesConfigSchema.parse({})).platform,
      new PhotonAdapter(photonConfigSchema.parse({})).platform,
      new NtfyAdapter(ntfyConfigSchema.parse({})).platform,
      new RaftAdapter(raftConfigSchema.parse({})).platform,
      new SimplexAdapter(simplexConfigSchema.parse({})).platform,
      new GoogleChatAdapter(googleChatConfigSchema.parse({})).platform,
      new HomeassistantMessagingAdapter(homeassistantMessagingConfigSchema.parse({})).platform,
      new WebhooksAdapter(webhooksConfigSchema.parse({})).platform,
      new HermesRelayAdapter(hermesRelayConfigSchema.parse({})).platform,
      new BuzzNostrAdapter(buzzNostrConfigSchema.parse({})).platform,
      new MsgraphWebhookAdapter(msgraphWebhookConfigSchema.parse({})).platform,
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
