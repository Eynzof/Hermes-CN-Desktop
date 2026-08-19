# Plan: Merge WanderMemory Web Frontend into Hermes-CN-Desktop Frontend

## 1. Goal & Scope

**Objective:** Integrate the UI capabilities of `C:\dev\Wander-Memory\web\app` (the "Memory Web" React SPA for MemOS-backed memory service) into the existing Hermes Agent CN Desktop frontend at `C:\dev\Hermes-CN-Desktop\web`, so that WanderMemory's memory-management, chat-with-memory, context preview, dialogue import, file-system ingest, and status/diagnostic views become part of the Hermes Desktop experience.

**Chosen approach:** Full visual and architectural rewrite into the Hermes design system — CSS Modules, `@hermes/shared-ui` tokens, TanStack Query + Jotai, and Hermes transport/hooks. The merged code lives under `/wander-memory/*` routes inside the existing App Shell.

**Non-goal:** This plan assumes the frontend is merged; it does **not** automatically port the MemOS Python backend. Backend mapping decisions are explicitly called out in Phase 0.

## 2. Current-State Snapshot

| Area | Hermes-CN-Desktop `web/` | `C:\dev\Wander-Memory\web\app` |
|------|--------------------------|--------------------------|
| **Build tool** | Vite 6 (`web/vite.config.ts`) | Vite 7 (`vite.config.ts`) |
| **React version** | 19.1 | 19.2 (compatible) |
| **Router** | `react-router-dom` 7.6 (Browser/Hash) | `react-router-dom` 7.18 (Hash) |
| **Styling** | CSS Modules only; **no Tailwind**; design tokens in `packages/shared-ui/src/tokens/` | Tailwind CSS 3 + custom `index.css`; dark gradient/shadow-heavy UI |
| **State** | TanStack Query + Jotai | Custom `AppProvider` + `useApp` context + local `useState` |
| **HTTP transport** | `web/src/lib/transport.ts` (auth header injection, native IPC vs fetch) | Plain `fetch` in `api/rest.ts` / `api/fs_client.ts` |
| **WebSocket** | `gateway-client.ts` JSON-RPC over `/api/ws` via `use-gateway.ts` | Custom `MemoryWsClient` on `ws://127.0.0.1:18401/v1/ws` |
| **API contract** | Hermes Dashboard REST + Gateway RPC | MemOS REST `/v1/*` + custom WS `/v1/ws` |
| **Backend port** | 9120 (managed Hermes Dashboard) | 18400 REST / 18401 WS / 18402 FS — auto-shift when occupied (Appendix L) |
| **Tests** | Vitest 4 + React Testing Library + Playwright E2E | Vitest 3 + Playwright E2E |

**Critical conflict:** Hermes global CSS (`web/src/styles/global.css`) explicitly strips gradients, shadows, and background images from `#root` descendants and forbids Tailwind. A literal copy-paste of WanderMemory's Tailwind JSX will visually break and violate project conventions. The only viable path is to rebuild the views with Hermes tokens and CSS Modules, scoping any aesthetic exceptions to the WanderMemory route subtree.

## 3. Backend Target Decision (Phase 0 Gate)

Before writing migration code, decide which backend the merged views will call:

1. **WanderMemory backend (MemOS) still on 18400/18401/18402 (auto-shift)**
   - Front-end is merged into Hermes shell but keeps calling MemOS endpoints.
   - Requires Hermes transport to proxy/route to `127.0.0.1:18400` (dev) or to a configurable host (prod).
   - **Ports are not hard-coded anymore:** if 18400/18401/18402 are taken by another process, the backend shifts to the next free ports and the frontend discovers the bound ports (design in Appendix L).
   - Easiest for feature parity but means Hermes Desktop now depends on a second local service.

2. **Hermes-CN-Core backend (port 9120)**
   - Map WanderMemory operations to equivalent Hermes APIs (memory add/search/delete, dialogue/context/chat).
   - Likely requires new backend endpoints or RPC methods in `C:/dev/Hermes-CN-Core`.
   - Per AGENTS.md, cross-repo changes must use git worktrees and follow the dual-repo dev flow.

3. **Hybrid / adapter (recommended for safety)**
   - Build an abstract `WanderMemoryClient` interface in `web/src/lib/wander-memory/`.
   - Implement a MemOS transport adapter first (delivers feature parity quickly).
   - Later add a Hermes-native adapter that maps to existing/new Hermes endpoints without touching views.

**Decision required from product/tech lead before Phase 1.** Default implementation path below assumes Option 3 with the MemOS adapter first.

## 4. Deep Research Findings

### 4.1 Hermes Transport Layer

`web/src/lib/transport.ts` provides the single source of truth for HTTP:
- Injects `Authorization: Bearer <token>` and `X-Hermes-Session-Token` from `runtime.getSessionToken()`.
- Adds `X-Hermes-Profile` when the active profile is not `default`.
- Routes desktop builds through native IPC (`window.hermesDesktop.request`) when `shouldUseNativeIpc(path)` returns true.
- `fetchJSON(path, init, parser)` resolves paths via `runtime.getApiUrl(path)` and is Hermes-backend-centric.
- `fetchExternalJSON(url, init, parser)` is intended for arbitrary external URLs and uses `window.hermesDesktop.externalRequest` on desktop.

**Implication:** MemOS endpoints must not be called with raw `fetch`. For dev/proxy mode, route `/v1/*` through Vite proxy and call `fetchJSON('/v1/health', ...)` so auth headers and IPC fallback are preserved. For direct MemOS mode, use `fetchExternalJSON(memosBase + '/v1/health', ...)` and ensure the URL is allow-listed by CSP.

### 4.2 Existing Memory Hooks (`use-memory.ts`)

Hermes already has a `/memory` route with hooks that mix two very different backends:
- Built-in memory entries use native bridge methods (`window.hermesDesktop.readMemory`, `addMemoryEntry`, etc.).
- External memory providers use `fetchJSON('/api/memory/...')` with Zod schemas from `@hermes/protocol`.

**Implication:** WanderMemory should be positioned as a third, distinct memory surface — an **external MemOS workbench** — rather than replacing or shoehorning into the existing `/memory` route. This avoids auth/model mismatches and keeps the native memory bridge untouched.

### 4.3 Shell & Navigation

- `AppShell` renders `AppTopBar`, `AppSidebar` (selected by `useActiveTopTab`), `ConnectionTargetNotice`, `AppStatusBar`.
- `AppSidebar` switches among `workbench`, `skills`, `gateway`, `externalMemory`, `advanced` today.
- `SectionShell` gives each route a `TopBar` + scrollable body + optional rail.

**Top-tab refactor (part of this plan):** split the single `记忆` top tab into two:
- **`Wander 记忆`** (new `wanderMemory` tab) — hosts everything ported in this plan: the MemOS Workbench at `/wander-memory/*` (memories / files / dialogue / chat / context / status / api).
- **`Hermes 记忆`** (renamed `hermesMemory` tab) — hosts the existing Hermes memory features: `/memory`, `/memconfig`, `/openviking`, `/hindsight` (today all under the old `记忆`/`externalMemory` tab).
- The old `记忆` tab (id `externalMemory`, label `记忆`) is removed; anything that pointed at it — `useActiveTopTab()` results, the `AppSidebar` switch, command-palette groups, tests — **redirects to `Hermes 记忆`**. Existing URLs are unchanged (`/memory` stays the `Hermes 记忆` landing route), so no deep links break; only labels/ids change.

**Implication:** WanderMemory gets its **own top-level tab**, not a sub-entry of the old memory group. Use `SectionShell` for each WanderMemory route so chrome, scrolling, and right-rail behavior match the rest of the app.

### 4.4 Shared-UI Primitives

`@hermes/shared-ui` exports:
- `Button`, `Input`, `LoadingState`, `Alert`, `Badge`, `Card`, `EmptyState`, `Field`, `PageTabs`
- `Dialog` and `Popover` composites
- Theme/platform hooks and `cn()` utility

**Implication:** Replace WanderMemory's hand-rolled `Spinner`, `JsonModal`, `ConfirmDialog`, and Tailwind buttons/inputs with these primitives where possible. This reduces CSS Modules boilerplate and guarantees focus/accessibility behavior.

### 4.5 WanderMemory Client Architecture

WanderMemory's client layer is already well-factored and mostly portable:
- `api/types.ts`: clean TypeScript interfaces; can be copied almost verbatim.
- `api/errors.ts`: `ApiError` class + `treatmentFor` mapping; portable, but should be wired into Hermes toast/notification system.
- `api/rest.ts`: `MemoryRestClient` with timeout/no-timeout rules and `ApiError` parsing; logic should be ported but built on Hermes transport.
- `api/ws.ts`: `MemoryWsClient` implements a custom op protocol over `ws://127.0.0.1:18401/v1/ws`; keep as an isolated client. Reuse Hermes `gateway-socket-path.ts` selection for native vs relay path.
- `api/demo.ts`: `DemoClient` simulates the full contract in-browser; valuable for tests and offline demos, should be ported.
- `api/context.tsx`: React context provider; replace with TanStack Query hooks + Jotai atoms.

### 4.6 Styling & Global CSS Constraints

Hermes `web/src/styles/global.css` applies:
```css
#root, #root *, #root *::before, #root *::after {
  background-image: none !important;
  box-shadow: none;
  text-shadow: none !important;
}
```
WanderMemory relies on `bg-gradient-to-b`, `shadow-2xl`, `backdrop-blur-md`, and `border-white/10`. These will be silently stripped unless scoped outside `#root` or explicitly reverted under a route-local attribute.

**Recommended visual strategy:**
- Default: render WanderMemory routes with Hermes tokens (light/dark themes already supported).
- Optional dark enclave: add `[data-wander-memory-theme="dark"]` on the route container and locally revert the global resets only inside that subtree, then define a dark carbon palette using existing `--ink-*` and `--bone-*` tokens plus an amber accent.
- Avoid re-introducing gradients and shadows unless product explicitly requires the original aesthetic.

## 5. Detailed Implementation Phases

### Phase 0: Inventory, Decision & Branch Setup

**Goal:** Lock scope and create isolated worktrees.

**Actions:**
1. Confirm both repos are synced with `origin/main` (`git fetch origin; git rev-list --left-right --count main...origin/main` should be `0 0`).
2. Create worktrees per AGENTS.md:
   ```bash
   git -C C:\dev\Hermes-CN-Desktop worktree add ..\wt\Hermes-CN-Desktop-wander-merge -b feat/wander-memory-merge origin/main
   git -C C:\dev\Wander-Memory worktree add ..\wt\WanderMemory-merge-source -b feat/wander-memory-merge origin/main   # if changes needed
   ```
3. Produce a side-by-side feature matrix:
   - WanderMemory views: Memories, Files, Dialogue, Chat, Context, Status, ApiDocs.
   - Hermes routes/features that overlap: `/memory`, `/external-memory`, chat composer, gateway chat.
