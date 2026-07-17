import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { CircleOff, Compass, ExternalLink, Globe2, HardDrive, Palette } from "lucide-react";
import { Button } from "@hermes/shared-ui";
import { openExternalUrl } from "@/lib/external-links";
import { ThemeSection } from "./settings";
import { ConnectionSection } from "./settings-connection-section";
import { ManagedRuntimePanel } from "./managed-runtime-panel";
import s from "./offline-shell.module.css";

function OfflinePage({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <section className={s.page}>
      <header><p>Hermes Desktop · Offline Shell</p><h1>{title}</h1><span>{sub}</span></header>
      <div className={s.body}>{children}</div>
    </section>
  );
}

function OfflineHome() {
  return (
    <OfflinePage title="当前没有正在使用的 Hermes 后端" sub="内置内核已停止或卸载。你仍然可以连接外部 Hermes，或恢复内置内核。">
      <div className={s.empty}>
        <CircleOff size={32} />
        <h2>工作台暂时离线</h2>
        <p>会话、模型、Skills、MCP 等页面需要后端。连接成功后重新加载即可恢复。</p>
        <div><Button variant="solid" tone="accent" onClick={() => { window.location.hash = "#/guide"; }}><Compass size={13} />继续使用引导</Button></div>
      </div>
    </OfflinePage>
  );
}

function OfflineAbout() {
  return (
    <OfflinePage title="关于与帮助" sub="离线时也可以访问社区和使用文档。">
      <div className={s.cards}>
        <article><Globe2 size={20} /><h2>中文社区官网</h2><p>查看最新文档、安装说明和社区联系方式。</p><Button variant="outline" onClick={() => void openExternalUrl("https://hermesagent.org.cn")}><ExternalLink size={13} />打开官网</Button></article>
        <article><Compass size={20} /><h2>重新选择开始方式</h2><p>选择开箱即用，或连接你已经部署好的 Hermes。</p><Button variant="outline" onClick={() => { window.location.hash = "#/guide"; }}>打开引导</Button></article>
      </div>
    </OfflinePage>
  );
}

export function OfflineShell() {
  const { pathname } = useLocation();
  return (
    <div className={s.shell}>
      <aside>
        <div className={s.brand}><span>H</span><div><strong>Hermes Agent</strong><small>离线控制台</small></div></div>
        <nav>
          <Link data-active={pathname === "/" ? "true" : undefined} to="/"><CircleOff size={15} />离线状态</Link>
          <Link data-active={pathname === "/connection" ? "true" : undefined} to="/connection"><Globe2 size={15} />连接</Link>
          <Link data-active={pathname === "/kernel" ? "true" : undefined} to="/kernel"><HardDrive size={15} />内核</Link>
          <Link data-active={pathname === "/theme" ? "true" : undefined} to="/theme"><Palette size={15} />主题</Link>
          <Link data-active={pathname === "/about" ? "true" : undefined} to="/about"><Compass size={15} />关于</Link>
        </nav>
      </aside>
      <main>
        <Routes>
          <Route path="/" element={<OfflineHome />} />
          <Route path="/connection" element={<OfflinePage title="连接外部 Hermes" sub="选择本机其他 Hermes 或远端服务器。"><ConnectionSection showHeading={false} /></OfflinePage>} />
          <Route path="/kernel" element={<OfflinePage title="内置内核" sub="安装、启动、卸载或重装内置内核。"><ManagedRuntimePanel /></OfflinePage>} />
          <Route path="/theme" element={<OfflinePage title="主题" sub="调整桌面界面的外观。"><ThemeSection showHeading={false} /></OfflinePage>} />
          <Route path="/about" element={<OfflineAbout />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
