# Plans Index — Feature → Plan File Map

Source: `D:/hermes-agent-cn/features_report.md`. One plan file per feature bullet.
Status: **all 110 plan files written & template-verified** — every row below resolves to `plans/<slug>.md` on disk; a `Status` column shows the verification mark.

## Verification summary

- 110/110 expected plan files exist (0 missing).
- Total plan content: ~37,000 lines across the 110 files.
- Infrastructure files alongside: `README.md` (conventions + mandatory template), `_PROMPT_TEMPLATE.md` (subagent task template), `_INDEX.md` (this file).
- Each plan follows the 11-section template (Summary / Current Python implementation / Target TS design / Data models / Third-party library strategy / Desktop integration / WS-removal path / Migration phases / Risks / Test strategy / Reference links).
- Third-party TS gaps were researched against `D:/kimi-code` (Moonshot Kimi Code CLI monorepo) and each plan's §5 cites kimi-code evidence or explicitly marks the module as from-scratch.
- Common cross-cutting findings surfaced by the subagents (see individual plans):
  - Webview constraints (no TCP bind, no child_process, no fs, CSP) push OS-level work (HTTP listeners, stdio MCP, PTY, SQLite, git, credential storage) into Rust Tauri commands/sidecars.
  - FTS5 CJK bigram, MoA, kanban, curator, goal judge, checkpoints, wake word, and most messaging-platform adapters have **no** kimi-code/npm equivalent and must be ported from scratch.
  - Several spec test paths in `features_report.md` do not exist as written (e.g. `test_session_search.py`, `test_toolsets.py` under `tests/tools/`, `test_document_extraction*.py`, `test_web_server_session_search.py` naming); plans cite the real parity files.

---

## Section 1 — Core agent capabilities
| # | Slug (file) | Feature | Status |
|---|---|---|---|
| 1 | `agent-loop-llm-adapters` | Unified agent core: agent loop, LLM adapters & sessions  | done |
| 2 | `session-lifecycle` | Session lifecycle (/new /reset /clear /history /save /resume /sessions /switch /title /branch /fork /retry /undo /stop /queue /steer /background /handoff)  | done |
| 3 | `sqlite-fts5-session-search` | SQLite persistence with FTS5 session search (CJK bigram)  | done |
| 4 | `model-switching` | Model switching (per-session/global/once, provider switch, aliases)  | done |
| 5 | `context-compression-prompt-caching` | Context compression & prompt caching  | done |
| 6 | `reasoning-fast-approvals-yolo` | Reasoning / fast / approvals / YOLO  | done |
| 7 | `mixture-of-agents` | Mixture of Agents (MoA) / /moa / /council  | done |
| 8 | `context-files` | Context files (.hermes.md, AGENTS.md chain, CLAUDE.md, SOUL.md, .cursorrules)  | done |
| 9 | `context-references` | Context references (@file @folder @diff @staged @git:N @url)  | done |
| 10 | `checkpoints-rollback` | Checkpoints & rollback (/rollback /snapshot /diff)  | done |
| 11 | `context-usage-visibility` | Context usage visibility (/context /status /usage /insights)  | done |
| 12 | `built-in-bounded-memory` | Built-in bounded memory (MEMORY.md / USER.md, memory tool, approval gate)  | done |
| 13 | `learning-journey` | Learning Journey (/journey /learning /memory-graph)  | done |
| 14 | `session-search-recall` | Session search & recall (session_search tool, cross-session recall)  | done |
| 15 | `external-memory-providers` | External memory providers (Honcho, OpenViking, Mem0, Hindsight, Holographic, RetainDB, ByteRover, Supermemory)  | done |
| 16 | `skills-system` | Skills system (progressive disclosure L0→L2)  | done |
| 17 | `skills-slash-commands-stacking` | Skills as slash commands & stacking; skill bundles  | done |
| 18 | `self-improvement-loop` | Self-improvement loop (/refine /learn, background review)  | done |
| 19 | `skills-hub-registries` | Skills Hub / registries (online install)  | done |
| 20 | `skill-authoring-standards` | Skill authoring standards (SKILL.md lint, CI)  | done |
| 21 | `tools-toolsets` | ~83 built-in tools grouped into toolsets  | done |
| 22 | `tool-categories` | Tool categories (todo, clarify, execute_code, delegate_task, cronjob, ha_*, MCP)  | done |
| 23 | `terminal-backends` | Terminal backends (local, Docker, SSH, Singularity, Modal, Daytona, Vercel)  | done |
| 24 | `platform-toolsets` | Platform toolsets (hermes-cli/acp/api-server/cron/webhook/gateway)  | done |
| 25 | `dynamic-toolsets` | Dynamic toolsets (mcp-<server>, plugin, custom, wildcard)  | done |
| 26 | `tool-search` | Tool Search (tool_search/tool_describe/tool_call bridge)  | done |
| 27 | `personality-soul` | Personality / SOUL.md (/personality, 14 personalities, system_prompt override)  | done |
| 28 | `skins-themes` | Skins & themes (CLI skins, YAML, colors)  | done |
| 29 | `plugins` | Plugins (general plugins, memory providers, context engines, model providers)  | done |
| 30 | `profiles` | Profiles (isolated instances, export/import, distributions)  | done |
| 31 | `pets-petdex` | Pets / Petdex (animated mascots, /pet /hatch)  | done |

