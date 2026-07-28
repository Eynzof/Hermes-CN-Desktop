# 主题配置持久化方案

## 问题

"切换到 xx 模式"（主题切换）界面代码位于 `web/src/components/app-shell/app-top-bar.tsx` 第 44 行。点击切换后，配置只在内存中生效，**页面刷新后 fallback 回默认主题**。

## 根因分析

### 写入链路（当前）

```
app-top-bar.tsx:107  onClick → updateTheme({ theme: nextTheme })
  → themeWriteAtom (packages/shared-ui/src/hooks/use-theme.ts:80)
    → __HERMES_UI_STORE__.set("hermes-theme", next)
      → writeUiValue("hermes-theme", value) (web/src/lib/ui-store.ts:102)
        → kvCache[key] = value                        # 内存缓存 ✅
        → bridge()?.uiStoreSetKv?.({key, value})       # 原生桥接
          [Tauri 桌面模式] → Rust ui_store_set_kv → SQLite 写入 ✅
          [Web 开发模式]   → bridge() 返回 undefined  → **静默丢弃** ❌
```

### 读取链路（当前）

```
main.tsx:43  initUiStore()
  → bridge()?.uiStoreSnapshot?.()
    [Tauri] → Rust ui_store_snapshot → SQLite 读取 → kvCache 填充 ✅
    [Web]   → bridge() 返回 undefined → kvCache = {} ❌
main.tsx:45  readUiValue("hermes-theme", DEFAULT_THEME_CONFIG)
  → kvCache 为空 → 返回 DEFAULT_THEME_CONFIG（light-modern）
  → 每次刷新都 fallback
```

### 结论

- Tauri 桌面模式下，主题通过 SQLite 文件 `{HERMES_HOME}/desktop-ui.sqlite` 正常持久化。
- Web 开发模式下，`window.hermesDesktop` 桥接不存在，所有写入被静默丢弃，读取永远返回默认值。
- **整个代码库没有任何 localStorage 或其他回退机制。**

## 修改方案

**只需修改一个文件**：`web/src/lib/ui-store.ts`，增加约 20 行代码。

### 原理

当原生桥接不可用时（`bridge()` 返回 `undefined`，即 Web 模式），将整个 `kvCache` 序列化到 `localStorage` 作为备份存储。

### 修改 1：`writeUiValue` — 写入时同步到 localStorage

```typescript
const UI_STORE_BACKUP_KEY = 'hermes_ui_backup';

export function writeUiValue(key: string, value: unknown): void {
  kvCache[key] = clone(value);
  notify();
  void bridge()?.uiStoreSetKv?.({ key, value }).catch(() => {});
  // localStorage fallback for web mode (no native bridge)
  if (!bridge()) {
    try {
      localStorage.setItem(UI_STORE_BACKUP_KEY, JSON.stringify(kvCache));
    } catch {
      // localStorage full or unavailable — silently skip
    }
  }
}
```

### 修改 2：`initUiStore` — 加载时从 localStorage 恢复

```typescript
export async function initUiStore(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const snapshot = await bridge()?.uiStoreSnapshot?.();
      kvCache = snapshot?.kv ?? {};

      // Web mode: native bridge unavailable, load from localStorage backup
      if (!bridge() && Object.keys(kvCache).length === 0) {
        try {
          const backup = localStorage.getItem(UI_STORE_BACKUP_KEY);
          if (backup) {
            const parsed = JSON.parse(backup);
            if (typeof parsed === 'object' && parsed !== null) {
              kvCache = parsed;
            }
          }
        } catch {
          // Corrupted or missing backup — ignore
        }
      }
    } catch {
      kvCache = {};
    } finally {
      initialized = true;
      installGlobalUiStoreBridge();
      notify();
    }
  })();
  return initPromise;
}
```

### 修改 3：`removeUiValue` — 同步清理 localStorage

```typescript
export function removeUiValue(key: string): void {
  delete kvCache[key];
  notify();
  void bridge()?.uiStoreRemoveKv?.({ key }).catch(() => {});
  if (!bridge()) {
    try {
      localStorage.setItem(UI_STORE_BACKUP_KEY, JSON.stringify(kvCache));
    } catch {}
  }
}
```

## 影响范围

| 场景 | 改动前 | 改动后 |
|------|--------|--------|
| **Tauri 桌面模式** | SQLite 持久化 ✅ | 不变 ✅ |
| **Web 开发模式**（`pnpm dev`） | 刷新回默认 ❌ | localStorage 持久化 ✅ |
| **Tauri + 首次启动**（无历史数据） | SQLite 空 → 默认值 ✅ | 不变 ✅ |
| **所有 UI 设置**（主题/密度/缩放等） | 仅主题受影响 | 全部受益 |

## 无需修改的文件

- `packages/shared-ui/src/hooks/use-theme.ts` — 已经正确调用 `__HERMES_UI_STORE__` 的读写接口
- `web/src/main.tsx` — 已经正确调用 `initUiStore()` + `readUiValue()`
- `web/src/components/app-shell/app-top-bar.tsx` — 已经正确调用 `useTheme().update()`
- Rust 后端（`src/ui_store.rs`、`src/commands/ui_store.rs`）— 桌面端逻辑不变