4. Decide backend target (MemOS / Hermes / hybrid) and document in `docs/wander-memory-merge.md`.
5. Record visual direction: default Hermes tokens vs dark enclave.

**Files touched:**
- `C:\dev\Hermes-CN-Desktop\docs\wander-memory-merge.md` (new)
- Worktree directories (outside repo)

### Phase 1: Dependency & Build Setup

**Goal:** Add required dependencies without violating project constraints.

**Actions:**
1. Do **not** add Tailwind CSS, autoprefixer, or `geist` to Hermes `web/package.json`.
2. Hermes already has React 19, Vite 6, `react-router-dom` 7, Vitest, etc. Verify version alignment; downgrade WanderMemory Vite 7 references if any code relies on Vite 7-specific APIs (unlikely for a React SPA).
3. If reusing MemOS WebSocket directly, no extra dependency is needed (browser `WebSocket`).
4. Add a dedicated workspace entry only if extracting reusable WanderMemory protocol code into `packages/protocol` or `packages/shared-ui`.
5. Update `pnpm-workspace.yaml` only if a new package is introduced (not required for route-level merge).

**Files touched:**
- `C:\dev\Hermes-CN-Desktop\web\package.json` (review only, avoid new deps)
- `C:\dev\Hermes-CN-Desktop\pnpm-lock.yaml` (after any changes)

### Phase 2: API Transport & Client Abstraction

**Goal:** Create a Hermes-compatible client layer for WanderMemory/MemOS operations.

**Actions:**
1. Create `web/src/lib/wander-memory/` directory.
2. Port type definitions from `C:\dev\Wander-Memory\web\app\src\api\types.ts` to `web/src/lib/wander-memory/types.ts`.
3. Port error taxonomy from `C:\dev\Wander-Memory\web\app\src\api\errors.ts` to `web/src/lib/wander-memory/errors.ts`.
4. Implement transport adapters:
   - Define `WanderMemoryClient` interface matching the original `MemoryClient`.
   - `MemOsRestClient` uses Hermes `fetchJSON` / `fetchExternalJSON` instead of raw `fetch`.
   - `MemOsWsClient` reuses the frame logic from `api/ws.ts` but resolves the socket path through Hermes `gateway-socket-path.ts` selection, falling back to a Rust relay if needed.
   - `MemOsFileSystemClient` for `/v1/fs` endpoints.
   - `DemoWanderMemoryClient` ports `api/demo.ts` for offline/tests.
5. Endpoint resolution (`wander-memory/endpoints.ts`) replaces localStorage/config.js with Hermes `ui-store` persistence + env vars (`WANDER_MEMORY_API_ORIGIN`, `WANDER_MEMORY_WS_URL`, `WANDER_MEMORY_FS_ORIGIN`) + **port-shift discovery** (health probe / ports file — Appendix L.3).

**Key design point:** The client interface is backend-agnostic. A future Hermes-native adapter can implement the same interface without touching views.

**Files to create:**
- `C:\dev\Hermes-CN-Desktop\web\src\lib\wander-memory\types.ts`
- `C:\dev\Hermes-CN-Desktop\web\src\lib\wander-memory\errors.ts`
- `C:\dev\Hermes-CN-Desktop\web\src\lib\wander-memory\client.ts`
- `C:\dev\Hermes-CN-Desktop\web\src\lib\wander-memory\rest.ts`
- `C:\dev\Hermes-CN-Desktop\web\src\lib\wander-memory\ws.ts`
- `C:\dev\Hermes-CN-Desktop\web\src\lib\wander-memory\fs-client.ts`
- `C:\dev\Hermes-CN-Desktop\web\src\lib\wander-memory\endpoints.ts`
- `C:\dev\Hermes-CN-Desktop\web\src\lib\wander-memory\demo.ts`

**Files to read for reference:**
- `C:\dev\Wander-Memory\web\app\src\api\client.ts`
- `C:\dev\Wander-Memory\web\app\src\api\rest.ts`
- `C:\dev\Wander-Memory\web\app\src\api\ws.ts`
- `C:\dev\Wander-Memory\web\app\src\api\fs_client.ts`
- `C:\dev\Wander-Memory\web\app\src\api\demo.ts`
- `C:\dev\Wander-Memory\web\app\src\api\endpoints.ts` (port into `wander-memory/endpoints.ts`)
- `C:\dev\Wander-Memory\web\app\src\api\fs_endpoints.ts` (FS endpoint discovery, fold into `wander-memory/endpoints.ts`)
- `C:\dev\Wander-Memory\web\app\src\api\fs_types.ts` (FS types, fold into `wander-memory/types.ts`)
- `C:\dev\Hermes-CN-Desktop\web\src\lib\transport.ts`
- `C:\dev\Hermes-CN-Desktop\web\src\lib\gateway-client.ts`
- `C:\dev\Hermes-CN-Desktop\web\src\lib\gateway-socket-path.ts`

### Phase 3: TanStack Query Hooks

**Goal:** Replace WanderMemory's `AppProvider` + `useApp` context with Hermes server-state hooks.

**Actions:**
1. Create `web/src/hooks/use-wander-memory.ts` exposing:
   - `useWanderMemoryHealth()`
   - `useWanderMemoryList()`
   - `useWanderMemorySearch(query, topK)`
   - `useWanderMemoryAdd()` mutation
   - `useWanderMemoryDelete()` mutation
   - `useWanderMemoryDialogue()` mutation
   - `useWanderMemoryContext()` mutation
   - `useWanderMemoryChat()` mutation / streaming hook
   - `useWanderMemoryMaintenance()`
   - `useWanderMemoryModels()` / `useWanderMemoryBackends()`
2. For streaming chat, use a Jotai atom (`stores/wander-memory-chat.ts`) to hold partial deltas, driven by the WS client callback.
3. Reproduce the staleness-guard pattern (request epoch) inside mutations so an add/delete invalidates in-flight list/search results.
4. Wire `ApiError` into Hermes toast system via existing `notifications.ts` or `useToast` helper.

**Files to create:**
- `C:\dev\Hermes-CN-Desktop\web\src\hooks\use-wander-memory.ts`
- `C:\dev\Hermes-CN-Desktop\web\src\stores\wander-memory-chat.ts`

**Files to read for reference:**
- `C:\dev\Hermes-CN-Desktop\web\src\hooks\use-memory.ts`
- `C:\dev\Hermes-CN-Desktop\web\src\stores\chat.ts`
- `C:\dev\Hermes-CN-Desktop\web\src\lib\query-client.ts`
- `C:\dev\Hermes-CN-Desktop\web\src\lib\notifications.ts`

### Phase 4: Shared Component Extraction

**Goal:** Convert reusable WanderMemory UI pieces into Hermes-compliant components.

**Actions:**
1. Create `web/src/components/wander-memory/` directory.
2. Convert `components/shared.tsx` pieces:
   - `CollisionLine` → `wander-memory/collision-line.tsx` + `.module.css`
   - `MemoryCard` → `wander-memory/memory-card.tsx` + `.module.css`
   - `ErrorCard` → use Hermes `Alert` from `@hermes/shared-ui` or create `wander-memory/error-card.tsx`
   - `Spinner` → reuse Hermes `LoadingState`
   - `JsonModal` / `ConfirmDialog` → reuse Hermes `Dialog` composite
3. Convert `sections/AmberCascades.tsx` only if the digital-rain header is required. Scope it under `[data-wander-memory]` and use CSS Modules animations; do not rely on global background-image rules.
4. Build a route-level layout `wander-memory/layout.tsx` + `layout.module.css` that:
   - Wraps `SectionShell` or provides its own top bar.
   - Applies `[data-wander-memory]` attribute to the route container.
   - Locally reverts global `background-image` / `box-shadow` resets if the dark enclave aesthetic is required.

**Files to create:**
- `C:\dev\Hermes-CN-Desktop\web\src\components\wander-memory\memory-card.tsx`
- `C:\dev\Hermes-CN-Desktop\web\src\components\wander-memory\memory-card.module.css`
- `C:\dev\Hermes-CN-Desktop\web\src\components\wander-memory\collision-line.tsx`
- `C:\dev\Hermes-CN-Desktop\web\src\components\wander-memory\collision-line.module.css`
- `C:\dev\Hermes-CN-Desktop\web\src\components\wander-memory\error-card.tsx`
- `C:\dev\Hermes-CN-Desktop\web\src\components\wander-memory\error-card.module.css`
- `C:\dev\Hermes-CN-Desktop\web\src\components\wander-memory\layout.tsx`
- `C:\dev\Hermes-CN-Desktop\web\src\components\wander-memory\layout.module.css`

### Phase 5: Route-Level View Migration

**Goal:** Port each WanderMemory view to a Hermes route, using Hermes shell, hooks, and CSS Modules.

**Actions:**
1. Create `web/src/routes/wander-memory/` directory.
2. Create one route file per view:
   - `memories.tsx` (from `views/MemoriesView.tsx`)
   - `files.tsx` (from `views/FilesView.tsx`)
   - `dialogue.tsx` (from `views/DialogueView.tsx`)
   - `chat.tsx` (from `views/ChatView.tsx`)
   - `context.tsx` (from `views/ContextView.tsx`)
   - `status.tsx` (from `views/StatusView.tsx`)
   - `api-docs.tsx` (from `views/ApiDocsView.tsx`)
3. Each route:
   - Wraps with `WanderMemoryLayout` / `SectionShell` for consistent chrome.
   - Uses hooks from `use-wander-memory.ts` instead of `useApp`.
   - Replaces Tailwind classes with CSS Modules classes referencing Hermes tokens.
   - Preserves text-only rendering rule for dynamic memory text (no `dangerouslySetInnerHTML`).
   - Keeps keyboard handlers (Enter submit, Esc cancel) and accessibility attributes.

**Files to create:**
- `C:\dev\Hermes-CN-Desktop\web\src\routes\wander-memory\memories.tsx`
- `C:\dev\Hermes-CN-Desktop\web\src\routes\wander-memory\memories.module.css`
- `C:\dev\Hermes-CN-Desktop\web\src\routes\wander-memory\files.tsx`
- `C:\dev\Hermes-CN-Desktop\web\src\routes\wander-memory\files.module.css`
- `C:\dev\Hermes-CN-Desktop\web\src\routes\wander-memory\dialogue.tsx`
- `C:\dev\Hermes-CN-Desktop\web\src\routes\wander-memory\dialogue.module.css`
- `C:\dev\Hermes-CN-Desktop\web\src\routes\wander-memory\chat.tsx`
- `C:\dev\Hermes-CN-Desktop\web\src\routes\wander-memory\chat.module.css`
- `C:\dev\Hermes-CN-Desktop\web\src\routes\wander-memory\context.tsx`
- `C:\dev\Hermes-CN-Desktop\web\src\routes\wander-memory\context.module.css`
- `C:\dev\Hermes-CN-Desktop\web\src\routes\wander-memory\status.tsx`
- `C:\dev\Hermes-CN-Desktop\web\src\routes\wander-memory\status.module.css`
- `C:\dev\Hermes-CN-Desktop\web\src\routes\wander-memory\api-docs.tsx`
- `C:\dev\Hermes-CN-Desktop\web\src\routes\wander-memory\api-docs.module.css`

