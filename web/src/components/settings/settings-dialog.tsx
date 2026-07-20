import { useState, type ReactNode } from "react";
import { useAtom } from "jotai";
import { Dialog } from "@hermes/shared-ui";
import {
  BarChart3,
  Bot,
  Database,
  HelpCircle,
  Keyboard,
  Lightbulb,
  Package,
  Palette,
  Puzzle,
  Settings,
  ShieldCheck,
  Smartphone,
  User,
  X,
} from "lucide-react";
import {
  settingsDialogOpenAtom,
  settingsDialogPaneAtom,
  type SettingsPane,
} from "@/stores/settings-dialog";
import {
  AboutSection,
  ApprovalModeSection,
  ConfigSection,
  GeneralSection,
  KernelSection,
  NotificationSection,
  ThemeSection,
} from "@/routes/settings";
import { EnvironmentSection } from "@/routes/environment";
import { ConnectionSection } from "@/routes/settings-connection-section";
import { CodingAgentsSection } from "@/routes/settings-coding-agents";
import { ModelsSection } from "@/routes/settings-models-section";
import { SoulRoute } from "@/routes/soul";
import { VoiceRoute } from "@/routes/voice";
import { MemoryRoute } from "@/routes/memory";
import { BackupRoute } from "@/routes/backup";
import { ConfigMigrationRoute } from "@/routes/config-migration";
import { AnalyticsRoute } from "@/routes/analytics";
import { LogsRoute } from "@/routes/logs";
import { DebugRoute } from "@/routes/debug";
import { ConsoleRoute } from "@/routes/console";
import { ProfilesRoute } from "@/routes/profiles";
import { DingtalkRoute, FeishuRoute, WeixinRoute } from "@/routes/im-onboarding";
import { HealthGrid } from "@/components/panel/health-grid";
import s from "./settings-dialog.module.css";

interface NavDef {
  pane: SettingsPane;
  label: string;
  icon: typeof Settings;
}

const NAV: readonly NavDef[] = [
  { pane: "account", label: "账户管理", icon: User },
  { pane: "system", label: "系统设置", icon: Settings },
  { pane: "agent", label: "智能体设置", icon: Bot },
  { pane: "shortcuts", label: "快捷键", icon: Keyboard },
  { pane: "memory", label: "记忆", icon: Lightbulb },
  { pane: "model", label: "模型", icon: Package },
  { pane: "assistant", label: "助理设置", icon: Smartphone },
  { pane: "personal", label: "个性化", icon: Palette },
  { pane: "data", label: "数据管理", icon: Database },
  { pane: "security", label: "安全中心", icon: ShieldCheck },
  { pane: "advanced", label: "高级", icon: Puzzle },
  { pane: "observe", label: "可观测", icon: BarChart3 },
  { pane: "help", label: "帮助与反馈", icon: HelpCircle },
];

/** 使用弹窗自带标题（浅色 Section 直嵌）的面板；其余面板内嵌完整页面（自带标题栏）。 */
const PANE_HEAD: Partial<Record<SettingsPane, { title: string; desc: string }>> = {
  system: { title: "系统设置", desc: "显示、通知与任务运行的基础配置" },
  shortcuts: { title: "快捷键", desc: "全局与页面快捷键" },
  personal: { title: "个性化", desc: "外观与对话显示偏好" },
  security: { title: "安全中心", desc: "审批模式与高风险操作确认规则" },
  help: { title: "帮助与反馈", desc: "版本、更新与支持" },
};

interface EmbedTab {
  key: string;
  label: string;
  /** route = 完整页面（SectionShell，自带标题与内部滚动）；section = 内容块（外层提供滚动） */
  kind: "route" | "section";
  node: ReactNode;
}