## Section 2 — Automation
| # | Slug (file) | Feature | Status |
|---|---|---|---|
| 32 | `cron-scheduled-tasks` | Cron / scheduled tasks (cronjob tool, scheduler, ledger, blueprints)  | done |
| 33 | `subagent-delegation` | Subagent delegation (delegate_task, swarm, worktree, async)  | done |
| 34 | `code-execution` | Code execution (execute_code, daemon pool, resource limits)  | done |
| 35 | `event-hooks` | Event hooks (gateway hooks, plugin hooks, shell hooks, outbound webhooks)  | done |
| 36 | `batch-processing` | Batch processing (batch_runner, trajectories, checkpoint resume)  | done |
| 37 | `kanban-multi-agent-board` | Kanban multi-agent board (14 tools, dispatcher, worker lanes)  | done |
| 38 | `session-heartbeat` | Session heartbeat (/heartbeat, idle prompts)  | done |
| 39 | `goals-ralph-loop` | Goals (Ralph loop) /goal /subgoal /goal gate /goal wait  | done |
| 40 | `deliverable-mode` | Deliverable mode (gateway auto-upload of generated files)  | done |
| 41 | `curator` | Curator (background skill maintenance)  | done |
| 42 | `automation-helpers` | Automation helpers (/suggestions /blueprint webhook send)  | done |

## Section 3 — Media & web
| # | Slug (file) | Feature | Status |
|---|---|---|---|
| 43 | `browser-automation` | Browser automation (Browserbase, Browser Use, Camofox, Lightpanda, CDP, agent-browser)  | done |
| 44 | `vision-image-paste` | Vision & image paste (/paste, vision_analyze, multi-image)  | done |
| 45 | `image-generation` | Image generation (image_generate via FAL + plugin backends)  | done |
| 46 | `video` | Video (video_generate, xai_video_edit/extend, video_analyze)  | done |
| 47 | `tts-voice-messages` | TTS / voice messages (11 providers, streaming, voice bubbles)  | done |
| 48 | `voice-mode` | Voice mode (push-to-talk, silence detect, STT, barge-in)  | done |
| 49 | `wake-word` | Wake word ("Hey Hermes" hotword)  | done |
| 50 | `web-search-extract` | Web search & extract (Firecrawl, SearXNG, Brave, DDG, Tavily, Exa, Parallel, xAI)  | done |
| 51 | `x-search` | X (Twitter) search (x_search via xAI Responses API)  | done |
| 52 | `spotify` | Spotify (7 tools, PKCE OAuth)  | done |
| 53 | `google-meet` | Google Meet (bundled plugin)  | done |
| 54 | `home-assistant` | Home Assistant (ha_* toolset)  | done |

## Section 4 — Integrations
| # | Slug (file) | Feature | Status |
|---|---|---|---|
| 55 | `mcp` | MCP (stdio+HTTP, OAuth, catalog, dynamic toolsets, hermes as MCP server)  | done |
| 56 | `provider-routing` | Provider routing (sub-provider control, whitelist/blacklist/priority)  | done |
| 57 | `fallback-providers` | Fallback providers (cross-provider failover, aux chains)  | done |
| 58 | `credential-pools` | Credential pools (rotation, error-driven, auto-discovery, hermes auth)  | done |
| 59 | `api-server` | API server (OpenAI-compatible /v1/chat/completions, /v1/responses, runs, jobs, sessions)  | done |
| 60 | `acp-ide-integration` | ACP / IDE integration (stdio server, approvals, editor workdir)  | done |
| 61 | `lsp-semantic-diagnostics` | LSP semantic diagnostics (pyright, tsserver, gopls, ~20 servers)  | done |
| 62 | `document-extraction` | Document extraction (.ipynb .docx .xlsx PDF Office OpenDocument RTF/ePub)  | done |
| 63 | `subscription-proxy` | Subscription proxy (hermes proxy start, OpenAI-compatible)  | done |
| 64 | `nous-tool-gateway` | Nous Tool Gateway (Portal subscription: web search, image gen, TTS, browser)  | done |
| 65 | `codex-app-server-runtime` | Codex app-server runtime (/codex-runtime)  | done |
| 66 | `egress-proxy-secrets-import` | Egress proxy / secrets / import (hermes egress, secrets, import-agent)  | done |
| 67 | `observability` | Observability (OTLP exporter, gateway/cron health exports, redaction)  | done |