### Phase 6: Shell & Navigation Integration

**Goal:** Make WanderMemory discoverable inside the Hermes app as its own top-level **`Wander 记忆`** tab, with the old `记忆` tab renamed/redirected to **`Hermes 记忆`**.

**Actions:**
1. Register routes in `web/src/app.tsx` under `/wander-memory/*`:
   ```tsx
   <Route path="/wander-memory" element={withBoundary(<WanderMemoryLayout />)}>
     <Route index element={<Navigate to="memories" replace />} />
     <Route path="memories" element={<WanderMemoryMemoriesRoute />} />
     <Route path="files" element={<WanderMemoryFilesRoute />} />
     <Route path="dialogue" element={<WanderMemoryDialogueRoute />} />
     <Route path="chat" element={<WanderMemoryChatRoute />} />
     <Route path="context" element={<WanderMemoryContextRoute />} />
     <Route path="status" element={<WanderMemoryStatusRoute />} />
     <Route path="api" element={<WanderMemoryApiDocsRoute />} />
     <Route path="*" element={<Navigate to="memories" replace />} />
   </Route>
   ```
2. **Split the `记忆` top tab into `Wander 记忆` + `Hermes 记忆`** in `use-active-top-tab.ts`:
   - Extend the `TopTab` union to `"workbench" | "skills" | "gateway" | "wanderMemory" | "hermesMemory" | "advanced"`; delete `"externalMemory"`.
   - Replace the single `externalMemory` `TOP_TABS` entry with two entries (keep `num` sequential: 01 工作台 / 02 配置 / 03 消息接入 / **04 Wander 记忆** / **05 Hermes 记忆** / 06 高级):
   ```ts
   { id: "wanderMemory", num: "04", label: "Wander 记忆", href: "/wander-memory/memories",
     matches: (path) => path.startsWith("/wander-memory") },
   { id: "hermesMemory", num: "05", label: "Hermes 记忆", href: "/memory",
     matches: (path) => ["/memory", "/memconfig", "/openviking", "/hindsight"].some((route) => isRoute(path, route)) },
   ```
   - **Old `记忆` → `Hermes 记忆` redirect:** the old tab id/label no longer exists; migrate every reference (sidebar switch, command palette, tests, stored state) from `externalMemory`/`记忆` to `hermesMemory`/`Hermes 记忆`. Route paths stay as they are, so `/memory` deep links land in `Hermes 记忆` without a `<Navigate>` shim; add a redirect only if a route is ever moved.
3. **Add a `WanderMemorySidebar`** — new `web/src/components/app-shell/wander-memory-sidebar.tsx` modeled on `external-memory-sidebar.tsx`, listing the MemOS Workbench links (`/wander-memory/memories|files|dialogue|chat|context|status|api`). Wire it into `AppSidebar` (`app-sidebar.tsx`): `if (tab === "wanderMemory") return <WanderMemorySidebar />;`. Keep `ExternalMemorySidebar` unchanged — it now renders under the `Hermes 记忆` tab.
4. Add command-palette entries in `command-palette.tsx` / `lib/command-palette.ts` under a new group **"Wander 记忆"** so users can jump to WanderMemory views with ⌘K.
5. Add route path constants in `web/src/lib/wander-memory/paths.ts`.

**Files touched:**
- `C:\dev\Hermes-CN-Desktop\web\src\app.tsx`
- `C:\dev\Hermes-CN-Desktop\web\src\components\app-shell\use-active-top-tab.ts` (tab split + renumber)
- `C:\dev\Hermes-CN-Desktop\web\src\components\app-shell\app-sidebar.tsx` (render `WanderMemorySidebar` for `wanderMemory`)
- `C:\dev\Hermes-CN-Desktop\web\src\components\app-shell\wander-memory-sidebar.tsx` (new)
- `C:\dev\Hermes-CN-Desktop\web\src\components\app-shell\external-memory-sidebar.tsx` (unchanged; now under `Hermes 记忆`)
- `C:\dev\Hermes-CN-Desktop\web\src\components\command-palette\command-palette.tsx` (optional)
- `C:\dev\Hermes-CN-Desktop\web\src\lib\command-palette.ts` (optional)
- `C:\dev\Hermes-CN-Desktop\web\src\lib\wander-memory\paths.ts`

### Phase 7: Vite Dev Proxy for MemOS

**Goal:** In dev, Hermes Vite server (port 9545) can proxy MemOS endpoints so the merged SPA talks same-origin.

**Actions:**
1. Add proxy rules to `web/vite.config.ts`. Targets must be **port-shift aware** — resolve once at config load via `resolveWanderMemoryTargets()` (env override → ports file/health probe → defaults, Appendix L.3), never a hard-coded `:18400`/`:18402`:
   ```ts
   // web/vite.config.ts — env override first, then bound ports discovered from the
   // running backend (Appendix L.3), defaults as last resort.
   const memOs = resolveWanderMemoryTargets();
   server: {
     proxy: {
       "/api": { target: API_PROXY_TARGET, changeOrigin: true, ws: true },
       "/v1": { target: memOs.apiOrigin ?? "http://127.0.0.1:18400", changeOrigin: true },
       "/v1/fs": { target: memOs.fsOrigin ?? "http://127.0.0.1:18402", changeOrigin: true,
                    rewrite: (path) => path.replace(/^\/v1\/fs/, "/v1") },
     },
   }
   ```
   The WS client connects directly to the **bound** WS port (discovered, `REST + 1` by default), not a fixed `:18401`.
2. For production, the MemOS backend must be reachable through the Hermes Rust backend or bundled. If MemOS is not bundled, add a Tauri command or settings field to configure the MemOS origin. The bound ports must come from discovery (Appendix L.4) rather than defaults.
3. Review CSP in `tauri.conf.json`. The existing CSP already permits `connect-src` to `http://127.0.0.1:*`, `http://localhost:*`, `ws://127.0.0.1:*`, and `ws://localhost:*` — this covers **any** auto-shifted loopback port, so no change is required as long as MemOS stays on loopback. Restrict production MemOS to loopback; remote origins cannot be added dynamically to Tauri CSP.

**Files touched:**
- `C:\dev\Hermes-CN-Desktop\web\vite.config.ts`
- `C:\dev\Hermes-CN-Desktop\tauri.conf.json` (review only; likely no changes)

### Phase 8: Rust Backend Integration (if Hermes backend target)

**Goal:** If WanderMemory operations should eventually use Hermes-CN-Core, add the necessary backend plumbing.

**Actions:**
1. In `C:/dev/Hermes-CN-Core`, identify or add equivalent endpoints/RPCs for:
   - memory add/search/get/delete
   - dialogue import
   - context build
   - chat with memory grounding + streaming
   - maintenance / status introspection
   - file-system scan/ingest
2. In Hermes Desktop Rust side (`src/commands/`), add Tauri commands to expose these to the frontend.
3. Create a second `WanderMemoryClient` adapter implementation that calls these Tauri commands.
4. Add a settings toggle to switch between MemOS and Hermes backend adapters.

**Files touched (conditional):**
- `C:dev\Hermes-CN-Core\hermes_cli\web_server.py`
- `C:dev\Hermes-CN-Core\tui_gateway\server.py`
- `C:\dev\Hermes-CN-Desktop\src\commands\memory.rs` (extend)
- `C:\dev\Hermes-CN-Desktop\src\lib.rs` (register new commands)

### Phase 9: Styling & Theme Reconciliation

**Goal:** Ensure WanderMemory routes look correct within Hermes without breaking existing UI.

**Actions:**
1. Audit every new CSS Module against the design tokens; replace hard-coded colors (`#0a0a0a`, `amber-200`) with token variables.
2. If the dark enclave aesthetic is approved, apply a scoped override in `layout.module.css`:
   ```css
   [data-wander-memory] * {
     background-image: revert !important;
     box-shadow: revert;
   }
   ```
   and define local surface/line/text tokens under `[data-wander-memory-theme="dark"]`.
3. Preserve the "no gradient/shadow" philosophy where possible; if the dark amber aesthetic is a hard requirement, isolate it behind `[data-wander-memory-theme="dark"]`.
4. Verify light-theme compatibility; either force dark mode inside the subtree or provide light-mode token overrides.
5. Run `pnpm grid:check` to ensure spacing aligns to the 4px grid.

**Files touched:**
- `C:\dev\Hermes-CN-Desktop\web\src\components\wander-memory\layout.module.css`
- All `*.module.css` files created in Phase 5.

### Phase 10: Testing & Quality Assurance

**Goal:** Reach parity with Hermes testing standards.

**Actions:**
1. **Unit tests (Vitest):**
   - Port `tests/unit` from WanderMemory to `web/src/lib/wander-memory/*.test.ts` for:
     - error taxonomy
     - request epoch/staleness guard
     - endpoint resolution
     - WS frame parsing
   - Add tests for new hooks using `@testing-library/react` and manual mocks.
2. **Component tests:**
   - Test `MemoryCard`, `CollisionLine`, `ErrorCard` rendering and interactions.
   - Test route components with mocked hooks.
3. **E2E tests (Playwright):**
   - Add specs in `e2e/` covering navigation to `/wander-memory/memories`, add/search/delete memory, chat streaming, and file ingest.
   - Decide whether E2E runs against a real MemOS backend or a stub; align with existing E2E fake-model pattern.
4. **Manual smoke:**
   - `pnpm tauri:dev` with MemOS backend running.
   - Verify Hermes shell remains functional; check `/memory` existing route still works.
   - Verify build: `pnpm web:build:desktop` and `pnpm tauri:build:debug`.
5. **Lint / typecheck:**
   - `pnpm typecheck`
   - `pnpm test:unit`
   - `cargo check` (if Rust changed)

**Files to create:**
- `C:\dev\Hermes-CN-Desktop\web\src\lib\wander-memory\errors.test.ts`
- `C:\dev\Hermes-CN-Desktop\web\src\lib\wander-memory\client.test.ts`
- `C:\dev\Hermes-CN-Desktop\web\src\hooks\use-wander-memory.test.tsx`
- `C:\dev\Hermes-CN-Desktop\web\src\components\wander-memory\memory-card.test.tsx`
- `C:\dev\Hermes-CN-Desktop\e2e\wander-memory.spec.ts`

## 6. Concrete Architecture Sketch

### 6.1 Client Interface