function EmbedTabs({ tabs }: { tabs: readonly EmbedTab[] }) {
  const [active, setActive] = useState(tabs[0].key);
  const current = tabs.find((tab) => tab.key === active) ?? tabs[0];
  return (
    <div className={s.embedHost}>
      <div className={s.subTabs} role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active === tab.key}
            className={s.subTab}
            data-active={active === tab.key ? "true" : undefined}
            onClick={() => setActive(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {current.kind === "route" ? (
        <div className={s.embedRoute}>{current.node}</div>
      ) : (
        <div className={s.embedScroll}>{current.node}</div>
      )}
    </div>
  );
}

function EmbedSingle({ tab }: { tab: EmbedTab }) {
  return (
    <div className={s.embedHost}>
      {tab.kind === "route" ? (
        <div className={s.embedRoute}>{tab.node}</div>
      ) : (
        <div className={s.embedScroll}>{tab.node}</div>
      )}
    </div>
  );
}

function ShortcutsPane() {
  const rows: Array<[string, string]> = [
    ["命令面板", "Ctrl / ⌘ + K"],
    ["结果面板开关（任务页）", "Ctrl / ⌘ + B"],
    ["发送消息", "Enter（可在系统设置改为 Ctrl+Enter）"],
    ["中断当前任务", "Esc"],
    ["开发者工具", "F12"],
  ];
  return (
    <div>
      {rows.map(([title, keys]) => (
        <div className={s.setRow} key={title}>
          <div className={s.rowLabel}>
            <div className={s.rowTitle}>{title}</div>
          </div>
          <span className={s.kbdValue}>{keys}</span>
        </div>
      ))}
    </div>
  );
}

/** 内嵌完整页面的面板（key 变化时强制重挂载，切换面板即重置子标签与页面状态）。 */
function EmbeddedPane({ pane }: { pane: SettingsPane }) {
  switch (pane) {
    case "account":
      return <EmbedSingle tab={{ key: "profiles", label: "档案", kind: "route", node: <ProfilesRoute /> }} />;
    case "agent":
      return (
        <EmbedTabs
          key={pane}
          tabs={[
            { key: "soul", label: "人格", kind: "route", node: <SoulRoute /> },
            { key: "coding-agents", label: "编程 Agent", kind: "section", node: <CodingAgentsSection showHeading={false} /> },
            { key: "voice", label: "语音", kind: "route", node: <VoiceRoute /> },
          ]}
        />
      );
    case "memory":
      return <EmbedSingle tab={{ key: "memory", label: "记忆", kind: "route", node: <MemoryRoute /> }} />;
    case "model":
      return <EmbedSingle tab={{ key: "model", label: "模型", kind: "section", node: <ModelsSection /> }} />;
    case "assistant":
      return (
        <EmbedTabs
          key={pane}
          tabs={[
            { key: "feishu", label: "飞书", kind: "route", node: <FeishuRoute /> },
            { key: "weixin", label: "微信", kind: "route", node: <WeixinRoute /> },
            { key: "dingtalk", label: "钉钉", kind: "route", node: <DingtalkRoute /> },
          ]}
        />
      );
    case "data":
      return (
        <EmbedTabs
          key={pane}
          tabs={[
            { key: "backup", label: "备份恢复", kind: "route", node: <BackupRoute /> },
            { key: "config-migration", label: "配置迁移", kind: "route", node: <ConfigMigrationRoute /> },
          ]}
        />
      );
    case "advanced":
      return (
        <EmbedTabs
          key={pane}
          tabs={[
            { key: "kernel", label: "内核 Runtime", kind: "section", node: <KernelSection showHeading={false} /> },
            { key: "env", label: "环境", kind: "section", node: <EnvironmentSection showHeading={false} /> },
            { key: "config", label: "配置编辑", kind: "section", node: <ConfigSection showHeading={false} /> },
            { key: "connection", label: "连接", kind: "section", node: <ConnectionSection showHeading={false} /> },
            { key: "console", label: "终端", kind: "route", node: <ConsoleRoute /> },
          ]}
        />
      );
    case "observe":
      return (
        <EmbedTabs
          key={pane}
          tabs={[
            { key: "health", label: "健康", kind: "section", node: <HealthGrid variant="page" /> },
            { key: "analytics", label: "用量分析", kind: "route", node: <AnalyticsRoute /> },
            { key: "logs", label: "日志", kind: "route", node: <LogsRoute /> },
            { key: "debug", label: "调试事件", kind: "route", node: <DebugRoute /> },
          ]}
        />
      );
    default:
      return null;
  }
}

/** 弹窗自带标题的浅色面板。 */
function LightPane({ pane }: { pane: SettingsPane }) {
  switch (pane) {
    case "system":
      return (
        <div>
          <GeneralSection showHeading={false} />
          <NotificationSection showHeading={false} />
        </div>
      );
    case "shortcuts":
      return <ShortcutsPane />;
    case "personal":
      return <ThemeSection showHeading={false} />;
    case "security":
      return <ApprovalModeSection />;
    case "help":
      return <AboutSection showHeading={false} />;
    default:
      return null;
  }
}

export function SettingsDialog() {
  const [open, setOpen] = useAtom(settingsDialogOpenAtom);
  const [pane, setPane] = useAtom(settingsDialogPaneAtom);
  const head = PANE_HEAD[pane];

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className={s.dialog} aria-describedby={undefined}>
          <Dialog.Title asChild>
            <span className={s.srOnly}>设置</span>
          </Dialog.Title>
          <button
            type="button"
            className={s.close}
            aria-label="关闭设置"
            onClick={() => setOpen(false)}
          >
            <X size={16} />
          </button>
          <nav className={s.nav} aria-label="设置分区">
            {NAV.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.pane}
                  type="button"
                  className={s.navItem}
                  data-active={pane === item.pane ? "true" : undefined}
                  onClick={() => setPane(item.pane)}
                >
                  <Icon size={14} className={s.navIcon} />
                  {item.label}
                </button>
              );
            })}
          </nav>
          {head ? (
            <div className={s.pane}>
              <h3 className={s.paneTitle}>{head.title}</h3>
              <div className={s.paneDesc}>{head.desc}</div>
              <LightPane pane={pane} />
            </div>
          ) : (
            <div className={s.paneEmbed}>
              <EmbeddedPane pane={pane} />
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