## Section 5 — Messaging platforms (gateway)
| # | Slug (file) | Feature | Status |
|---|---|---|---|
| 68 | `messaging-gateway-core` | Gateway core (one process all platforms, sessions, slash admin/user split)  | done |
| 69 | `telegram-platform` | Telegram  | done |
| 70 | `discord-platform` | Discord  | done |
| 71 | `slack-platform` | Slack  | done |
| 72 | `whatsapp-platform` | WhatsApp / WhatsApp Cloud  | done |
| 73 | `signal-platform` | Signal  | done |
| 74 | `sms-twilio-platform` | SMS (Twilio)  | done |
| 75 | `email-platform` | Email  | done |
| 76 | `matrix-platform` | Matrix  | done |
| 77 | `mattermost-platform` | Mattermost  | done |
| 78 | `irc-platform` | IRC  | done |
| 79 | `line-platform` | LINE  | done |
| 80 | `dingtalk-platform` | DingTalk  | done |
| 81 | `feishu-lark-platform` | Feishu / Lark  | done |
| 82 | `wecom-platform` | WeCom / WeCom Callback  | done |
| 83 | `weixin-platform` | Weixin (WeChat)  | done |
| 84 | `qqbot-platform` | QQ / QQ Bot  | done |
| 85 | `yuanbao-platform` | Yuanbao (Tencent)  | done |
| 86 | `teams-platform` | Microsoft Teams  | done |
| 87 | `bluebubbles-platform` | BlueBubbles (iMessage)  | done |
| 88 | `photon-platform` | Photon (iMessage)  | done |
| 89 | `ntfy-platform` | ntfy  | done |
| 90 | `raft-platform` | Raft  | done |
| 91 | `simplex-platform` | SimpleX  | done |
| 92 | `google-chat-platform` | Google Chat  | done |
| 93 | `homeassistant-messaging-platform` | Home Assistant (messaging)  | done |
| 94 | `webhooks-platform` | Webhooks  | done |
| 95 | `hermes-relay` | Hermes Relay (connector system)  | done |
| 96 | `buzz-nostr-platform` | Buzz (Nostr)  | done |
| 97 | `msgraph-webhook-platform` | MSGraph Webhook  | done |

## Section 6 — CLI / TUI / Dashboard / Desktop
| # | Slug (file) | Feature | Status |
|---|---|---|---|
| 98 | `cli-commands` | CLI commands (hermes chat/model/... global flags)  | done |
| 99 | `slash-commands` | Slash commands (central COMMAND_REGISTRY shared by CLI & messaging)  | done |
| 100 | `tui` | TUI (terminal UI; replacement by React UI)  | done |
| 101 | `web-dashboard` | Web dashboard (Status/Chat/Config/... auth, REST API surface)  | done |
| 102 | `desktop-electron-app` | Desktop (Electron app, hermes serve, desktop_ui + project toolsets, Projects)  | done |

## Section 7 — Fork-specific features (Hermes-CN-Core)
| # | Slug (file) | Feature | Status |
|---|---|---|---|
| 103 | `dashboard-api-cn` | Dashboard API for CN Desktop (upload, fs/list, mcp-servers, active profile, media API)  | done |
| 104 | `sse-post-gateway-transport` | SSE + POST gateway transport (/api/v2/events, /api/v2/rpc, un-gated /api/ws)  | done |
| 105 | `cn-provider-metadata` | Chinese model provider metadata (ARK, Qianfan, Hunyuan, SiliconFlow, ...)  | done |
| 106 | `windows-installer-runtime-packaging` | Windows installer & runtime packaging (install.ps1, PyInstaller runtime)  | done |
| 107 | `windows-in-process-fallbacks` | Windows in-process fallbacks (search_files w/o ripgrep, PATH refresh)  | done |
| 108 | `agent-robustness-patches` | Agent robustness patches (dup-tool-call breaker, empty-key guard, streaming fixes)  | done |
| 109 | `terminal-ergonomics` | Terminal ergonomics (pattern waiting, inactivity timeout, output export, persistent shells)  | done |
| 110 | `dashboard-smoke-check` | Dashboard smoke check (hermes dashboard --no-open)  | done |

Total: 110 plan files (+ this index + README).