```ts
// web/src/lib/wander-memory/client.ts
export interface WanderMemoryClient {
  readonly mode: 'live' | 'demo';
  health(): Promise<HealthResponse>;
  backends(): Promise<BackendsResponse>;
  models(): Promise<ModelsResponse>;
  addDialogue(dialogue: string): Promise<AddDialogueResponse>;
  addMemory(text: string, metadata?: Record<string, unknown>): Promise<AddMemoryResponse>;
  search(query: string, topK?: number): Promise<SearchResponse>;
  list(): Promise<SearchResponse>;
  get(id: string): Promise<GetMemoryResponse>;
  delete(id: string): Promise<void>;
  context(query: string, topK?: number): Promise<ContextResponse>;
  chat(query: string): Promise<ChatResponse>;
  chatStream(query: string, onDelta: (delta: string) => void): Promise<ChatResponse>;
  maintenance(): Promise<MaintenanceResponse>;
  streamingAvailable(): boolean;
}
```

### 6.2 Transport Choice Matrix

| Scenario | Dev | Production Desktop | Production Web |
|----------|-----|--------------------|----------------|
| MemOS adapter | Vite proxy `/v1` → `:18400` | Tauri `externalRequest` to configured origin | `fetchExternalJSON` to configured origin |
| Hermes adapter | `fetchJSON('/api/wander-memory/...')` | native IPC through `fetchJSON` | `fetchJSON` relative to dashboard |

### 6.3 Hook Example

```ts
// web/src/hooks/use-wander-memory.ts (excerpt)
export function useWanderMemoryList() {
  return useQuery({
    queryKey: ["wander-memory", "list"],
    queryFn: ({ signal }) => raceAbort(getWanderMemoryClient().list(), signal),
  });
}
```

## 7. File Reference Summary

### Source files to port (from `C:\dev\Wander-Memory\web\app\src`)
- `api/types.ts` → `web/src/lib/wander-memory/types.ts` (also absorb `api/fs_types.ts`)
- `api/errors.ts` → `web/src/lib/wander-memory/errors.ts`
- `api/client.ts` → `web/src/lib/wander-memory/client.ts`
- `api/rest.ts` → `web/src/lib/wander-memory/rest.ts`
- `api/ws.ts` → `web/src/lib/wander-memory/ws.ts`
- `api/fs_client.ts` → `web/src/lib/wander-memory/fs-client.ts`
- `api/demo.ts` → `web/src/lib/wander-memory/demo.ts`
- `api/endpoints.ts` → `web/src/lib/wander-memory/endpoints.ts` (absorb `api/fs_endpoints.ts`)
- `api/fs_endpoints.ts` → folded into `web/src/lib/wander-memory/endpoints.ts`
- `api/fs_types.ts` → folded into `web/src/lib/wander-memory/types.ts`
- `api/context.tsx` → replaced by `use-wander-memory.ts` + Jotai atoms
- `components/shared.tsx` → split into `components/wander-memory/*.tsx`
- `sections/AmberCascades.tsx` → optional `components/wander-memory/amber-cascades.tsx`
- `views/*.tsx` → `routes/wander-memory/*.tsx`
- `App.tsx` → absorbed into `web/src/app.tsx` route declarations

### Target files to modify/create in `C:\dev\Hermes-CN-Desktop`
- `web/src/app.tsx`
- `web/src/components/app-shell/external-memory-sidebar.tsx`
- `web/src/lib/wander-memory/` (new directory, ~9 files + tests)
- `web/src/hooks/use-wander-memory.ts` (+ test)
- `web/src/stores/wander-memory-chat.ts`
- `web/src/components/wander-memory/` (new directory, ~6 files + tests)
- `web/src/routes/wander-memory/` (new directory, ~14 files)
- `web/vite.config.ts`
- `tauri.conf.json` (only if CSP update required)
- `docs/wander-memory-merge.md` (new decision doc)
- `e2e/wander-memory.spec.ts` (new)

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Tailwind dependency temptation | High | Explicitly reject adding Tailwind; use CSS Modules + tokens; document in decision log. |
| Global CSS resets kill WanderMemory visuals | High | Scope overrides under `[data-wander-memory]` route layout only. |
| Backend mismatch (MemOS vs Hermes) | High | Phase 0 decision gate; build adapter interface so views are backend-agnostic. |
| Auth/transport differences | Medium | Route all calls through Hermes `transport.ts`; add per-origin headers only where MemOS requires them. |
| WebSocket blocked in Tauri production | Medium | Use `gateway-socket-path.ts` selection or add a Rust WS relay command mirroring `ws_proxy.rs`. |
| Feature duplication with existing `/memory` | Medium | Position WanderMemory as "MemOS / external memory workbench" under its own **`Wander 记忆`** top tab; `/memory` etc. stay under **`Hermes 记忆`** — no route replacement, no overlap. |
| Ports 18400/18401/18402 occupied | High | Backend auto-shift + frontend discovery (Appendix L); shifted ports stay on loopback so the existing CSP still applies. |
| E2E fragility from second backend | Medium | Provide a stub MemOS server or integrate with existing fake-model harness. |
| Large code migration | Medium | Deliver incrementally: client + one view first, then remaining views in follow-up PRs. |

## 9. Incremental Delivery Suggestion

To reduce risk, deliver in three PRs:

1. **PR 1 — Foundation:** Client abstraction, types, errors, hooks, and the `Memories` route only.
2. **PR 2 — Views:** Remaining routes (Files, Dialogue, Chat, Context, Status, ApiDocs) + shell navigation.
3. **PR 3 — Polish & Tests:** E2E, visual reconciliation, documentation, optional Hermes backend adapter.

## 10. Acceptance Criteria

- [ ] `pnpm typecheck` passes.
- [ ] `pnpm test:unit` passes (new tests included).
- [ ] `cargo check` passes (if Rust changed).
- [ ] `pnpm tauri:dev` starts and the new `/wander-memory/memories` route is reachable from the **`Wander 记忆`** tab in the Hermes shell.
- [ ] Top tabs are `工作台 / 配置 / 消息接入 / Wander 记忆 / Hermes 记忆 / 高级`; the old `记忆` tab redirects to `Hermes 记忆`.
- [ ] Port shifting works: with 18400/18401/18402 occupied, the Wander-Memory backend auto-shifts and the `Wander 记忆` views still connect via discovery (Appendix L).
- [ ] WanderMemory views render without visual regressions in the existing Hermes UI.
- [ ] No Tailwind CSS classes remain in merged source files.
- [ ] All dynamic memory text is rendered via React text nodes (no HTML injection).
- [ ] E2E smoke test for add/search/delete memory passes.
- [ ] CI workflows (`web-test.yml`, `web-e2e.yml`, `rust-test.yml`) remain green.

## 11. First Concrete Step

Start **Phase 0** by creating the worktrees and the decision document `docs/wander-memory-merge.md` that records:
- Chosen backend target (MemOS / Hermes / hybrid).
- Visual direction (dark enclave vs tokenized light/dark).
- List of WanderMemory views to port and any overlap with existing Hermes features.

Then proceed to Phase 2 (client abstraction) before touching any UI, because the client layer is the foundation for all routes and tests.

---

# Appendix A: Detailed Design — Phase 2 Client Abstraction Layer

## A.1 Module Layout

```
web/src/lib/wander-memory/
├── types.ts          # API contract types (ported from WanderMemory)
├── errors.ts         # ApiError + treatment mapping
├── endpoints.ts      # Origin resolution (env → ui-store → defaults)
├── client.ts         # WanderMemoryClient interface + singleton accessor
├── rest.ts           # MemOsRestClient
├── ws.ts             # MemOsWsClient
├── fs-client.ts      # MemOsFileSystemClient
├── demo.ts           # DemoWanderMemoryClient (offline simulation)
└── index.ts          # Public exports
```

## A.2 `types.ts`

Copy the interfaces from `C:\dev\Wander-Memory\web\app\src\api\types.ts` essentially unchanged. Keep the `WsFrame` union because the WS client needs it. Do **not** add Zod schemas unless product requires runtime validation; Hermes uses Zod in `packages/protocol` but WanderMemory's contract is small enough to keep as TypeScript-only for the first PR.

Key exported shapes:
- `MemoryItem`
- `CollisionSummary`
- `HealthResponse`
- `AddMemoryResponse`, `AddDialogueResponse`
- `SearchResponse`, `GetMemoryResponse`, `ContextResponse`, `ChatResponse`
- `BackendsResponse`, `ModelsResponse`, `MaintenanceResponse`
- `WsRequest`, `WsFrame`, `WsOp`, `WS_OPS`

## A.3 `errors.ts`

Port `ApiError` and `treatmentFor` from `C:\dev\Wander-Memory\web\app\src\api\errors.ts`. Add a helper to convert any thrown value into an `ApiError`:

```ts
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof Error) return ApiError.network(err);
  return new ApiError("unknown", String(err), null);
}
```

Later, hook `treatmentFor` into Hermes notification system in `use-wander-memory.ts` rather than calling it directly in components.

## A.4 `endpoints.ts`

Use Hermes `ui-store` (`readUiValue` / `writeUiValue`) for persistence instead of raw `localStorage`. Provide environment overrides for dev/prod flexibility.

```ts
const UI_KEYS = {
  apiOrigin: "wander-memory.apiOrigin",
  wsUrl: "wander-memory.wsUrl",
  fsOrigin: "wander-memory.fsOrigin",
} as const;

export interface WanderMemoryEndpoints {
  apiOrigin: string;   // e.g. "http://127.0.0.1:18400"
  wsUrl: string;       // e.g. "ws://127.0.0.1:18401/v1/ws"
  fsOrigin: string;    // e.g. "http://127.0.0.1:18402"
}

export function resolveEndpoints(): WanderMemoryEndpoints {
  const defaultApi = "http://127.0.0.1:18400";
  const defaultWs = "ws://127.0.0.1:18401/v1/ws";
  const defaultFs = "http://127.0.0.1:18402";

  return {
    apiOrigin: import.meta.env.VITE_WANDER_MEMORY_API_ORIGIN
      || readUiValue<string>(UI_KEYS.apiOrigin, defaultApi),
    wsUrl: import.meta.env.VITE_WANDER_MEMORY_WS_URL
      || readUiValue<string>(UI_KEYS.wsUrl, defaultWs),
    fsOrigin: import.meta.env.VITE_WANDER_MEMORY_FS_ORIGIN
      || readUiValue<string>(UI_KEYS.fsOrigin, defaultFs),
  };
}

export function saveEndpoints(eps: Partial<WanderMemoryEndpoints>): void {
  if (eps.apiOrigin) writeUiValue(UI_KEYS.apiOrigin, eps.apiOrigin);
  if (eps.wsUrl) writeUiValue(UI_KEYS.wsUrl, eps.wsUrl);
  if (eps.fsOrigin) writeUiValue(UI_KEYS.fsOrigin, eps.fsOrigin);
}
```

For dev same-origin proxying (Vite `/v1` → `:18400`), the REST client should be able to accept a relative origin such as `""` or `"/v1"`. Keep the default absolute origins but allow the Status view to override them.

## A.5 `client.ts`

```ts
export interface WanderMemoryClient {
  readonly mode: "live" | "demo";
  health(): Promise<HealthResponse>;
  backends(): Promise<BackendsResponse>;
  models(): Promise<ModelsResponse>;
  addDialogue(dialogue: string): Promise<AddDialogueResponse>;
  addMemory(text: string, metadata?: Record<string, unknown>): Promise<AddMemoryResponse>;
  search(query: string, topK?: number): Promise<SearchResponse>;
  list(): Promise<SearchResponse>;
  get(id: string): Promise<GetMemoryResponse>;
  delete(id: string): Promise<void>;
  context(query: string, topK?: number): Promise<ContextResponse>;
  chat(query: string): Promise<ChatResponse>;
  chatStream(query: string, onDelta: (delta: string) => void): Promise<ChatResponse>;
  maintenance(): Promise<MaintenanceResponse>;
  streamingAvailable(): boolean;
  onWsStateChange?(listener: (s: "connecting" | "open" | "closed") => void): () => void;
}

let clientInstance: WanderMemoryClient | null = null;

export function getWanderMemoryClient(): WanderMemoryClient {
  if (!clientInstance) {
    clientInstance = createMemOsClient();
  }
  return clientInstance;
}

export function resetWanderMemoryClient(next?: WanderMemoryClient): void {
  if (clientInstance && "dispose" in clientInstance) {
    (clientInstance as { dispose?(): void }).dispose?.();
  }
  clientInstance = next ?? null;
}

function createMemOsClient(): WanderMemoryClient {
  const eps = resolveEndpoints();
  const rest = new MemOsRestClient(eps.apiOrigin);
  const ws = new MemOsWsClient(eps.wsUrl);
  ws.connect();
  return new LiveWanderMemoryClient(rest, ws);
}
```

Use a singleton because WanderMemory views expect one shared WS connection (mirrors original `AppProvider`). The `resetWanderMemoryClient` helper lets the Status view re-create the client after endpoint changes.

## A.6 `rest.ts`

Implement `MemOsRestClient` by wrapping Hermes transport functions rather than raw `fetch`.

```ts
export class MemOsRestClient {
  constructor(private readonly baseUrl: string) {}

  private url(path: string): string {
    if (this.baseUrl === "" || this.baseUrl === "/v1") {
      return path; // dev same-origin proxy
    }
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs: number | null = 10_000,
  ): Promise<T> {
    const target = this.url(path);
    const isAbsolute = /^https?:\/\//.test(target);
    const call = isAbsolute
      ? fetchExternalJSON<T>(target, {
          method,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
        })
      : fetchJSON<T>(target, {
          method,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
        });

    try {
      return await call;
    } catch (err) {
      throw adaptTransportError(err);
    }
  }

  // endpoint methods mirroring original MemoryRestClient
}
```

`adaptTransportError` converts Hermes transport errors (`Error("HTTP 503: ...")`) into `ApiError` instances so the rest of the app can use `treatmentFor`.

## A.7 `ws.ts`

Keep the frame parsing and pending-request map from `MemoryWsClient`, but:
- Accept the resolved WS URL.
- Use `gateway-socket-path.ts` selection logic if we want to reuse Hermes native/relay path learning.
- For MemOS, the protocol is **not** JSON-RPC-over-`/api/ws`; it is WanderMemory's own op vocabulary. Therefore the WS client here is separate from `gateway-client.ts`.
- Provide `onWsStateChange` so the UI can show "ws streaming" / "REST fallback" badges.

For production Tauri builds where `ws://` may be blocked, add a future Rust relay command (`wander_memory_ws_proxy`) that forwards frames over Tauri events. Do not implement this relay until the issue is confirmed.

## A.8 `fs-client.ts`

Port `FileSystemRestClient` similarly to `rest.ts`, using `fetchExternalJSON` for absolute `:18402` origins and a Vite proxy rewrite for dev same-origin `/v1/fs`.

## A.9 `demo.ts`

Port `DemoClient` from `C:\dev\Wander-Memory\web\app\src\api\demo.ts` as `DemoWanderMemoryClient`. It must implement the full `WanderMemoryClient` interface including simulated streaming chat deltas.

Use it as the fallback when health fails in dev/test, or expose a toggle in the Status view (`mode: live | demo`).

## A.10 Transport Error Mapping

Hermes `fetchJSON` throws generic `Error("HTTP ${status}: ${body}")`. WanderMemory expects structured `ApiError(code, message, status)`. Create a mapper:

```ts
function adaptTransportError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  const httpMatch = msg.match(/HTTP (\d+):\s*(.+)/);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    const body = httpMatch[2];
    // Try to parse { error: { code, message } }
    try {
      const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
      if (parsed.error?.code) {
        return new ApiError(parsed.error.code, parsed.error.message ?? parsed.error.code, status);
      }
    } catch {
      /* fall through */
    }
    return new ApiError(status >= 500 ? "internal" : "unknown", body, status);
  }
  if (msg.includes("aborted") || msg.includes("timeout")) {
    return new ApiError("network_failure", msg, null);
  }
  return ApiError.network(err);
}
```

## A.11 Tests for Phase 2

Create the following tests before moving to Phase 3:
- `errors.test.ts`: `treatmentFor` coverage for all documented codes; `toApiError` coercion.
- `endpoints.test.ts`: resolution precedence (env → ui-store → default); `saveEndpoints` round-trip using mocked `ui-store`.
- `rest.test.ts`: mocked `fetchJSON` / `fetchExternalJSON`; verify correct path construction for relative vs absolute origins; verify error adaptation.
- `demo.test.ts`: `DemoWanderMemoryClient` add/search/delete/chat contract.

Do not write WS unit tests until the frame contract is finalized; rely on the ported logic and add tests in a follow-up.

## A.12 Open Questions to Resolve During Phase 2

1. Does MemOS require the Hermes `Authorization` / `X-Hermes-Session-Token` headers, or will they cause CORS/auth failures? If they cause failures, the REST client may need to call transport functions with an opt-out flag.
2. Does the Vite dev proxy need to forward WebSocket upgrade requests for `/v1/ws`, or should the WS client connect directly to `:18401` in dev? The original WanderMemory dev topology connects directly.
3. Should the demo mode be auto-activated on health failure (like original) or exposed only as a manual toggle?

---

# Appendix B: Detailed Design — Phase 3 TanStack Query Hooks

## B.1 Design Principles

- All server state goes through TanStack Query; local UI state (search input, modal open) stays in `useState`.
- Streaming chat deltas go to a dedicated Jotai atom (`stores/wander-memory-chat.ts`) because TanStack Query is not designed for append-only streams.
- Error handling uses the `ApiError` from `lib/wander-memory/errors.ts`. Since Hermes does not have an in-app toast system (`lib/notifications.ts` is for desktop-native notifications), surface errors either inline or via a small route-local toast component.
- Reproduce the request-epoch staleness guard from `MemoriesView` to prevent add/delete operations from being clobbered by in-flight list/search responses.

## B.2 Hook Inventory

```ts
// web/src/hooks/use-wander-memory.ts

export function useWanderMemoryHealth(options?: { refetchInterval?: number }) { ... }
export function useWanderMemoryList() { ... }
export function useWanderMemorySearch(query: string, topK?: number) { ... }
export function useWanderMemoryAdd() { ... }            // mutation
export function useWanderMemoryDelete() { ... }         // mutation
export function useWanderMemoryDialogue() { ... }       // mutation
export function useWanderMemoryContext() { ... }        // mutation
export function useWanderMemoryChat() { ... }           // mutation (non-streaming fallback)
export function useWanderMemoryChatStream() { ... }     // returns { send, cancel, isStreaming }
export function useWanderMemoryMaintenance() { ... }    // mutation
export function useWanderMemoryModels() { ... }
export function useWanderMemoryBackends() { ... }
```

## B.3 Query Keys

Use a consistent namespace so mutations can invalidate related queries:

```ts
const KEYS = {
  base: ["wander-memory"] as const,
  health: () => [...KEYS.base, "health"] as const,
  list: () => [...KEYS.base, "list"] as const,
  search: (query: string, topK?: number) => [...KEYS.base, "search", query, topK ?? "default"] as const,
  memory: (id: string) => [...KEYS.base, "memory", id] as const,
  models: () => [...KEYS.base, "models"] as const,
  backends: () => [...KEYS.base, "backends"] as const,
};
```

## B.4 Example: `useWanderMemoryList`

```ts
export function useWanderMemoryList() {
  return useQuery<SearchResponse, ApiError>({
    queryKey: KEYS.list(),
    queryFn: ({ signal }) => raceAbort(getWanderMemoryClient().list(), signal),
    staleTime: 5_000,
  });
}
```

## B.5 Example: `useWanderMemoryAdd` with Epoch Invalidation

```ts
export function useWanderMemoryAdd() {
  const qc = useQueryClient();
  return useMutation<AddMemoryResponse, ApiError, { text: string; metadata?: Record<string, unknown> }>({
    mutationFn: ({ text, metadata }) => getWanderMemoryClient().addMemory(text, metadata),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.list() });
      qc.invalidateQueries({ queryKey: KEYS.search() }); // predicates work if query key starts with search
    },
  });
}
```

For the epoch guard needed in the `MemoriesView` (prevent stale search results from overwriting a just-added memory), implement it at the component level rather than the hook level because TanStack Query manages its own staleness. Alternatively, use `queryKey` invalidation aggressively and rely on refetch.

## B.6 Example: `useWanderMemoryChatStream`

```ts
export function useWanderMemoryChatStream() {
  const [isStreaming, setIsStreaming] = useState(false);
  const addMessage = useSetAtom(addWanderMemoryChatMessageAtom);
  const updateLastMessage = useSetAtom(updateWanderMemoryLastMessageAtom);

  const send = useCallback(async (query: string) => {
    const client = getWanderMemoryClient();
    setIsStreaming(true);
    addMessage({ role: "user", text: query });
    addMessage({ role: "assistant", text: "", streaming: true });

    try {
      const res = await client.chatStream(query, (delta) => {
        updateLastMessage((msg) => ({ ...msg, text: msg.text + delta }));
      });
      updateLastMessage((msg) => ({
        ...msg,
        text: res.reply,
        streaming: false,
        dreamed: res.dreamed_keywords,
        groundedCount: res.grounded_memories?.length,
        groundedSnippets: res.grounded_memories?.slice(0, 3).map((g) => g.memory),
      }));
    } catch (err) {
      updateLastMessage((msg) => ({ ...msg, streaming: false, error: toApiError(err) }));
    } finally {
      setIsStreaming(false);
    }
  }, [addMessage, updateLastMessage]);

  const cancel = useCallback(() => {
    // MemOS server generation is not cancellable; client can only discard late frames.
    updateLastMessage((msg) =>
      msg.streaming
        ? { ...msg, streaming: false, text: msg.text + " [cancelled — late frame discarded]" }
        : msg,
    );
    setIsStreaming(false);
  }, [updateLastMessage]);

  return { send, cancel, isStreaming };
}
```

## B.7 `stores/wander-memory-chat.ts`

```ts
export interface WanderMemoryChatMessage {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  dreamed?: string[];
  groundedCount?: number;
  groundedSnippets?: string[];
  error?: ApiError;
}

export const wanderMemoryChatMessagesAtom = atom<WanderMemoryChatMessage[]>([]);

export const addWanderMemoryChatMessageAtom = atom(null, (get, set, msg: WanderMemoryChatMessage) => {
  set(wanderMemoryChatMessagesAtom, [...get(wanderMemoryChatMessagesAtom), msg]);
});

export const updateWanderMemoryLastMessageAtom = atom(
  null,
  (get, set, updater: (msg: WanderMemoryChatMessage) => WanderMemoryChatMessage) => {
    const msgs = get(wanderMemoryChatMessagesAtom);
    const last = msgs[msgs.length - 1];
    if (!last) return;
    set(wanderMemoryChatMessagesAtom, [...msgs.slice(0, -1), updater(last)]);
  },
);
```

## B.8 Error Surface Strategy

Hermes has no global in-app toast. For WanderMemory, choose one of:
1. **Inline alerts** — use `@hermes/shared-ui` `Alert` inside each route for persistent errors.
2. **Route-local toast stack** — create `components/wander-memory/toast.tsx` with a tiny provider scoped to WanderMemory routes only.
3. **Re-use `ConfirmProvider` + `useConfirm`** — only for confirmations, not transient toasts.

**Recommendation:** Use inline `Alert` for health/connection errors and a small local toast for operation success/failure (delete succeeded, memory added). This keeps the scope contained and avoids adding a global toast system to Hermes.

## B.9 Tests for Phase 3

- `use-wander-memory.test.tsx`: mock `getWanderMemoryClient`; verify query keys, loading states, mutation invalidation.
- `wander-memory-chat.test.ts`: verify Jotai atom reducers append/update last message correctly.

---

# Appendix C: Detailed Design — Phase 5 Route Migration & Styling

## C.1 Route Mapping

| WanderMemory View | Hermes Route | Layout Wrapper | Notes |
|-------------------|--------------|----------------|-------|
| `MemoriesView` | `/wander-memory/memories` | `SectionShell` | Two-column layout; left search/results, right add form. |
| `FilesView` | `/wander-memory/files` | `SectionShell` | Directory scan + file list + ingest editor. |
| `DialogueView` | `/wander-memory/dialogue` | `SectionShell` | Two-column: input left, results right. |
| `ChatView` | `/wander-memory/chat` | `SectionShell` | Chat feed + composer; uses Jotai stream atom. |
| `ContextView` | `/wander-memory/context` | `SectionShell` | Query + generated context block. |
| `StatusView` | `/wander-memory/status` | `SectionShell` | Health cards + endpoint settings + maintenance. |
| `ApiDocsView` | `/wander-memory/api` | `SectionShell` | Static reference tables. |

## C.2 Tailwind → Hermes Token Mapping

| WanderMemory Tailwind | Hermes Token / Component | Notes |
|-----------------------|--------------------------|-------|
| `bg-[#0a0a0a]` | `var(--h-bg-app)` or `var(--h-bg-pane)` | Use existing theme; do not hard-code dark. |
| `text-white` | `var(--h-text)` | Theme-aware. |
| `text-neutral-100/400/500/600` | `var(--h-text)`, `--h-text-2`, `--h-text-3`, `--h-text-4` | Map semantically. |
| `border-white/10`, `border-white/15` | `var(--h-line)`, `var(--h-line-soft)` | Use 1px separators. |
| `text-amber-200`, `border-amber-200/40` | `var(--h-accent)`, `var(--h-accent-border)` | Amber maps to accent in dark mode; in light mode use `--h-accent` as-is. |
| `bg-white/[0.02]`, `bg-white/5` | `var(--h-bg-soft)`, `var(--h-bg-chip)` | Use semantic surfaces. |
| `font-mono` | `var(--h-font-mono)` if available, else keep `monospace` | Check typography tokens. |
| `shadow-2xl`, `backdrop-blur-md` | **Avoid** | Project CSS strips these. Use solid surfaces and 1px borders. |
| `rounded-*` | `--h-radius-*` or keep square | Hermes tokens include radius; default is likely square. |

## C.3 Layout Strategy

Use `SectionShell` for each route so they integrate with Hermes top bar, scroll behavior, and responsive rail:

```tsx
// routes/wander-memory/memories.tsx
import { SectionShell } from "@/routes/section-shell";
import { WanderMemoryMemoriesPage } from "@/components/wander-memory/memories-page";

export function WanderMemoryMemoriesRoute() {
  return (
    <SectionShell title="MemOS Workbench" sub="记忆 / 浏览与检索">
      <WanderMemoryMemoriesPage />
    </SectionShell>
  );
}
```

The actual page component lives in `components/wander-memory/` so it can be tested independently of routing.

## C.4 Component Replacements

| WanderMemory Component | Hermes Replacement |
|------------------------|--------------------|
| `Spinner` | `LoadingState` from `@hermes/shared-ui` |
| `ConfirmDialog` | `useConfirm()` hook (already in `lib/use-confirm.tsx`) |
| `JsonModal` | `Dialog.Root` / `Dialog.Content` from `@hermes/shared-ui` |
| `HealthBanner` | Inline `Alert` or a custom `WanderMemoryConnectionBanner` |
| `MemoryCard` | Custom CSS Module card using `var(--h-bg-pane)` / `--h-line` |
| `ErrorCard` | `Alert` variant="danger" from `@hermes/shared-ui` |
| Tailwind inputs | `Input` / `Textarea` from `@hermes/shared-ui` |
| Tailwind buttons | `Button` from `@hermes/shared-ui` |

## C.5 Dark Enclave (Optional)

If product requires preserving WanderMemory's dark aesthetic, create a scoped override:

```css
/* components/wander-memory/layout.module.css */
.enclave {
  composes: page from "@/routes/section-shell.module.css";
  background: var(--h-bg-app);
}

.enclave[data-theme="dark"] {
  --w-surface: var(--ink-100);
  --w-line: #2a2a2a;
  --w-text: var(--bone-200);
  --w-text-muted: var(--bone-500);
  --w-accent: var(--h-color-amber-500);
}

.enclave[data-theme="dark"] * {
  background-image: revert !important;
  box-shadow: revert;
  text-shadow: revert !important;
}
```

Apply `[data-theme="dark"]` only when the route opts in. Default to no enclave so light/dark theme follows the global Hermes setting.

## C.6 CSS Modules per Route

Each route/component gets its own module:

```css
/* components/wander-memory/memories-page.module.css */
.page {
  display: grid;
  grid-template-columns: 1fr 360px;
  gap: 24px;
}

@media (max-width: 900px) {
  .page {
    grid-template-columns: 1fr;
  }
}

.searchRow {
  display: flex;
  gap: 8px;
}

.results {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 16px;
}
```

No Tailwind utility classes remain in the merged source.

## C.7 Text-Only Rendering Rule

WanderMemory's README emphasizes: "all memory text rendered as plain text (textContent) — never HTML." Preserve this in Hermes:

```tsx
// Good
<p className={s.memoryText}>{item.memory}</p>

// Bad
<div dangerouslySetInnerHTML={{ __html: item.memory }} />
```

This also satisfies Hermes security conventions.

## C.8 Keyboard & Accessibility

Preserve from WanderMemory:
- `Enter` to submit search/chat/context.
- `Escape` to cancel streaming (client-side only).
- Focus rings come from global CSS (`:focus-visible`).
- Buttons use `Button` from shared-ui which already supports `aria-busy` and disabled loading state.

## C.9 Responsive Considerations

- `SectionShell` already handles narrow viewports and the diagnostic rail.
- Avoid fixed `max-width` inside route content; use the shell's content max-width.
- Two-column layouts (`Memories`, `Dialogue`, `Files`) should collapse to single column below `900px`.

## C.10 Tests for Phase 5

- `memory-card.test.tsx`: render with sample `MemoryItem`; verify copy-id button, metadata chips, delete callback.
- `memories-page.test.tsx`: mock `useWanderMemoryList` / `useWanderMemoryAdd`; verify add form calls mutation.
- `chat-page.test.tsx`: mock `useWanderMemoryChatStream`; verify message list updates and cancel handler.

---

# Appendix D: Detailed Design — Phase 6 Navigation Integration

## D.1 Top-Tab Split (Wander 记忆 / Hermes 记忆)

`use-active-top-tab.ts` `TOP_TABS` becomes (labels in the top bar):
`01 工作台` · `02 配置` · `03 消息接入` · **`04 Wander 记忆`** · **`05 Hermes 记忆`** · `06 高级`.

- **`Wander 记忆`** (`wanderMemory`) — new tab for this plan; `href: "/wander-memory/memories"`; matches `/wander-memory/*`.
- **`Hermes 记忆`** (`hermesMemory`) — rename of the old `记忆`/`externalMemory` tab; `href: "/memory"`; matches `["/memory", "/memconfig", "/openviking", "/hindsight"]`.
- **Old `记忆` redirect:** the old id/label is gone; every reference migrates to `hermesMemory`. No route moves, so existing URLs keep working.

## D.2 Sidebar

- New **`WanderMemorySidebar`** (`components/app-shell/wander-memory-sidebar.tsx`) for the `Wander 记忆` tab, with the MemOS Workbench links:
  - `/wander-memory/memories`
  - `/wander-memory/files`
  - `/wander-memory/dialogue`
  - `/wander-memory/chat`
  - `/wander-memory/context`
  - `/wander-memory/status`
  - `/wander-memory/api`
- `AppSidebar` switch: `if (tab === "wanderMemory") return <WanderMemorySidebar />;`
- `ExternalMemorySidebar` (内置记忆 / 配置 / OpenViking / Hindsight) is unchanged and now renders under `Hermes 记忆` — no longer alongside the MemOS workbench.

## D.3 Command Palette

Add entries to `command-palette.tsx` under a new group **"Wander 记忆"**:
- `MemOS: 浏览记忆` → `/wander-memory/memories`
- `MemOS: 文件导入` → `/wander-memory/files`
- `MemOS: 对话导入` → `/wander-memory/dialogue`
- `MemOS: 记忆聊天` → `/wander-memory/chat`
- `MemOS: 上下文预览` → `/wander-memory/context`
- `MemOS: 状态` → `/wander-memory/status`

Use `Brain` or `Database` icon from `lucide-react`. Existing memory commands stay under the `Hermes 记忆` group.

## D.4 Active Tab Behavior

`useActiveTopTab` determines which sidebar renders. `/wander-memory/*` must return `"wanderMemory"` (new sidebar), and the old memory routes return `"hermesMemory"` (existing sidebar). Callers that compared against `"externalMemory"` must be updated to the two new ids.

---

# Appendix E: Consolidated Testing Plan

## E.1 Unit Tests

| File | Coverage |
|------|----------|
| `lib/wander-memory/errors.test.ts` | `ApiError`, `treatmentFor`, `toApiError` |
| `lib/wander-memory/endpoints.test.ts` | resolution precedence, persistence |
| `lib/wander-memory/rest.test.ts` | path construction, error adaptation, parser passthrough |
| `lib/wander-memory/demo.test.ts` | demo client contract |
| `hooks/use-wander-memory.test.tsx` | query keys, loading, mutations, invalidation |
| `stores/wander-memory-chat.test.ts` | atom reducers |
| `components/wander-memory/memory-card.test.tsx` | render + interactions |
| `components/wander-memory/collision-line.test.tsx` | collision summary rendering |

## E.2 E2E Tests

`e2e/wander-memory.spec.ts`:
1. Navigate to `/wander-memory/memories` via sidebar.
2. Add a memory; verify it appears in list.
3. Search for the memory; verify result.
4. Delete the memory; verify removal.
5. Open `/wander-memory/chat`; send a message; verify assistant reply appears.

Run against either:
- Real MemOS backend started in CI, or
- A stub Node/Express server implementing `/v1/*` contract.

## E.3 Manual Checklist

- [ ] Top bar shows `工作台 / 配置 / 消息接入 / Wander 记忆 / Hermes 记忆 / 高级`; old `记忆`/`externalMemory` references land in `Hermes 记忆`.
- [ ] `pnpm web:dev` loads `/wander-memory/memories` under the `Wander 记忆` tab.
- [ ] Theme switch (light/dark) applies to WanderMemory routes when not in enclave mode.
- [ ] Existing `/memory` route still works under `Hermes 记忆`.
- [ ] Build passes: `pnpm web:build:desktop`.
- [ ] No Tailwind classes in new files.

---

# Appendix F: Phase 0 Decision Document Template

Create `C:\dev\Hermes-CN-Desktop\docs\wander-memory-merge.md` with the following sections:

```markdown
# WanderMemory Frontend Merge Decision

## 1. Backend Target

- [ ] MemOS (ports 18400/18401/18402 — auto-shift when occupied, see Appendix L)
- [ ] Hermes-CN-Core (port 9120)
- [ ] Hybrid / adapter (MemOS first, Hermes later)

**Decision:** ___
**Rationale:** ___

## 2. Visual Direction

- [ ] Follow global Hermes theme (light/dark tokens)
- [ ] Dark enclave for WanderMemory routes only

**Decision:** ___
**Rationale:** ___

## 3. Views to Port

| View | Route | Priority | Notes |
|------|-------|----------|-------|
| Memories | /wander-memory/memories | P0 | Core feature |
| Chat | /wander-memory/chat | P0 | Streaming chat |
| Files | /wander-memory/files | P1 | File-system ingest |
| Dialogue | /wander-memory/dialogue | P1 | Transcript import |
| Context | /wander-memory/context | P1 | Prompt preview |
| Status | /wander-memory/status | P2 | Settings/introspection |
| ApiDocs | /wander-memory/api | P2 | Reference |

## 4. Feature Overlap with Existing Hermes Routes

- `/memory` (built-in memory entries) — no overlap; WanderMemory is external MemOS.
- `/external-memory` (OpenViking/Hindsight) — WanderMemory added as another external memory option.
- Chat composer (gateway chat) — no overlap; WanderMemory chat is memory-grounded LLM chat.

## 5. Open Questions

1. Does MemOS accept Hermes auth headers?
2. Will MemOS be bundled with Hermes Desktop releases?
3. Do we need offline demo mode in production?
4. Port-shift policy: probe range (default `[base, base+9]`)? Should shifted ports persist across restarts (ports file) or be re-probed on every launch?
```

---

# Appendix G: Detailed Design — Phase 7 Vite Proxy & CSP

## G.1 Dev Proxy Configuration

Extend `web/vite.config.ts` server proxy with **port-shift aware targets** (Appendix L.3):

```ts
const memOs = resolveWanderMemoryTargets(); // env override → ports file → health probe → defaults
server: {
  proxy: {
    "/api": { target: API_PROXY_TARGET, changeOrigin: true, ws: true },
    "/v1": {
      target: memOs.apiOrigin ?? "http://127.0.0.1:18400",
      changeOrigin: true,
    },
    "/v1/fs": {
      target: memOs.fsOrigin ?? "http://127.0.0.1:18402",
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/v1\/fs/, "/v1"),
    },
  },
}
```

The WS client should connect directly to the **bound** WS port in dev (original topology: direct to `ws://127.0.0.1:<bound-ws>/v1/ws`, no proxy) unless the proxy is configured to forward WebSocket upgrades. `<bound-ws>` is `apiPort + 1` by default, but comes from discovery when the backend shifted (Appendix L).

## G.2 Production Connectivity

For packaged Tauri builds, two options:

1. **Bundled MemOS** — package the MemOS Python service with the installer and spawn it from Rust (similar to dashboard/runtime management). Requires significant backend work. The spawner must read the **bound ports back** (stdout line or ports file, Appendix L.4) — never assume 18400/18401/18402 are free.
2. **External MemOS** — user must run MemOS separately; Hermes Desktop connects via configured origin (or discovery-probes the defaults/range).

Default recommendation: Option 2 for the first iteration. Add a settings field for origin configuration; the Status view shows the actual bound ports and can trigger re-discovery.

## G.3 CSP Review

Current `tauri.conf.json` CSP already allows:
- `connect-src 'self' ... http://localhost:* http://127.0.0.1:* ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:*`

This covers MemOS on loopback ports. **No CSP change is needed** if MemOS stays on `127.0.0.1`/`localhost`. If users configure a remote MemOS origin, that origin must be added to CSP at build time, which is impractical. Therefore restrict MemOS to loopback for Tauri builds.

## G.4 Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `WANDER_MEMORY_API_ORIGIN` | Dev REST origin | `http://127.0.0.1:18400` |
| `WANDER_MEMORY_WS_URL` | Dev WebSocket URL | `ws://127.0.0.1:18401/v1/ws` |
| `WANDER_MEMORY_FS_ORIGIN` | Dev file-system API | `http://127.0.0.1:18402` |
| `VITE_WANDER_MEMORY_*` | Build-time injected defaults | same as above |

Env vars are the highest-priority override. When unset, the frontend falls back to port-shift discovery (ports file / health probe, Appendix L.3) before the documented defaults.

---

# Appendix H: Detailed Design — Phase 8 Rust Backend Integration (Conditional)

## H.1 When to Implement

Only implement Phase 8 if the decision in Appendix F selects "Hermes backend" or "Hybrid" with a Hermes adapter.

## H.2 Backend Contract Mapping

| WanderMemory Operation | Proposed Hermes Endpoint / RPC |
|------------------------|--------------------------------|
| `GET /v1/health` | reuse dashboard health or new `/api/wander-memory/health` |
| `GET /v1/backends` | new endpoint or gateway RPC |
| `GET /v1/models` | reuse `/api/models` |
| `POST /v1/dialogues` | new `/api/wander-memory/dialogues` |
| `POST /v1/memories` | new `/api/wander-memory/memories` |
| `GET /v1/memories` | new `/api/wander-memory/memories` |
| `GET /v1/memories/{id}` | new `/api/wander-memory/memories/:id` |
| `DELETE /v1/memories/{id}` | new `/api/wander-memory/memories/:id` |
| `POST /v1/context` | new `/api/wander-memory/context` |
| `POST /v1/chat` | new `/api/wander-memory/chat` |
| `WS /v1/ws` | new gateway namespace or reuse existing `/api/ws` with new ops |
| `POST /v1/maintenance` | new `/api/wander-memory/maintenance` |
| FS API (`/v1/scan`, `/v1/update_ingest`) | new `/api/wander-memory/fs/*` |

## H.3 Tauri Commands (if native bridge preferred)

If MemOS is bundled and managed by Rust, add commands in `src/commands/wander_memory.rs`:

```rust
#[tauri::command]
async fn wander_memory_request(
    state: tauri::State<'_, AppState>,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<WanderMemoryResponse, AppError> { ... }
```

Register in `main.rs` `generate_handler!`.

Add `wander_memory_get_ports()` returning the bound REST/WS/FS ports of the managed MemOS spawn (Appendix L.4); the frontend uses it as the authoritative discovery source instead of assuming 18400/18401/18402.

## H.4 Frontend Hermes Adapter

Create `web/src/lib/wander-memory/hermes-adapter.ts` implementing `WanderMemoryClient`:

```ts
export class HermesWanderMemoryClient implements WanderMemoryClient {
  readonly mode = "live" as const;
  // Map each method to Hermes endpoints / gateway RPCs
}
```

Add a settings toggle in the Status view to switch between `MemOsClient` and `HermesWanderMemoryClient`, calling `resetWanderMemoryClient()`.

## H.5 Cross-Repo Workflow

Per AGENTS.md:
1. Create worktree for `Hermes-CN-Core`.
2. Add backend endpoints/RPCs in Core.
3. Create worktree for `Hermes-CN-Desktop`.
4. Add Rust commands and frontend adapter in Desktop.
5. Run both test suites before PR.

---

# Appendix I: PR1 Implementation Checklist — Foundation (Phase 0 + Phase 2)

## I.1 Pre-Flight (do not skip)

- [ ] Sync `C:\dev\Hermes-CN-Desktop` with `origin/main`.
- [ ] Create worktree: `git -C C:\dev\Hermes-CN-Desktop worktree add ..\wt\Hermes-CN-Desktop-wander-merge -b feat/wander-memory-merge origin/main`
- [ ] If Hermes backend is chosen, sync `C:dev\Hermes-CN-Core` and create its worktree too.
- [ ] Write `docs/wander-memory-merge.md` using Appendix F template.
- [ ] Record backend target decision and visual direction.

## I.2 File Additions for Phase 2

Create the following files in the worktree:

```
web/src/lib/wander-memory/
├── index.ts
├── types.ts
├── errors.ts
├── endpoints.ts
├── client.ts
├── rest.ts
├── ws.ts
├── fs-client.ts
├── demo.ts
├── errors.test.ts
└── rest.test.ts
```

## I.3 Implementation Order

1. **Types** — port `types.ts` verbatim from WanderMemory.
2. **Errors** — port `errors.ts`, add `toApiError`, write `errors.test.ts`.
3. **Endpoints** — implement `resolveEndpoints` / `saveEndpoints` using `ui-store`, write `endpoints.test.ts`.
4. **Client interface + singleton** — create `client.ts` with `WanderMemoryClient` interface and `getWanderMemoryClient`/`resetWanderMemoryClient`.
5. **REST adapter** — implement `rest.ts` using Hermes `fetchJSON`/`fetchExternalJSON`, write `rest.test.ts`.
6. **WS client** — port `ws.ts` frame logic; connect on singleton creation.
7. **FS client** — port `fs-client.ts`.
8. **Demo client** — port `demo.ts`.
9. **Public exports** — create `index.ts`.

## I.4 Vite Config Addition (dev only)

In `web/vite.config.ts`, add inside `server.proxy` with **port-shift aware targets** (Appendix L.3):

```ts
const memOs = resolveWanderMemoryTargets(); // env override → ports file → health probe → defaults
"/v1": {
  target: memOs.apiOrigin ?? "http://127.0.0.1:18400",
  changeOrigin: true,
},
"/v1/fs": {
  target: memOs.fsOrigin ?? "http://127.0.0.1:18402",
  changeOrigin: true,
  rewrite: (path) => path.replace(/^\/v1\/fs/, "/v1"),
},
```

Do not modify `tauri.conf.json` CSP (loopback already allowed; shifted ports stay on loopback).

## I.5 Verification Before PR1

- [ ] `pnpm typecheck` passes.
- [ ] `pnpm test:unit` passes (new tests + existing).
- [ ] `cargo check` passes (no Rust changes in PR1).
- [ ] No Tailwind classes in new files.
- [ ] All new files use Hermes transport (no raw `fetch`).

## I.6 PR1 Commit Message

```
feat(wander-memory): add client abstraction layer

- Port WanderMemory API types, errors, and demo client
- Implement MemOS REST/WS/FS clients on top of Hermes transport
- Add dev Vite proxy for MemOS endpoints
- Include unit tests for errors and REST adapter
```

## I.7 After PR1

Proceed to PR2 (Phase 3 + Phase 5 + Phase 6): hooks, route views, shell integration.

---

# Appendix J: PR2 Implementation Checklist — Hooks, Views & Shell

## J.1 Scope

Phase 3 (TanStack Query hooks + chat atom) + Phase 4 (shared components) + Phase 5 (route views) + Phase 6 (shell integration).

## J.2 File Additions

```
web/src/
├── hooks/
│   ├── use-wander-memory.ts
│   └── use-wander-memory.test.tsx
├── stores/
│   ├── wander-memory-chat.ts
│   └── wander-memory-chat.test.ts
├── components/wander-memory/
│   ├── layout.tsx
│   ├── layout.module.css
│   ├── memory-card.tsx
│   ├── memory-card.module.css
│   ├── memory-card.test.tsx
│   ├── collision-line.tsx
│   ├── collision-line.module.css
│   ├── error-card.tsx
│   ├── error-card.module.css
│   ├── toast.tsx          # optional route-local toast
│   └── toast.module.css
└── routes/wander-memory/
    ├── memories.tsx
    ├── memories.module.css
    ├── files.tsx
    ├── files.module.css
    ├── dialogue.tsx
    ├── dialogue.module.css
    ├── chat.tsx
    ├── chat.module.css
    ├── context.tsx
    ├── context.module.css
    ├── status.tsx
    ├── status.module.css
    ├── api-docs.tsx
    └── api-docs.module.css
├── components/app-shell/
│   └── wander-memory-sidebar.tsx  # Wander 记忆 tab sidebar (Phase 6)
```

## J.3 Implementation Order

1. **Chat atom** (`stores/wander-memory-chat.ts`) + tests.
2. **Hooks** (`use-wander-memory.ts`) + tests.
3. **Shared components** (`memory-card`, `collision-line`, `error-card`, optional `toast`) + tests.
4. **Layout** (`layout.tsx` + `layout.module.css`) with `SectionShell` integration.
5. **Views** one by one: Memories → Chat → Files → Dialogue → Context → Status → ApiDocs.
6. **Routes** registration in `app.tsx`.
7. **Sidebars** — new `wander-memory-sidebar.tsx` for the `Wander 记忆` tab; wire it in `app-sidebar.tsx`; `external-memory-sidebar.tsx` stays for `Hermes 记忆`.
8. **Top-tab split** in `use-active-top-tab.ts` — replace `externalMemory` with `wanderMemory` + `hermesMemory`; old `记忆` redirects to `Hermes 记忆`.
9. **Command palette** entries (optional but recommended).

## J.4 Styling Verification

- [ ] Run `pnpm grid:check`.
- [ ] Audit all new CSS Modules for hard-coded colors; replace with tokens.
- [ ] Verify no Tailwind utility classes remain.
- [ ] Test in light and dark themes (unless enclave mode forces dark).

## J.5 Verification Before PR2

- [ ] `pnpm typecheck` passes.
- [ ] `pnpm test:unit` passes.
- [ ] `pnpm tauri:dev` shows `/wander-memory/memories` from sidebar.
- [ ] Existing Hermes routes unaffected.

## J.6 PR2 Commit Message

```
feat(wander-memory): add hooks, views and shell integration

- Add TanStack Query hooks and chat stream Jotai atom
- Port Memories, Files, Dialogue, Chat, Context, Status, ApiDocs views
- Integrate /wander-memory/* routes into AppShell and sidebar
- Use Hermes CSS Modules and shared-ui primitives
```

## J.7 After PR2

Proceed to PR3: E2E, visual reconciliation, docs.

---

# Appendix K: PR3 Implementation Checklist — Tests & Polish

## K.1 Scope

Phase 9 (styling reconciliation) + Phase 10 (testing) + documentation + optional Hermes backend adapter.

## K.2 Tasks

1. **E2E tests**
   - Create `e2e/wander-memory.spec.ts`.
   - Add page objects for `/wander-memory/*` routes.
   - Configure CI to start MemOS stub or real backend.

2. **Visual polish**
   - Fine-tune spacing against 4px grid.
   - Resolve any remaining global CSS conflicts.
   - Decide on dark enclave vs global theme; document decision.

3. **Documentation**
   - Update `docs/wander-memory-merge.md` with final decisions.
   - Add README section for running with MemOS backend.

4. **Optional Hermes backend adapter**
   - If chosen, implement Phase 8 (Rust commands + `HermesWanderMemoryClient`).
   - Add settings toggle to switch adapters.

## K.3 Verification Before PR3

- [ ] `pnpm typecheck` passes.
- [ ] `pnpm test:unit` passes.
- [ ] `pnpm test:e2e` passes (or new E2E spec passes locally).
- [ ] `cargo check` passes (if Rust changed).
- [ ] `pnpm web:build:desktop` succeeds.
- [ ] `pnpm tauri:build:debug` succeeds.

## K.4 PR3 Commit Message

```
test(wander-memory): add e2e coverage and polish

- Add Playwright E2E for memories and chat flows
- Fix visual regressions and grid alignment
- Document MemOS integration and backend adapter decisions
```

## K.5 Final Acceptance

All acceptance criteria from Section 10 are met.

---

# Appendix L: Port Shifting — Wander-Memory Backend + Hermes Frontend

## L.1 Problem

Wander-Memory's MemOS services bind fixed loopback ports: **18400** REST (`/v1`), **18401** WS (`/v1/ws`), **18402** FS (`/v1`) — `DEFAULT_HTTP_PORT` / `DEFAULT_WS_PORT` in `..\Wander-Memory\src\memory\api.py` and `DEFAULT_FS_PORT` in `..\Wander-Memory\src\memory\__main__.py`. If any port is already taken by another process, startup fails on bind. The Hermes Desktop integration must not assume the defaults are free: **when a port is occupied, the backend shifts to the next free ports and the frontend discovers the actual bound ports.**

## L.2 Backend Changes (`..\Wander-Memory`)

1. **Auto-shift on bind failure** — in `src/memory/api.py` / `src/memory/__main__.py` (and the FS service in `src/mem_filesys`), catch the bind error (`EADDRINUSE` / `OSError`) and retry on the next candidate port instead of failing:
   - Probe a bounded range: `[base, base + 9]` (10 attempts, configurable via a new `--port-shift-max` flag).
   - Keep the trio related: choose the smallest `n >= 0` such that `18400+n`, `18401+n`, `18402+n` are **all** free, so REST = base, WS = base+1, FS = base+2 and the WS port-substitution rule (`..\Wander-Memory\web\app\src\api\ws.ts`) keeps working.
   - Existing `--port 0` / `--fs-port 0` (ephemeral, used by tests) is unchanged.
2. **Publish the bound ports** — the SPA-served `config.js` already reports the *bound* endpoints (`window.__WM_ENDPOINTS__` `{apiBase, wsUrl}` and `window.__WM_FS_ENDPOINTS__` `{fsApiBase}`, see `..\Wander-Memory\web\app\src\api\endpoints.ts` / `fs_endpoints.ts`); keep it. Add a machine-readable channel for Hermes:
   - a ports file, e.g. `<data_dir>/wander_memory_ports.json` → `{"api": 18400+n, "ws": 18401+n, "fs": 18402+n}`, and/or
   - a single stdout line on startup, e.g. `WM_PORTS=18400,18401,18402` (with the *bound* values).
3. **Health probe stays authoritative** — `GET /v1/health` on the bound REST port already exists; any client can probe candidates and trust the first responsive one.

## L.3 Frontend Discovery (Hermes `web/src/lib/wander-memory/endpoints.ts`)

Resolution precedence (highest first):
1. Env vars — `WANDER_MEMORY_API_ORIGIN`, `WANDER_MEMORY_WS_URL`, `WANDER_MEMORY_FS_ORIGIN` (explicit override, unchanged).
2. Hermes `ui-store` overrides saved in the Status view (unchanged).
3. **Port-shift discovery** (new):
   - If a ports file / stdout line is available (bundled or local run), read the bound ports and build the origins.
   - Else probe the range `[18400..18409]` with `GET /v1/health` (short timeout, e.g. 300 ms); first success wins → `apiOrigin`; `wsUrl` = same host, port `apiPort + 1` (keeps the WS substitution rule); `fsOrigin` = `apiPort + 2`.
   - Cache the result in the `ui-store` so the Status view can display the actual bound ports and re-discover after a backend restart (`resetWanderMemoryClient()`).
4. Defaults `18400/18401/18402` — last resort only.

## L.4 Bundled Mode (Phase 8 / G.2, if MemOS is managed by Rust)

The Rust spawner reads the bound ports from the child's stdout line or the ports file, then exposes them to the frontend via a Tauri command (e.g. `wander_memory_get_ports`) or by writing the `ui-store` values directly. The frontend never hard-codes 18400/18401/18402.

## L.5 Vite Dev Proxy

`web/vite.config.ts` `/v1` and `/v1/fs` targets resolve through the same discovery (env override → ports file/probe → defaults) at config load; see Phase 7 and Appendix G.1.

## L.6 CSP

Shifted ports remain on `127.0.0.1` / `localhost`, so the existing `connect-src` allowlist (`http://127.0.0.1:*`, `ws://127.0.0.1:*`, `wss://127.0.0.1:*`, `ws://localhost:*`, `wss://localhost:*`) covers any shifted port — **no CSP change needed** (Appendix G.3).

## L.7 Tests

- **Backend** (`..\Wander-Memory`): unit test that occupying the default ports (bind a dummy socket) makes all three services shift coherently (REST/WS/FS offset preserved); test clean failure when the whole range is exhausted.
- **Frontend**: `endpoints.test.ts` — ports-file discovery, health-probe discovery, fallback to defaults; `rest.test.ts` — client talks to the discovered origin.
- **E2E / manual**: occupy 18400 with another process (e.g. `python -m http.server 18400`), start Wander-Memory, verify the `Wander 记忆` views connect to the shifted ports and the Status view shows the real bound ports.
