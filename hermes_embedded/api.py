"""Complete FFI surface for the embedded runtime (refactor_report.md §4 Phase 4
延伸, §3.7 Hard FFI).

Every REST route the desktop api_proxy used to forward over HTTP, and every
JSON-RPC gateway method, has a direct-call entry here. The Rust side
(src/embedded/ffi.rs) registers these names and enforces 100% coverage.

Input/output contract
---------------------
- ``handle_rpc(method, params_json, ctx_json) -> Any`` is the unified entry:
  ``method`` names either a REST router (``get_version``, ``handle_session``,
  ...) or a JSON-RPC method (``session.create``, ``prompt.submit``, ...).
  ``params_json`` / ``ctx_json`` are JSON strings (serde JSON on the Rust
  side); the result is JSON-serializable (Rust round-trips through
  ``json.dumps``).
- ``params`` carries the merged request: ``path`` (normalized, no query),
  ``method``, ``query`` (parsed query-string dict), plus any JSON body fields.
- ``ctx`` carries ``hermesHome`` / ``sessionToken`` / ``profile`` — the
  header/cookie semantics of the old HTTP proxy, minus the transport.

Self-contained reference package
--------------------------------
The reference ``hermes_embedded`` package is deliberately self-contained (see
docs/embedded-python.md): it must work with only the stdlib + the packages the
managed runtime ships, without importing ``hermes_cli`` (Core lives in the
PyInstaller payload in production; the dev package has no Core on sys.path).
Handlers below mirror the Core HTTP handlers' response shapes exactly
(packages/protocol/src/hermes-api.ts), implementing real logic where it is
pure (fs, logs, env, upload, mcp-servers summary) and returning
shape-correct empty/setup states where the real work needs an external
service (memory providers, OAuth, ElevenLabs). Production wiring that imports
the real Core handlers is the Core-side follow-up in refactor_plan.md §4
Phase B.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import time
from pathlib import Path
from typing import Any

# Rust src/embedded/mod.rs::FFI_SURFACE_VERSION must match this exactly.
FFI_SURFACE_VERSION = "0.2.0"

# Module-level attribute the Rust bridge reads at startup
# (`api.getattr("ffi_surface_version")` — must be a str, not a function).
ffi_surface_version = FFI_SURFACE_VERSION

# Synthetic version reported by get_version() in the embedded runtime. The
# desktop version gate (EXPECTED_BACKEND_VERSION in web/src/lib/build-info.ts)
# reads this directly from Python — no /api/version HTTP request is involved.
# Keep in sync with build-info.ts.
EMBEDDED_CORE_VERSION = "0.8.0-rc4"


def get_version() -> str:
    """GET /api/version — backend version string."""
    return EMBEDDED_CORE_VERSION


def get_gateway_config() -> dict[str, Any]:
    """GET /api/gateway — gateway runtime config."""
    return {
        "version": EMBEDDED_CORE_VERSION,
        "transport": "embedded-ffi",
        "http": False,
        "ws": False,
    }


def get_status(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """GET /api/status — dashboard status.

    Mirrors Core hermes_cli/web_server.py /api/status: the frontend zod
    StatusResponse (packages/protocol/src/hermes-api.ts) requires version,
    release_date, gateway_running, gateway_state, gateway_exit_reason,
    gateway_updated_at and active_sessions. hermes_home / config_path /
    env_path come from the REAL hermes home carried in the FFI ctx.
    """
    home = _hermes_home(ctx)
    config = _load_config_dict(home)
    config_version = _as_int(config.get("_config_version"), 0) or None
    profile = ctx.get("profile") or None
    status: dict[str, Any] = {
        "version": EMBEDDED_CORE_VERSION,
        "release_date": "embedded",
        "hermes_home": str(home),
        "config_path": str(home / "config.yaml"),
        "env_path": str(home / ".env"),
        # Embedded mode runs the gateway in-process: report a healthy,
        # non-draining steady state (no subprocess PID / health URL exist).
        "gateway_running": True,
        "gateway_pid": None,
        "gateway_health_url": None,
        "gateway_state": "running",
        "gateway_exit_reason": None,
        "gateway_updated_at": None,
        "active_sessions": 0,
        "active_agents": 0,
        "gateway_busy": False,
        "gateway_drainable": False,
        "restart_drain_timeout": None,
        "can_update_hermes": False,
        "auth_required": False,
        "mode": "embedded",
        "runtime": "in-process",
        "ffiSurfaceVersion": FFI_SURFACE_VERSION,
    }
    if config_version is not None:
        status["config_version"] = config_version
        status["latest_config_version"] = config_version
    if profile:
        status["profile"] = profile
    return status


def get_config(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """GET /api/config — the REAL config from <hermes_home>/config.yaml.

    Mirrors Core's /api/config handler (web_server.py): load_config() then
    strip internal ``_``-prefixed keys. The frontend ConfigResponse is a
    z.record, so the raw dict parses as-is; missing file / no yaml → {}.
    """
    home = _hermes_home(ctx)
    config = _load_config_dict(home)
    return {k: v for k, v in config.items() if not str(k).startswith("_")}


# ── Shared helpers ──────────────────────────────────────────────────────


def _hermes_home(ctx: dict[str, Any]) -> Path:
    """Resolve the hermes home root from the FFI ctx (substitutes HERMES_HOME)."""
    raw = ctx.get("hermesHome") or ctx.get("hermes_home") or str(Path.home() / ".hermes")
    return Path(raw)


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _read_env_file(home: Path) -> dict[str, str]:
    """Parse a .env file into {KEY: VALUE}. Mirrors dotenv semantics loosely."""
    env_path = home / ".env"
    result: dict[str, str] = {}
    if not env_path.is_file():
        return result
    try:
        for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            if key:
                result[key] = value.strip().strip('"').strip("'")
    except OSError:
        return {}
    return result


def _write_env_file(home: Path, env: dict[str, str]) -> None:
    env_path = home / ".env"
    lines = [f"{key}={value}" for key, value in sorted(env.items())]
    env_path.parent.mkdir(parents=True, exist_ok=True)
    env_path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def _load_yaml_file(path: Path) -> Any:
    """Parse a YAML file; returns None when yaml is unavailable or read fails.

    yaml is optional in the embedded interpreter (guarded import, same
    pattern as handle_mcp_servers); config.yaml is always YAML, never JSON.
    """
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    try:
        import yaml  # available in the managed runtime
    except ImportError:
        return None
    try:
        return yaml.safe_load(text)
    except Exception:
        return None


def _load_config_dict(home: Path) -> dict[str, Any]:
    """Load <hermes_home>/config.yaml as a dict ({} on any failure)."""
    loaded = _load_yaml_file(home / "config.yaml")
    return loaded if isinstance(loaded, dict) else {}


def _redact(value: str) -> str:
    """Mirror Core's redact_key: keep a short prefix + length hint."""
    if not value:
        return ""
    if len(value) <= 8:
        return "•" * len(value)
    return f"{value[:4]}…({len(value) - 8} hidden)…{value[-4:]}"


def _log_files() -> dict[str, str]:
    """Log filename map (Core hermes_cli.logs.LOG_FILES)."""
    return {
        "agent": "agent.log",
        "errors": "errors.log",
        "gateway": "gateway.log",
        "desktop": "desktop.log",
        "cron": "cron.log",
        "install": "install.log",
        "update": "update.log",
    }


def _read_tail(path: Path, lines: int) -> list[str]:
    """Read the last N lines of a text file (binary-safe, size-bounded)."""
    try:
        data = path.read_bytes()
    except OSError:
        return []
    if len(data) > 8 * 1024 * 1024:
        data = data[-8 * 1024 * 1024:]
    text = data.decode("utf-8", errors="replace")
    return text.splitlines()[-lines:]


def _query(params: dict[str, Any]) -> dict[str, Any]:
    return params.get("query") if isinstance(params.get("query"), dict) else {}


def _safe_upload_name(name: Any) -> str:
    raw = str(name or "attachment")
    raw = os.path.basename(raw.replace("\\", "/"))
    return re.sub(r"[^\w.\- ]", "_", raw).strip() or "attachment"


def _unique_upload_path(directory: Path, filename: str) -> Path:
    target = directory / filename
    if not target.exists():
        return target
    stem, _, suffix = filename.rpartition(".")
    for i in range(1, 1000):
        candidate = directory / f"{stem}-{i}{suffix if suffix else ''}"
        if not candidate.exists():
            return candidate
    return directory / f"{stem}-{int(time.time())}{suffix if suffix else ''}"


# ── Sessions (/api/sessions*) ───────────────────────────────────────────


def _empty_session_summary(session_id: str) -> dict[str, Any]:
    """Shape-complete SessionSummary row (packages/protocol hermes-api.ts)."""
    return {
        "id": session_id,
        "model": "",
        "title": None,
        "started_at": 0,
        "ended_at": None,
        "message_count": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "estimated_cost_usd": None,
        "is_active": False,
    }


def handle_sessions(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """/api/sessions* — plural session family (list/detail/messages/search/delete)."""
    path = params.get("path", "")
    method = str(params.get("method") or "GET").upper()
    q = _query(params)

    if path == "/api/sessions/search":
        return {"results": []}
    if not path.startswith("/api/sessions/"):
        # Exact /api/sessions (list).
        limit = _as_int(q.get("limit"), 50)
        offset = _as_int(q.get("offset"), 0)
        return {
            "sessions": [],
            "total": 0,
            "limit": max(0, limit),
            "offset": max(0, offset),
        }

    rest = path[len("/api/sessions/"):]
    parts = rest.split("/")
    session_id = parts[0]

    if len(parts) >= 2 and parts[1] == "messages":
        return {"session_id": session_id, "messages": [], "ui_messages": []}
    if len(parts) >= 2 and parts[1] == "archive":
        return {"ok": True, "archived": method == "POST"}
    if method in ("DELETE", "POST", "PATCH", "PUT"):
        # delete / archive / rename / export / prune — shape-ok for all.
        return {"ok": True}
    return {"session": _empty_session_summary(session_id)}


# ── Profiles (/api/profiles exact) ──────────────────────────────────────


def handle_profiles_exact(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """GET/POST /api/profiles — exact list/create (not /api/profiles/ subroutes).

    GET lists real on-disk profiles: ``default`` is the hermes root itself and
    named profiles live under ``<root>/profiles/<name>/`` (Core profiles.py).
    POST creates a named profile directory (shape-matching Core's
    ProfileCreateResponse; skill/model/MCP seeding is a Core follow-up).
    """
    method = str(params.get("method") or "GET").upper()
    home = _hermes_home(ctx)

    if method == "POST":
        body_name = str(params.get("name") or "new-profile")
        profile_dir = home / "profiles" / body_name.lower()
        try:
            profile_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            return {"ok": False, "error": getattr(exc, "strerror", None) or "create-profile-failed"}
        return {
            "ok": True,
            "name": body_name,
            "path": str(profile_dir),
            "model_set": False,
            "mcp_written": 0,
            "skills_disabled": 0,
        }

    # GET — real directory scan.
    active = ctx.get("profile") or "default"
    sticky = ""
    active_path = home / "active_profile"
    if active_path.is_file():
        sticky = active_path.read_text(encoding="utf-8", errors="replace").strip() or ""

    profiles: list[dict[str, Any]] = []
    default_row: dict[str, Any] = {
        "name": "default",
        "path": str(home),
        "is_default": True,
        "model": None,
        "provider": None,
        "has_env": (home / ".env").is_file(),
        "skill_count": 0,
        "gateway_running": True,
    }
    if active == "default":
        default_row["description"] = ""
        default_row["description_auto"] = False
        profiles.append(default_row)

    profiles_root = home / "profiles"
    if profiles_root.is_dir():
        for entry in sorted(profiles_root.iterdir(), key=lambda p: p.name.lower()):
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            profiles.append({
                "name": entry.name,
                "path": str(entry),
                "is_default": False,
                "model": None,
                "provider": None,
                "has_env": (entry / ".env").is_file(),
                "skill_count": 0,
                "gateway_running": True,
                "description": "",
                "description_auto": False,
                "has_alias": False,
            })

    if active != "default" and not any(p["name"] == active for p in profiles):
        profiles.append({
            "name": active,
            "path": str(home / "profiles" / active),
            "is_default": False,
            "model": None,
            "provider": None,
            "has_env": (home / "profiles" / active / ".env").is_file(),
            "skill_count": 0,
            "gateway_running": True,
        })
    if sticky and sticky != "default" and not any(p["name"] == sticky for p in profiles):
        profiles.append({
            "name": sticky,
            "path": str(home / "profiles" / sticky),
            "is_default": False,
            "model": None,
            "provider": None,
            "has_env": (home / "profiles" / sticky / ".env").is_file(),
            "skill_count": 0,
            "gateway_running": True,
        })

    return {"profiles": profiles}



# ── Env var catalog (mirrors Core config_defaults.OPTIONAL_ENV_VARS) ────
#
# Snapshot of Core hermes_cli/config_defaults.py::OPTIONAL_ENV_VARS (the
# /api/env catalog). Kept as a literal so the embedded package stays
# stdlib-only; refresh it when Core's catalog changes.
_ENV_CATALOG: dict[str, dict[str, Any]] = {
    'NOUS_BASE_URL': {'description': 'Nous Portal base URL override', 'category': 'provider', 'advanced': True},
    'OPENROUTER_API_KEY': {'description': 'OpenRouter API key (for vision, web scraping helpers, and MoA)', 'url': 'https://openrouter.ai/keys', 'password': True, 'tools': ['vision_analyze'], 'category': 'provider', 'advanced': True},
    'GOOGLE_API_KEY': {'description': 'Google AI Studio API key (also recognized as GEMINI_API_KEY)', 'url': 'https://aistudio.google.com/app/apikey', 'password': True, 'category': 'provider', 'advanced': True},
    'GEMINI_API_KEY': {'description': 'Google AI Studio API key (alias for GOOGLE_API_KEY)', 'url': 'https://aistudio.google.com/app/apikey', 'password': True, 'category': 'provider', 'advanced': True},
    'GEMINI_BASE_URL': {'description': 'Google AI Studio base URL override', 'category': 'provider', 'advanced': True},
    'VERTEX_CREDENTIALS_PATH': {'description': 'Path to a Google Cloud service account JSON for Vertex AI (Gemini). Vertex uses OAuth2, not a static API key — this points at the credentials Hermes mints short-lived tokens from. Falls back to GOOGLE_APPLICATION_CREDENTIALS, then to ADC (gcloud auth application-default login). Set project/region under vertex: in config.yaml.', 'url': 'https://cloud.google.com/iam/docs/keys-create-delete', 'category': 'provider', 'advanced': True},
    'XAI_API_KEY': {'description': 'xAI API key', 'url': 'https://console.x.ai/', 'password': True, 'category': 'provider', 'advanced': True},
    'XAI_BASE_URL': {'description': 'xAI base URL override', 'category': 'provider', 'advanced': True},
    'NVIDIA_API_KEY': {'description': 'NVIDIA NIM API key (build.nvidia.com or local NIM endpoint)', 'url': 'https://build.nvidia.com/', 'password': True, 'category': 'provider', 'advanced': True},
    'NVIDIA_BASE_URL': {'description': 'NVIDIA NIM base URL override (e.g. http://localhost:8000/v1 for local NIM)', 'category': 'provider', 'advanced': True},
    'LM_API_KEY': {'description': 'LM Studio bearer token for auth-enabled local servers', 'password': True, 'category': 'provider', 'advanced': True},
    'LM_BASE_URL': {'description': 'LM Studio base URL override', 'category': 'provider', 'advanced': True},
    'GLM_API_KEY': {'description': 'Z.AI / GLM API key (also recognized as ZAI_API_KEY / Z_AI_API_KEY)', 'url': 'https://z.ai/', 'password': True, 'category': 'provider', 'advanced': True},
    'ZAI_API_KEY': {'description': 'Z.AI API key (alias for GLM_API_KEY)', 'url': 'https://z.ai/', 'password': True, 'category': 'provider', 'advanced': True},
    'Z_AI_API_KEY': {'description': 'Z.AI API key (alias for GLM_API_KEY)', 'url': 'https://z.ai/', 'password': True, 'category': 'provider', 'advanced': True},
    'GLM_BASE_URL': {'description': 'Z.AI / GLM base URL override', 'category': 'provider', 'advanced': True},
    'KIMI_API_KEY': {'description': 'Kimi / Moonshot API key', 'url': 'https://platform.moonshot.cn/', 'password': True, 'category': 'provider', 'advanced': True},
    'KIMI_BASE_URL': {'description': 'Kimi / Moonshot base URL override', 'category': 'provider', 'advanced': True},
    'KIMI_CN_API_KEY': {'description': 'Kimi / Moonshot China API key', 'url': 'https://platform.moonshot.cn/', 'password': True, 'category': 'provider', 'advanced': True},
    'STEPFUN_API_KEY': {'description': 'StepFun Step Plan API key', 'url': 'https://platform.stepfun.com/', 'password': True, 'category': 'provider', 'advanced': True},
    'STEPFUN_BASE_URL': {'description': 'StepFun Step Plan base URL override', 'category': 'provider', 'advanced': True},
    'ARCEEAI_API_KEY': {'description': 'Arcee AI API key', 'url': 'https://chat.arcee.ai/', 'password': True, 'category': 'provider', 'advanced': True},
    'ARCEE_BASE_URL': {'description': 'Arcee AI base URL override', 'category': 'provider', 'advanced': True},
    'GMI_API_KEY': {'description': 'GMI Cloud API key', 'url': 'https://www.gmicloud.ai/', 'password': True, 'category': 'provider', 'advanced': True},
    'GMI_BASE_URL': {'description': 'GMI Cloud base URL override', 'category': 'provider', 'advanced': True},
    'ACTUAL_API_KEY': {'description': 'Actual Computer inference key (ac_...)', 'url': 'https://actual.inc/user/keys', 'password': True, 'category': 'provider', 'advanced': True},
    'ACTUAL_BASE_URL': {'description': 'Actual Computer base URL override (set to http://127.0.0.1:8080 for the local offline daemon)', 'category': 'provider', 'advanced': True},
    'FIREWORKS_API_KEY': {'description': 'Fireworks AI API key', 'url': 'https://app.fireworks.ai/settings/users/api-keys', 'password': True, 'category': 'provider', 'advanced': True},
    'MINIMAX_API_KEY': {'description': 'MiniMax API key (international)', 'url': 'https://www.minimax.io/', 'password': True, 'category': 'provider', 'advanced': True},
    'MINIMAX_BASE_URL': {'description': 'MiniMax base URL override', 'category': 'provider', 'advanced': True},
    'MINIMAX_CN_API_KEY': {'description': 'MiniMax API key (China endpoint)', 'url': 'https://www.minimaxi.com/', 'password': True, 'category': 'provider', 'advanced': True},
    'MINIMAX_CN_BASE_URL': {'description': 'MiniMax (China) base URL override', 'category': 'provider', 'advanced': True},
    'DEEPSEEK_API_KEY': {'description': 'DeepSeek API key for direct DeepSeek access', 'url': 'https://platform.deepseek.com/api_keys', 'password': True, 'category': 'provider'},
    'DEEPSEEK_BASE_URL': {'description': 'Custom DeepSeek API base URL (advanced)', 'category': 'provider'},
    'DASHSCOPE_API_KEY': {'description': 'Alibaba Cloud DashScope API key (Qwen + multi-provider models)', 'url': 'https://modelstudio.console.alibabacloud.com/', 'password': True, 'category': 'provider'},
    'DASHSCOPE_BASE_URL': {'description': 'Custom DashScope base URL (default: coding-intl OpenAI-compat endpoint)', 'category': 'provider', 'advanced': True},
    'HERMES_QWEN_BASE_URL': {'description': 'Qwen Portal base URL override (default: https://portal.qwen.ai/v1)', 'category': 'provider', 'advanced': True},
    'OPENCODE_ZEN_API_KEY': {'description': 'OpenCode Zen API key (pay-as-you-go access to curated models)', 'url': 'https://opencode.ai/auth', 'password': True, 'category': 'provider', 'advanced': True},
    'OPENCODE_ZEN_BASE_URL': {'description': 'OpenCode Zen base URL override', 'category': 'provider', 'advanced': True},
    'OPENCODE_GO_API_KEY': {'description': 'OpenCode Go API key ($10/month subscription for open models)', 'url': 'https://opencode.ai/auth', 'password': True, 'category': 'provider', 'advanced': True},
    'OPENCODE_GO_BASE_URL': {'description': 'OpenCode Go base URL override', 'category': 'provider', 'advanced': True},
    'HF_TOKEN': {'description': 'Hugging Face token for Inference Providers (20+ open models via router.huggingface.co)', 'url': 'https://huggingface.co/settings/tokens', 'password': True, 'category': 'provider'},
    'HF_BASE_URL': {'description': 'Hugging Face Inference Providers base URL override', 'category': 'provider', 'advanced': True},
    'OLLAMA_API_KEY': {'description': 'Ollama Cloud API key (ollama.com — cloud-hosted open models)', 'url': 'https://ollama.com/settings', 'password': True, 'category': 'provider', 'advanced': True},
    'OLLAMA_BASE_URL': {'description': 'Ollama Cloud base URL override (default: https://ollama.com/v1)', 'category': 'provider', 'advanced': True},
    'XIAOMI_API_KEY': {'description': 'Xiaomi MiMo API key for MiMo models (mimo-v2.5-pro, mimo-v2.5, mimo-v2-pro, mimo-v2-omni, mimo-v2-flash)', 'url': 'https://platform.xiaomimimo.com', 'password': True, 'category': 'provider'},
    'XIAOMI_BASE_URL': {'description': 'Xiaomi MiMo base URL override (default: https://api.xiaomimimo.com/v1)', 'category': 'provider', 'advanced': True},
    'UPSTAGE_API_KEY': {'description': 'Upstage API key for Solar LLM models', 'url': 'https://console.upstage.ai/api-keys', 'password': True, 'category': 'provider'},
    'UPSTAGE_BASE_URL': {'description': 'Upstage base URL override (default: https://api.upstage.ai/v1)', 'category': 'provider', 'advanced': True},
    'AWS_REGION': {'description': 'AWS region for Bedrock API calls (e.g. us-east-1, eu-central-1)', 'url': 'https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-regions.html', 'category': 'provider', 'advanced': True},
    'AWS_PROFILE': {'description': 'AWS named profile for Bedrock authentication (from ~/.aws/credentials)', 'category': 'provider', 'advanced': True},
    'AZURE_FOUNDRY_API_KEY': {'description': 'Azure Foundry API key for custom Azure endpoints', 'url': 'https://ai.azure.com/', 'password': True, 'category': 'provider'},
    'AZURE_FOUNDRY_BASE_URL': {'description': "Azure Foundry base URL (set via 'hermes model' for endpoint-specific config)", 'category': 'provider', 'advanced': True},
    'EXA_API_KEY': {'description': 'Exa API key for AI-native web search and contents', 'url': 'https://exa.ai/', 'tools': ['web_search', 'web_extract'], 'password': True, 'category': 'tool'},
    'PARALLEL_API_KEY': {'description': 'Parallel API key for AI-native web search and extract', 'url': 'https://parallel.ai/', 'tools': ['web_search', 'web_extract'], 'password': True, 'category': 'tool'},
    'FIRECRAWL_API_KEY': {'description': 'Firecrawl API key for web search and scraping', 'url': 'https://firecrawl.dev/', 'tools': ['web_search', 'web_extract'], 'password': True, 'category': 'tool'},
    'FIRECRAWL_API_URL': {'description': 'Firecrawl API URL for self-hosted instances (optional)', 'category': 'tool', 'advanced': True},
    'FIRECRAWL_GATEWAY_URL': {'description': 'Exact Firecrawl tool-gateway origin override for Nous Subscribers only (optional)', 'category': 'tool', 'advanced': True},
    'TOOL_GATEWAY_DOMAIN': {'description': 'Shared tool-gateway domain suffix for Nous Subscribers only, used to derive vendor hosts, e.g. nousresearch.com -> firecrawl-gateway.nousresearch.com', 'category': 'tool', 'advanced': True},
    'TOOL_GATEWAY_SCHEME': {'description': 'Shared tool-gateway URL scheme for Nous Subscribers only, used to derive vendor hosts (`https` by default, set `http` for local gateway testing)', 'category': 'tool', 'advanced': True},
    'TOOL_GATEWAY_USER_TOKEN': {'description': 'Explicit Nous Subscriber access token for tool-gateway requests (optional; otherwise read from the Hermes auth store)', 'password': True, 'category': 'tool', 'advanced': True},
    'TAVILY_API_KEY': {'description': 'Tavily API key for AI-native web search and extract', 'url': 'https://app.tavily.com/home', 'tools': ['web_search', 'web_extract'], 'password': True, 'category': 'tool'},
    'SEARXNG_URL': {'description': 'URL of your SearXNG instance for free self-hosted web search', 'url': 'https://searxng.github.io/searxng/', 'tools': ['web_search'], 'category': 'tool'},
    'BRAVE_SEARCH_API_KEY': {'description': 'Brave Search API subscription token (free tier: 2,000 queries/mo)', 'url': 'https://brave.com/search/api/', 'tools': ['web_search'], 'password': True, 'category': 'tool'},
    'BROWSERBASE_API_KEY': {'description': 'Browserbase API key for cloud browser (optional — local browser works without this)', 'url': 'https://browserbase.com/', 'tools': ['browser_navigate', 'browser_click'], 'password': True, 'category': 'tool'},
    'BROWSERBASE_PROJECT_ID': {'description': 'Browserbase project ID (optional — only needed for cloud browser)', 'url': 'https://browserbase.com/', 'tools': ['browser_navigate', 'browser_click'], 'category': 'tool'},
    'BROWSER_USE_API_KEY': {'description': 'Browser Use API key for cloud browser (optional — local browser works without this)', 'url': 'https://browser-use.com/', 'tools': ['browser_navigate', 'browser_click'], 'password': True, 'category': 'tool'},
    'FIRECRAWL_BROWSER_TTL': {'description': 'Firecrawl browser session TTL in seconds (optional, default 300)', 'tools': ['browser_navigate', 'browser_click'], 'category': 'tool'},
    'AGENT_BROWSER_ENGINE': {'description': 'Browser engine for local mode: auto (default Chrome), lightpanda (faster, no screenshots), chrome', 'url': 'https://github.com/vercel-labs/agent-browser', 'tools': ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_vision'], 'category': 'tool', 'advanced': True},
    'CAMOFOX_URL': {'description': 'Camofox browser server URL for local anti-detection browsing (e.g. http://localhost:9377)', 'url': 'https://github.com/jo-inc/camofox-browser', 'tools': ['browser_navigate', 'browser_click'], 'category': 'tool'},
    'CAMOFOX_API_KEY': {'description': 'Optional bearer token sent as Authorization header to a remote/authenticated Camofox server', 'url': 'https://github.com/jo-inc/camofox-browser', 'tools': ['browser_navigate', 'browser_click'], 'password': True, 'category': 'tool', 'advanced': True},
    'FAL_KEY': {'description': 'FAL API key for image and video generation', 'url': 'https://fal.ai/', 'tools': ['image_generate', 'video_generate'], 'password': True, 'category': 'tool'},
    'KREA_API_KEY': {'description': 'Krea API key for Krea 2 image generation (Medium + Large)', 'url': 'https://www.krea.ai/settings/api-tokens', 'tools': ['image_generate'], 'password': True, 'category': 'tool'},
    'VOICE_TOOLS_OPENAI_KEY': {'description': 'OpenAI API key for voice transcription (Whisper) and OpenAI TTS', 'url': 'https://platform.openai.com/api-keys', 'tools': ['voice_transcription', 'openai_tts'], 'password': True, 'category': 'tool'},
    'ELEVENLABS_API_KEY': {'description': 'ElevenLabs API key for premium text-to-speech voices and Scribe transcription', 'url': 'https://elevenlabs.io/', 'tools': ['elevenlabs_tts', 'voice_transcription'], 'password': True, 'category': 'tool'},
    'MISTRAL_API_KEY': {'description': 'Mistral API key for Voxtral TTS and transcription (STT)', 'url': 'https://console.mistral.ai/', 'password': True, 'category': 'tool'},
    'PORCUPINE_ACCESS_KEY': {'description': "Picovoice access key for the Porcupine 'Hey Hermes' wake word engine (optional; openWakeWord is the free default)", 'url': 'https://console.picovoice.ai/', 'password': True, 'category': 'tool'},
    'GITHUB_TOKEN': {'description': 'GitHub token for Skills Hub (higher API rate limits, skill publish)', 'url': 'https://github.com/settings/tokens', 'password': True, 'category': 'tool'},
    'NOTION_API_KEY': {'description': 'Notion integration token (used by the `notion` skill)', 'url': 'https://www.notion.so/my-integrations', 'password': True, 'category': 'skill', 'advanced': True},
    'LINEAR_API_KEY': {'description': 'Linear personal API key (used by the `linear` skill)', 'url': 'https://linear.app/settings/account/security', 'password': True, 'category': 'skill', 'advanced': True},
    'AIRTABLE_API_KEY': {'description': 'Airtable personal access token (used by the `airtable` skill)', 'url': 'https://airtable.com/create/tokens', 'password': True, 'category': 'skill', 'advanced': True},
    'TENOR_API_KEY': {'description': 'Tenor API key for GIF search (used by the `gif-search` skill)', 'url': 'https://developers.google.com/tenor/guides/quickstart', 'password': True, 'category': 'skill', 'advanced': True},
    'HONCHO_API_KEY': {'description': 'Honcho API key for AI-native persistent memory', 'url': 'https://app.honcho.dev', 'tools': ['honcho_context'], 'password': True, 'category': 'tool'},
    'HONCHO_BASE_URL': {'description': 'Base URL for self-hosted Honcho instances (no API key needed)', 'category': 'tool'},
    'HINDSIGHT_API_KEY': {'description': 'Hindsight API key for graph-aware persistent memory', 'url': 'https://hindsight.vectorize.io', 'tools': ['hindsight_recall'], 'password': True, 'category': 'tool'},
    'HINDSIGHT_API_URL': {'description': 'Base URL for the Hindsight API (default: https://api.hindsight.vectorize.io)', 'category': 'tool', 'advanced': True},
    'SUPERMEMORY_API_KEY': {'description': 'Supermemory API key for conversation-scoped persistent memory', 'url': 'https://supermemory.ai', 'tools': ['supermemory_search'], 'password': True, 'category': 'tool'},
    'MEM0_API_KEY': {'description': 'Mem0 Platform API key for semantic persistent memory', 'url': 'https://app.mem0.ai', 'tools': ['mem0_search'], 'password': True, 'category': 'tool'},
    'RETAINDB_API_KEY': {'description': 'RetainDB API key for persistent memory', 'url': 'https://retaindb.com', 'tools': ['retaindb_search'], 'password': True, 'category': 'tool'},
    'RETAINDB_BASE_URL': {'description': 'Base URL for self-hosted RetainDB instances (default: https://api.retaindb.com)', 'category': 'tool', 'advanced': True},
    'BRV_API_KEY': {'description': 'ByteRover API key (optional, for cloud sync — local-first by default)', 'url': 'https://app.byterover.dev', 'tools': ['brv_query'], 'password': True, 'category': 'tool'},
    'OPENVIKING_API_KEY': {'description': 'OpenViking API key (leave blank for local dev mode)', 'tools': ['viking_search'], 'password': True, 'category': 'tool'},
    'OPENVIKING_ENDPOINT': {'description': 'OpenViking server URL (default: http://127.0.0.1:1933)', 'category': 'tool', 'advanced': True},
    'HERMES_LANGFUSE_PUBLIC_KEY': {'description': 'Langfuse project public key (pk-lf-...)', 'url': 'https://cloud.langfuse.com', 'category': 'tool'},
    'HERMES_LANGFUSE_SECRET_KEY': {'description': 'Langfuse project secret key (sk-lf-...)', 'url': 'https://cloud.langfuse.com', 'password': True, 'category': 'tool'},
    'HERMES_LANGFUSE_BASE_URL': {'description': 'Langfuse server URL (default: https://cloud.langfuse.com)', 'category': 'tool', 'advanced': True},
    'TELEGRAM_BOT_TOKEN': {'description': 'Complete Telegram bot token created by @BotFather (numeric bot ID followed by a colon and secret)', 'url': 'https://t.me/BotFather', 'password': True, 'category': 'messaging'},
    'TELEGRAM_ALLOWED_USERS': {'description': 'Optional comma-separated numeric Telegram user IDs allowed immediately; leave blank to approve new users through DM pairing', 'url': 'https://t.me/userinfobot', 'category': 'messaging'},
    'TELEGRAM_PROXY': {'description': 'Proxy URL for Telegram connections (overrides HTTPS_PROXY). Supports http://, https://, socks5://', 'category': 'messaging'},
    'DISCORD_BOT_TOKEN': {'description': 'Discord bot token from Developer Portal', 'url': 'https://discord.com/developers/applications', 'password': True, 'category': 'messaging'},
    'DISCORD_ALLOWED_USERS': {'description': 'Comma-separated Discord user IDs allowed to use the bot', 'category': 'messaging'},
    'DISCORD_REPLY_TO_MODE': {'description': "Discord reply threading mode: 'off' (no reply references), 'first' (reply on first message only, default), 'all' (reply on every chunk)", 'category': 'messaging'},
    'SLACK_BOT_TOKEN': {'description': 'Slack bot token (xoxb-). Get from OAuth & Permissions after installing your app. Required scopes: chat:write, app_mentions:read, channels:history, groups:history, im:history, im:read, im:write, mpim:history, mpim:read, users:read, files:read, files:write', 'url': 'https://api.slack.com/apps', 'password': True, 'category': 'messaging'},
    'SLACK_APP_TOKEN': {'description': 'Slack app-level token (xapp-) for Socket Mode. Get from Basic Information → App-Level Tokens. Also ensure Event Subscriptions include: message.im, message.channels, message.groups, message.mpim, app_mention', 'url': 'https://api.slack.com/apps', 'password': True, 'category': 'messaging'},
    'SLACK_ALLOWED_USERS': {'description': 'Comma-separated Slack member IDs allowed to use Hermes, e.g. U01ABC2DEF3. Without this, Slack may connect but deny messages by default.', 'url': 'https://api.slack.com/apps', 'category': 'messaging'},
    'MATTERMOST_URL': {'description': 'Mattermost server URL (e.g. https://mm.example.com)', 'url': 'https://mattermost.com/deploy/', 'category': 'messaging'},
    'MATTERMOST_TOKEN': {'description': 'Mattermost bot token or personal access token', 'password': True, 'category': 'messaging'},
    'MATTERMOST_ALLOWED_USERS': {'description': 'Comma-separated Mattermost user IDs allowed to use the bot', 'category': 'messaging'},
    'MATTERMOST_REQUIRE_MENTION': {'description': 'Require @mention in Mattermost channels (default: true). Set to false to respond to all messages.', 'category': 'messaging'},
    'MATTERMOST_FREE_RESPONSE_CHANNELS': {'description': 'Comma-separated Mattermost channel IDs where bot responds without @mention', 'category': 'messaging'},
    'MATRIX_HOMESERVER': {'description': 'Matrix homeserver URL (e.g. https://matrix.example.org)', 'url': 'https://matrix.org/ecosystem/servers/', 'category': 'messaging'},
    'MATRIX_ACCESS_TOKEN': {'description': 'Matrix access token (preferred over password login)', 'password': True, 'category': 'messaging'},
    'MATRIX_USER_ID': {'description': 'Matrix user ID (e.g. @hermes:example.org)', 'category': 'messaging'},
    'MATRIX_ALLOWED_USERS': {'description': 'Comma-separated Matrix user IDs allowed to use the bot (@user:server format)', 'category': 'messaging'},
    'MATRIX_REQUIRE_MENTION': {'description': 'Require @mention in Matrix rooms (default: true). Set to false to respond to all messages.', 'category': 'messaging', 'advanced': True},
    'MATRIX_FREE_RESPONSE_ROOMS': {'description': 'Comma-separated Matrix room IDs where bot responds without @mention', 'category': 'messaging', 'advanced': True},
    'MATRIX_AUTO_THREAD': {'description': 'Auto-create threads for messages in Matrix rooms (default: true)', 'category': 'messaging', 'advanced': True},
    'MATRIX_DM_AUTO_THREAD': {'description': 'Auto-create threads for DM messages in Matrix (default: false)', 'category': 'messaging', 'advanced': True},
    'MATRIX_DEVICE_ID': {'description': 'Stable Matrix device ID for E2EE persistence across restarts (e.g. HERMES_BOT)', 'category': 'messaging', 'advanced': True},
    'MATRIX_RECOVERY_KEY': {'description': 'Matrix recovery key for cross-signing verification after device key rotation (from Element: Settings → Security → Recovery Key)', 'password': True, 'category': 'messaging', 'advanced': True},
    'BLUEBUBBLES_SERVER_URL': {'description': 'BlueBubbles server URL for iMessage integration (e.g. http://192.168.1.10:1234)', 'url': 'https://bluebubbles.app/', 'category': 'messaging'},
    'BLUEBUBBLES_PASSWORD': {'description': 'BlueBubbles server password (from BlueBubbles Server → Settings → API)', 'password': True, 'category': 'messaging'},
    'BLUEBUBBLES_ALLOWED_USERS': {'description': 'Comma-separated iMessage addresses (email or phone) allowed to use the bot', 'category': 'messaging'},
    'BLUEBUBBLES_ALLOW_ALL_USERS': {'description': 'Allow all BlueBubbles users without allowlist', 'category': 'messaging'},
    'QQ_APP_ID': {'description': 'QQ Bot App ID from QQ Open Platform (q.qq.com)', 'url': 'https://q.qq.com', 'category': 'messaging'},
    'QQ_CLIENT_SECRET': {'description': 'QQ Bot Client Secret from QQ Open Platform', 'password': True, 'category': 'messaging'},
    'QQ_ALLOWED_USERS': {'description': 'Comma-separated QQ user IDs allowed to use the bot', 'category': 'messaging'},
    'QQ_GROUP_ALLOWED_USERS': {'description': 'Comma-separated QQ group IDs allowed to interact with the bot', 'category': 'messaging'},
    'QQ_ALLOW_ALL_USERS': {'description': 'Allow all QQ users without an allowlist (true/false)', 'category': 'messaging'},
    'QQBOT_HOME_CHANNEL': {'description': 'Default QQ channel/group for cron delivery and notifications', 'category': 'messaging'},
    'QQBOT_HOME_CHANNEL_NAME': {'description': 'Display name for the QQ home channel', 'category': 'messaging'},
    'QQ_SANDBOX': {'description': 'Enable QQ sandbox mode for development testing (true/false)', 'category': 'messaging'},
    'IRC_SERVER': {'description': 'IRC server hostname (e.g. irc.libera.chat)', 'category': 'messaging'},
    'IRC_CHANNEL': {'description': 'IRC channel to join (e.g. #hermes)', 'category': 'messaging'},
    'IRC_NICKNAME': {'description': 'Bot nickname on IRC (default: hermes-bot)', 'category': 'messaging'},
    'IRC_SERVER_PASSWORD': {'description': 'IRC server password (if required)', 'password': True, 'category': 'messaging', 'advanced': True},
    'IRC_NICKSERV_PASSWORD': {'description': 'NickServ password for nick identification', 'password': True, 'category': 'messaging', 'advanced': True},
    'GATEWAY_ALLOW_ALL_USERS': {'description': 'Allow all users to interact with messaging bots (true/false). Default: false.', 'category': 'messaging', 'advanced': True},
    'API_SERVER_ENABLED': {'description': 'Enable the OpenAI-compatible API server (true/false). Allows frontends like Open WebUI, LobeChat, etc. to connect.', 'category': 'messaging', 'advanced': True},
    'API_SERVER_KEY': {'description': 'Bearer token for API server authentication. Required whenever the API server is enabled; server refuses to start without it.', 'password': True, 'category': 'messaging', 'advanced': True},
    'API_SERVER_PORT': {'description': 'Port for the API server (default: 8642).', 'category': 'messaging', 'advanced': True},
    'API_SERVER_HOST': {'description': 'Host/bind address for the API server (default: 127.0.0.1). API_SERVER_KEY is still required even on loopback binds.', 'category': 'messaging', 'advanced': True},
    'API_SERVER_MODEL_NAME': {'description': "Model name advertised on /v1/models. Defaults to the profile name (or 'hermes-agent' for the default profile). Useful for multi-user setups with OpenWebUI.", 'category': 'messaging', 'advanced': True},
    'GATEWAY_PROXY_URL': {'description': 'URL of a remote Hermes API server to forward messages to (proxy mode). When set, the gateway handles platform I/O only — all agent work is delegated to the remote server. Use for Docker E2EE containers that relay to a host agent. Also configurable via gateway.proxy_url in config.yaml.', 'category': 'messaging', 'advanced': True},
    'GATEWAY_PROXY_KEY': {'description': 'Bearer token for authenticating with the remote Hermes API server (proxy mode). Must match the API_SERVER_KEY on the remote host.', 'password': True, 'category': 'messaging', 'advanced': True},
    'WEBHOOK_ENABLED': {'description': 'Enable the webhook platform adapter for receiving events from GitHub, GitLab, etc.', 'category': 'messaging'},
    'WEBHOOK_PORT': {'description': 'Port for the webhook HTTP server (default: 8644).', 'category': 'messaging'},
    'WEBHOOK_SECRET': {'description': 'Global HMAC secret for webhook signature validation (overridable per route in config.yaml).', 'password': True, 'category': 'messaging'},
    'SUDO_PASSWORD': {'description': 'Sudo password for terminal commands requiring root access; set to an explicit empty string to try empty without prompting', 'password': True, 'category': 'setting'},
    'HERMES_PREFILL_MESSAGES_FILE': {'description': 'Path to JSON file with ephemeral prefill messages for few-shot priming', 'category': 'setting'},
    'HERMES_EPHEMERAL_SYSTEM_PROMPT': {'description': 'Ephemeral system prompt injected at API-call time (never persisted to sessions)', 'category': 'setting'},
    'ARK_API_KEY': {'description': '火山方舟（豆包系列）API key', 'url': 'https://www.volcengine.com/docs/82379', 'password': True, 'category': 'provider'},
    'ARK_BASE_URL': {'description': '火山方舟 base URL override (default: https://ark.cn-beijing.volces.com/api/v3)', 'category': 'provider', 'advanced': True},
    'COMPSHARE_API_KEY': {'description': '优云智算（Compshare）API key', 'url': 'https://www.compshare.cn/', 'password': True, 'category': 'provider', 'advanced': True},
    'QIANFAN_API_KEY': {'description': '百度智能云千帆 API key（文心一言 / ERNIE 系列）', 'url': 'https://cloud.baidu.com/doc/WENXINWORKSHOP/index.html', 'password': True, 'category': 'provider', 'advanced': True},
    'HUNYUAN_API_KEY': {'description': '腾讯混元 API key', 'url': 'https://cloud.tencent.com/document/product/1729', 'password': True, 'category': 'provider', 'advanced': True},
    'SILICONFLOW_API_KEY': {'description': '硅基流动（SiliconFlow）API key', 'url': 'https://docs.siliconflow.cn/', 'password': True, 'category': 'provider', 'advanced': True},
    'MODELSCOPE_API_KEY': {'description': '魔搭 ModelScope 推理服务 API key', 'url': 'https://modelscope.cn/docs/model-service/API-Inference/intro', 'password': True, 'category': 'provider', 'advanced': True},
    'AI302_API_KEY': {'description': '302.AI 聚合 API key', 'url': 'https://302.ai/', 'password': True, 'category': 'provider', 'advanced': True},
    'LONGCAT_API_KEY': {'description': '美团 LongCat API key', 'url': 'https://longcat.chat/platform/docs', 'password': True, 'category': 'provider', 'advanced': True},
}

# Provider grouping hints (Core derives these from the unified provider
# catalog via _catalog_provider_env_metadata). Ordered longest-prefix-first
# lookup: (key prefix, provider slug, provider label).
_ENV_PROVIDER_PREFIXES: tuple[tuple[str, str, str], ...] = (
    ("NOUS_", "nous", "Nous Portal"),
    ("OPENROUTER_", "openrouter", "OpenRouter"),
    ("VERTEX_", "vertex", "Google Vertex AI"),
    ("GOOGLE_", "google", "Google AI Studio"),
    ("GEMINI_", "google", "Google AI Studio"),
    ("XAI_", "xai", "xAI"),
    ("NVIDIA_", "nvidia", "NVIDIA NIM"),
    ("LM_", "lmstudio", "LM Studio"),
    ("GLM_", "zai", "Z.AI / GLM"),
    ("ZAI_", "zai", "Z.AI / GLM"),
    ("Z_AI_", "zai", "Z.AI / GLM"),
    ("KIMI_CN_", "kimi-cn", "Kimi / Moonshot (China)"),
    ("KIMI_", "kimi", "Kimi / Moonshot"),
    ("STEPFUN_", "stepfun", "StepFun"),
    ("ARCEE", "arcee", "Arcee AI"),
    ("GMI_", "gmi", "GMI Cloud"),
    ("ACTUAL_", "actual", "Actual Computer"),
    ("FIREWORKS_", "fireworks", "Fireworks AI"),
    ("MINIMAX_CN_", "minimax-cn", "MiniMax (China)"),
    ("MINIMAX_", "minimax", "MiniMax"),
    ("DEEPSEEK_", "deepseek", "DeepSeek"),
    ("DASHSCOPE_", "dashscope", "Alibaba DashScope / Qwen"),
    ("HERMES_QWEN_", "dashscope", "Alibaba DashScope / Qwen"),
    ("OPENCODE_ZEN_", "opencode-zen", "OpenCode Zen"),
    ("OPENCODE_GO_", "opencode-go", "OpenCode Go"),
    ("HF_", "huggingface", "Hugging Face"),
    ("OLLAMA_", "ollama", "Ollama"),
    ("XIAOMI_", "xiaomi", "Xiaomi MiMo"),
    ("UPSTAGE_", "upstage", "Upstage"),
    ("AWS_", "aws-bedrock", "AWS Bedrock"),
    ("AZURE_FOUNDRY_", "azure-foundry", "Azure Foundry"),
    ("ARK_", "volcengine-ark", "Volcengine Ark / Doubao"),
    ("COMPSHARE_", "compshare", "CompShare"),
    ("QIANFAN_", "qianfan", "Baidu Qianfan"),
    ("HUNYUAN_", "hunyuan", "Tencent Hunyuan"),
    ("SILICONFLOW_", "siliconflow", "SiliconFlow"),
    ("MODELSCOPE_", "modelscope", "ModelScope"),
    ("AI302_", "ai302", "302.AI"),
    ("LONGCAT_", "longcat", "LongCat"),
    ("VOICE_TOOLS_OPENAI_", "openai", "OpenAI"),
    ("OPENAI_", "openai", "OpenAI"),
    ("MISTRAL_", "mistral", "Mistral AI"),
    ("ELEVENLABS_", "elevenlabs", "ElevenLabs"),
)

# Messaging-platform credential keys are owned by the Channels page (Core
# _channel_managed_env_keys, built from the messaging platform catalog).
_CHANNEL_MANAGED_PREFIXES: tuple[str, ...] = (
    "TELEGRAM_", "DISCORD_", "SLACK_", "MATTERMOST_", "MATRIX_",
    "BLUEBUBBLES_", "QQ", "IRC_",
)


def _env_provider_hint(key: str) -> tuple[str, str]:
    for prefix, slug, label in _ENV_PROVIDER_PREFIXES:
        if key.startswith(prefix):
            return slug, label
    return "", ""


def _is_channel_managed(key: str) -> bool:
    return any(key.startswith(prefix) for prefix in _CHANNEL_MANAGED_PREFIXES)


# ── Env vars (/api/env*) ────────────────────────────────────────────────


def handle_env(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """/api/env* — env vars (list/set/remove/reveal)."""
    path = params.get("path", "")
    method = str(params.get("method") or "GET").upper()
    home = _hermes_home(ctx)

    if path.endswith("/reveal"):
        env = _read_env_file(home)
        key = str(params.get("key") or "")
        return {"value": env.get(key, "")}

    env = _read_env_file(home)
    if method == "PUT":
        key = str(params.get("key") or "")
        value = str(params.get("value") or "")
        if key:
            env[key] = value
            _write_env_file(home, env)
        return {"ok": True}
    if method == "DELETE":
        key = str(params.get("key") or "")
        if key:
            env.pop(key, None)
            _write_env_file(home, env)
        return {"ok": True}

    # GET — mirror Core _get_env_vars_sync: catalog rows for every known
    # env var (is_set False when absent from .env), then custom rows for
    # on-disk keys the catalog doesn't know.
    result: dict[str, Any] = {}

    def _row(var_name: str, info: dict[str, Any], *, custom: bool = False) -> dict[str, Any]:
        value = env.get(var_name)
        slug, label = _env_provider_hint(var_name)
        return {
            "is_set": bool(value),
            "redacted_value": _redact(value) if value else None,
            "description": info.get("description", ""),
            "url": info.get("url"),
            "category": "custom" if custom else info.get("category", ""),
            "is_password": True if custom else bool(info.get("password", False)),
            "tools": info.get("tools", []),
            "advanced": bool(info.get("advanced", False)),
            "channel_managed": _is_channel_managed(var_name),
            "provider": slug,
            "provider_label": label,
            "custom": custom,
        }

    for var_name, info in _ENV_CATALOG.items():
        result[var_name] = _row(var_name, info)
    for var_name in env:
        if var_name in result or _is_channel_managed(var_name):
            continue
        result[var_name] = _row(var_name, {}, custom=True)
    return result


# ── FS (/api/fs/list, read-text, write-text) ────────────────────────────


def handle_fs(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """/api/fs/list — directory listing (mirrors Core fs_list)."""
    path = params.get("path", "")
    method = str(params.get("method") or "GET").upper()
    home = _hermes_home(ctx)
    q = _query(params)

    if path == "/api/fs/list":
        target_raw = q.get("path") or str(home)
        target = Path(target_raw).expanduser().resolve()
        try:
            entries = []
            with os.scandir(target) as scan:
                for entry in scan:
                    if entry.name.startswith("."):
                        continue
                    entries.append({
                        "name": entry.name,
                        "path": str(target / entry.name),
                        "isDirectory": entry.is_dir(follow_symlinks=False),
                    })
            entries.sort(key=lambda item: (not item["isDirectory"], item["name"].lower(), item["name"]))
            return {"path": str(target), "parent": str(target.parent) if target.parent != target else None, "entries": entries}
        except FileNotFoundError:
            return {"path": str(target), "entries": [], "error": "ENOENT"}
        except NotADirectoryError:
            return {"path": str(target), "entries": [], "error": "ENOTDIR"}
        except PermissionError:
            return {"path": str(target), "entries": [], "error": "EACCES"}
        except OSError as exc:
            return {"path": str(target), "entries": [], "error": getattr(exc, "strerror", None) or "read-error"}

    if path == "/api/fs/read-text":
        target_raw = q.get("path") or params.get("path") or str(home)
        target = Path(target_raw).expanduser().resolve()
        try:
            data = target.read_bytes()
        except OSError as exc:
            return {"ok": False, "error": getattr(exc, "strerror", None) or "read-error"}
        preview = data[:512 * 1024]
        binary = b"\x00" in preview[:4096]
        return {
            "binary": binary,
            "byteSize": len(data),
            "language": "text",
            "mimeType": mimetypes.guess_type(target.name)[0] or "application/octet-stream",
            "path": str(target),
            "text": preview.decode("utf-8", errors="replace"),
            "truncated": len(data) > 512 * 1024,
        }

    if path == "/api/fs/write-text" and method in ("POST", "PUT"):
        target_raw = str(params.get("path") or "")
        target = Path(target_raw).expanduser().resolve()
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(str(params.get("content") or ""), encoding="utf-8")
            return {"ok": True, "path": str(target)}
        except OSError as exc:
            return {"ok": False, "error": getattr(exc, "strerror", None) or "write-error"}

    return {"ok": False, "error": "unsupported-fs-operation"}


# ── Logs (/api/logs) ────────────────────────────────────────────────────


def handle_logs(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """/api/logs — log tail (mirrors Core get_logs)."""
    q = _query(params)
    home = _hermes_home(ctx)
    file_name = str(q.get("file") or "agent")
    lines = min(_as_int(q.get("lines"), 200), 500)
    level = str(q.get("level") or "")
    component = str(q.get("component") or "")
    search = str(q.get("search") or "") or None

    log_name = _log_files().get(file_name)
    if not log_name:
        return {"file": file_name, "lines": []}
    log_path = home / "logs" / log_name
    if not log_path.is_file():
        return {"file": file_name, "lines": []}

    result = _read_tail(log_path, lines if not search else 2000)
    if search:
        needle = search.lower()
        result = [line for line in result if needle in line.lower()][-lines:]
    if level and level.upper() != "ALL":
        upper = level.upper()
        result = [line for line in result if upper in line.upper()][-lines:]
    if component and component.lower() != "all":
        c = component.lower()
        result = [line for line in result if c in line.lower()][-lines:]
    return {"file": file_name, "lines": result}


# ── Media (/api/media) ──────────────────────────────────────────────────

_MEDIA_EXTENSIONS = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
}


def handle_media(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """/api/media* — media data-url fetch (mirrors Core get_media)."""
    q = _query(params)
    target_raw = q.get("path") or params.get("path") or ""
    target = Path(target_raw).expanduser().resolve()
    ext = target.suffix.lower()
    content_type = _MEDIA_EXTENSIONS.get(ext) or mimetypes.guess_type(target.name)[0]
    if not content_type:
        return {"data_url": "", "error": "unsupported-media-type"}
    try:
        data = target.read_bytes()
    except OSError as exc:
        return {"data_url": "", "error": getattr(exc, "strerror", None) or "read-error"}
    if len(data) > 200 * 1024 * 1024:
        return {"data_url": "", "error": "file-too-large"}
    encoded = base64.b64encode(data).decode("ascii")
    return {"data_url": f"data:{content_type};base64,{encoded}"}


# ── Memory (/api/memory*) ───────────────────────────────────────────────


def handle_memory(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """/api/memory* — memory providers/status/reset.

    Shape-correct reference surface: real provider wiring needs the Core
    memory service (out of scope for the self-contained package).
    """
    path = params.get("path", "")
    method = str(params.get("method") or "GET").upper()

    if path == "/api/memory" and method == "GET":
        return {"active": "", "providers": [], "builtin_files": {}}
    if path == "/api/memory/provider" and method == "PUT":
        return {"ok": True}
    if path == "/api/memory/reset":
        return {"ok": True}

    # /api/memory/providers/{name}/...
    prefix = "/api/memory/providers/"
    if path.startswith(prefix):
        rest = path[len(prefix):]
        parts = rest.split("/")
        provider = parts[0] if parts else ""
        action = parts[1] if len(parts) > 1 else ""
        if action == "config":
            if method == "PUT":
                return {"ok": True, "active": ""}
            return {"name": provider, "label": provider, "fields": []}
        if action == "status":
            return {
                "provider": provider,
                "active": False,
                "configured": False,
                "reachable": False,
                "healthy": False,
                "endpoint": "",
                "console_url": "",
                "version": "",
                "checked_at": "",
                "error": "embedded memory provider not configured",
                "details": None,
            }
        if action == "setup":
            return {"ok": True, "provider": provider, "results": []}

    return {"ok": True}


# ── MCP servers summary (/api/mcp-servers) ──────────────────────────────


def handle_mcp_servers(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """/api/mcp-servers — MCP health summary (mirrors Core list_mcp_servers_summary).

    Reads config.yaml's ``mcp_servers`` section; only name + enabled are exposed
    (command/args/env stay server-side because they embed secrets).
    """
    home = _hermes_home(ctx)
    config_path = home / "config.yaml"
    raw_servers: dict[str, Any] = {}
    if config_path.is_file():
        try:
            import yaml  # available in the managed runtime
            loaded = yaml.safe_load(config_path.read_text(encoding="utf-8", errors="replace"))
            if isinstance(loaded, dict):
                raw = loaded.get("mcp_servers") or {}
                if isinstance(raw, dict):
                    raw_servers = raw
        except Exception:
            raw_servers = {}

    servers = []
    enabled_count = 0
    for name, cfg in raw_servers.items():
        if not isinstance(cfg, dict):
            continue
        is_enabled = bool(cfg.get("enabled", True))
        if is_enabled:
            enabled_count += 1
        servers.append({"name": str(name), "enabled": is_enabled})
    servers.sort(key=lambda s: s["name"].lower())

    return {
        "summary": {"total": len(servers), "enabled": enabled_count},
        "servers": servers,
    }


# ── OAuth providers (/api/providers/oauth*) ─────────────────────────────


def handle_oauth_providers(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """/api/providers/oauth* — OAuth providers.

    Shape-correct reference surface: real provider login needs the Core OAuth
    session store + IDP redirects (out of scope for the self-contained package).
    """
    path = params.get("path", "")
    method = str(params.get("method") or "GET").upper()

    if path == "/api/providers/oauth":
        return {"providers": []}

    prefix = "/api/providers/oauth/"
    if path.startswith(prefix):
        rest = path[len(prefix):]
        parts = rest.split("/")
        provider = parts[0] if parts else ""

        if provider == "sessions" and len(parts) >= 2:
            session_id = parts[1]
            if method == "DELETE":
                return {"ok": True}
            return {"session_id": session_id, "status": "expired", "error_message": None, "expires_at": None}
        if len(parts) >= 2 and parts[1] == "start":
            return {
                "session_id": f"{provider}-{int(time.time())}",
                "flow": "device_code",
                "user_code": "0000-0000",
                "verification_url": "",
                "expires_in": 300,
                "poll_interval": 2,
            }
        if len(parts) >= 2 and parts[1] == "submit":
            return {"ok": False, "status": "error", "message": "embedded OAuth not configured"}
        if len(parts) >= 3 and parts[1] == "poll":
            session_id = parts[2]
            return {"session_id": session_id, "status": "expired", "error_message": None, "expires_at": None}
        if method == "DELETE":
            return {"ok": True, "provider": provider}

    return {"ok": True}


# ── Audio (/api/audio*) ─────────────────────────────────────────────────


def handle_audio(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """/api/audio/* — transcribe/speak/voices.

    Shape-correct reference surface: real STT/TTS needs configured providers
    (external ElevenLabs etc.). Errors use the exact strings the frontend
    maps to friendly Chinese setup messages (web/src/lib/voice.ts).
    """
    path = params.get("path", "")
    method = str(params.get("method") or "GET").upper()

    if path == "/api/audio/transcribe":
        return {"ok": False, "transcript": "", "provider": None, "error": "no stt provider available"}
    if path == "/api/audio/speak":
        return {"ok": False, "data_url": "", "mime_type": "audio/mpeg", "provider": None, "error": "no tts provider available"}
    if path == "/api/audio/elevenlabs/voices":
        return {"available": False, "voices": []}
    if path == "/api/audio/speak-stream":
        return {"ok": False, "error": "streaming not supported in embedded FFI"}
    return {"ok": False, "error": "unsupported-audio-operation"}


# ── Upload (/api/upload) ────────────────────────────────────────────────


def handle_upload(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """POST /api/upload — store an attachment under ~/.hermes/uploads/<session_id>/.

    Mirrors Core upload_attachment (P-002): the FFI body carries base64 +
    session_id instead of multipart. The Rust upload_file command (Phase C)
    dispatches here through embedded_rest_request.
    """
    home = _hermes_home(ctx)
    session_id = str(params.get("session_id") or "default").strip()
    if not re.match(r"^[A-Za-z0-9._-]+$", session_id):
        session_id = "default"

    data = params.get("data")
    if data is None:
        return {"ok": False, "filename": "", "path": "", "size": 0, "error": "missing base64 data"}
    try:
        content = base64.b64decode(str(data), validate=True)
    except Exception:
        return {"ok": False, "filename": "", "path": "", "size": 0, "error": "invalid base64"}

    filename = _safe_upload_name(params.get("name") or params.get("filename"))
    upload_dir = home / "uploads" / session_id
    try:
        upload_dir.mkdir(parents=True, exist_ok=True)
        target = _unique_upload_path(upload_dir, filename)
        target.write_bytes(content)
    except OSError as exc:
        return {"ok": False, "filename": "", "path": "", "size": 0, "error": getattr(exc, "strerror", None) or "write-error"}

    content_type = str(params.get("type") or params.get("mime_type") or "")
    if not content_type or content_type == "application/octet-stream":
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"

    return {
        "ok": True,
        "filename": target.name,
        "path": str(target),
        "size": len(content),
        "mime_type": content_type,
    }


# ── Config schema (/api/config/schema) ──────────────────────────────────


def handle_config_schema(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """GET /api/config/schema — config schema.

    Shape-correct reference surface: the real field catalog lives in Core's
    config dataclasses (_schema_with_dynamic_provider_options); an empty schema
    keeps the form renderer safe until the Core wiring lands.
    """
    return {"fields": {}, "category_order": []}


# ── Gateway restart (/api/gateway/restart) ──────────────────────────────


def handle_gateway_restart(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """POST /api/gateway/restart — gateway restart action.

    Embedded mode has no subprocess gateway to restart: the gateway runs
    in-process (EmbeddedGatewaySession). Report ok with pid=null so the
    frontend's restart flow settles immediately (web/src/lib/gateway-restart.ts).
    """
    return {"ok": True, "pid": None, "name": "gateway-restart"}


# ── Skills (/api/skills) ────────────────────────────────────────────────

_MAX_SKILL_NAME = 64
_MAX_SKILL_DESCRIPTION = 1024


def _parse_skill_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Parse SKILL.md YAML frontmatter → (frontmatter dict, body).

    yaml is optional in the embedded interpreter; falls back to a simple
    ``key: value`` line parser so discovery works stdlib-only.
    """
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    raw = text[3:end]
    body = text[end + 4:]
    try:
        import yaml  # available in the managed runtime
        parsed = yaml.safe_load(raw)
        if isinstance(parsed, dict):
            return parsed, body
    except Exception:
        pass
    frontmatter: dict[str, Any] = {}
    for line in raw.splitlines():
        if ":" not in line or line.startswith((" ", "\t", "#")):
            continue
        key, _, value = line.partition(":")
        frontmatter[key.strip()] = value.strip().strip('"').strip("'")
    return frontmatter, body


def _find_skills(home: Path) -> list[dict[str, Any]]:
    """Scan <hermes_home>/skills for SKILL.md files (Core _find_all_skills).

    Returns SkillInfo-shaped rows (packages/protocol hermes-api.ts):
    name / description / category / enabled / provenance / source_path /
    skill_file. Local skills are user/agent-authored → provenance "agent"
    (Core's classification for non-bundled, non-hub skills).
    """
    skills_dir = home / "skills"
    if not skills_dir.is_dir():
        return []
    config = _load_config_dict(home)
    skills_cfg = config.get("skills") if isinstance(config.get("skills"), dict) else {}
    disabled_raw = skills_cfg.get("disabled") or []
    disabled = {str(name).strip().lower() for name in disabled_raw} if isinstance(disabled_raw, list) else set()

    skills: list[dict[str, Any]] = []
    seen: set[str] = set()
    for skill_md in sorted(skills_dir.rglob("SKILL.md")):
        if any(part.startswith(".") for part in skill_md.relative_to(skills_dir).parts):
            continue
        skill_dir = skill_md.parent
        try:
            content = skill_md.read_text(encoding="utf-8-sig", errors="replace")[:4000]
        except OSError:
            continue
        frontmatter, body = _parse_skill_frontmatter(content)
        name = str(frontmatter.get("name") or skill_dir.name)[:_MAX_SKILL_NAME]
        if not name or name.lower() in seen:
            continue
        description = str(frontmatter.get("description") or "")
        if not description:
            for line in body.strip().split("\n"):
                line = line.strip()
                if line and not line.startswith("#"):
                    description = line
                    break
        if len(description) > _MAX_SKILL_DESCRIPTION:
            description = description[:_MAX_SKILL_DESCRIPTION - 3] + "..."
        # Category from the directory level under skills/ (Core
        # _get_category_from_path): skills/<category>/<name>/SKILL.md.
        rel = skill_md.relative_to(skills_dir)
        category = rel.parts[0] if len(rel.parts) > 2 else None
        seen.add(name.lower())
        skills.append({
            "name": name,
            "description": description,
            "category": category,
            "enabled": name.lower() not in disabled,
            "provenance": "agent",
            "origin": "user",
            "source_path": str(skill_dir),
            "skill_file": str(skill_md),
        })
    return skills


def handle_skills(params: dict[str, Any], ctx: dict[str, Any]) -> Any:
    """/api/skills — skill routes.

    GET /api/skills returns a BARE ARRAY (SkillsResponse = z.array(SkillInfo))
    scanned from the real <hermes_home>/skills directory. The content
    sub-route returns the raw SKILL.md (SkillContentResponse).
    """
    path = params.get("path", "")
    home = _hermes_home(ctx)
    q = _query(params)

    if path.endswith("/content"):
        wanted = str(q.get("name") or params.get("name") or "")
        for skill in _find_skills(home):
            if skill["name"] == wanted:
                try:
                    content = Path(skill["skill_file"]).read_text(encoding="utf-8")
                except OSError:
                    content = ""
                return {"name": wanted, "content": content, "path": skill["skill_file"]}
        return {"name": wanted, "content": "", "path": ""}

    if path.endswith("/toggle"):
        return {"ok": True, "name": str(params.get("name") or ""), "enabled": bool(params.get("enabled", True))}

    return _find_skills(home)


# ── Original reference handlers (already covered) ───────────────────────


def handle_session(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """session.create / session.resume / session.list — gateway JSON-RPC surface.

    Mirrors Core tui_gateway/methods_session.py response shapes so the desktop
    frontend zod schemas parse (packages/protocol hermes-api.ts):
      session.create -> {"session_id", "stored_session_id", "message_count"}
      session.resume -> {"session_id", "message_count"}
    The old {"session": {"id": ...}} shape left SessionCreateResult without its
    required `session_id` and made the workbench 发送 flow fail even after the
    RPC transport delivers the response.
    """
    path = str(params.get("path") or "")
    action = params.get("action")
    if path.endswith("/list") or action == "list":
        return {"sessions": []}
    session_id = params.get("session_id") or params.get("id")
    if session_id is None:
        session_id = "embedded-session"
    if action == "resume" or path.endswith("/resume"):
        return {"session_id": session_id, "message_count": 0}
    # session.create (also covers /api/session/* REST leftovers).
    return {
        "session_id": session_id,
        "stored_session_id": session_id,
        "message_count": 0,
    }


def handle_prompt(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """/api/prompt — submit/abort.

    The reference package is a synchronous stub: it accepts the prompt but has
    no agent loop, so it returns a *completed* turn payload
    (``status: "complete"`` + ``reply``) instead of Core's
    ``{"status": "streaming"}`` promise. The Rust transport
    (``src/embedded/transport.rs``) detects the missing ``status: "streaming"``
    and fans ``message.start`` + ``message.complete`` out to the webview —
    without this the GUI would stay stuck on the optimistic
    "正在唤醒Hermes..." progress forever (python run.py).
    """
    action = params.get("action") or (params.get("method") or "submit")
    if action == "abort":
        return {"ok": True, "aborted": True}
    text = str(params.get("text") or "").strip()
    reply = (
        f"（嵌入式演示模式）已收到：{text[:200]}"
        if text
        else "（嵌入式演示模式）已收到你的消息。"
    )
    return {
        "ok": True,
        "accepted": True,
        "embedded": True,
        "status": "complete",
        "reply": reply,
    }


def _prompt_abort(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """Gateway ``prompt.abort`` — an explicit abort, never a submit.

    ``handle_prompt`` cannot be reused for the gateway method: the JSON-RPC
    params carry only ``session_id`` (no ``action``/``method`` field), so the
    action detection above would treat an abort as a submit and return a
    complete-turn payload. Route the gateway method to this dedicated handler.
    """
    return {"ok": True, "aborted": True, "embedded": True}


def _input_detect_drop(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """Gateway ``input.detect_drop`` — reference stub.

    The frontend ``InputDetectDropResult`` zod schema REQUIRES ``matched``;
    the old ``_noop`` response (``{ok, embedded, stub}``) made
    ``parseGatewayResult`` throw and (before the error-frame fix) tore the
    gateway session down. Report no match — shape-correct, real drop detection
    is Core work outside the reference package.
    """
    return {"matched": False, "is_image": False, "embedded": True, "stub": True}


def handle_model(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """/api/model/* — list/get/set model."""
    return {"models": [], "embedded": True}


def handle_tools(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """/api/tools/toolsets."""
    return {"toolsets": []}


def handle_mcp(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """/api/mcp — full MCP management surface (not the /api/mcp-servers summary)."""
    return {"mcp": {"enabled": True, "embedded": True}}


def handle_cron(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """/api/cron/*."""
    return {"cron": []}


def handle_messaging(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """/api/messaging/*."""
    return {"messaging": {"embedded": True}}


def handle_pairing(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """/api/pairing/*."""
    return {"pairing": {"embedded": True}}


def handle_git(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """/api/git/*."""
    return {"git": {"embedded": True}}


def handle_profiles(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """/api/profiles/* — active getter + subroutes."""
    path = params.get("path", "")
    if path.endswith("/active"):
        profile = ctx.get("profile") or "default"
        return {"active": profile, "current": profile}
    return {"profiles": [{"name": "default", "active": True}]}


def handle_analytics(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """/api/analytics/*."""
    return {"analytics": {"embedded": True}}


def _session_action(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """Generic session action (close/compress/interrupt/title/usage)."""
    action = params.get("action") or "ok"
    return {"ok": True, "action": action, "embedded": True}


def _noop(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """Placeholder for methods that need the real Core dispatcher."""
    return {"ok": True, "embedded": True, "stub": True}


# Gateway JSON-RPC methods (the /api/ws protocol surface, minus the transport).
# Mirrors Rust src/embedded/ffi.rs::GATEWAY_FFI_METHODS.
_RPC_METHODS: dict[str, Any] = {
    "session.create": handle_session,
    "session.resume": handle_session,
    "session.list": handle_session,
    "session.close": _session_action,
    "session.compress": _session_action,
    "session.interrupt": _session_action,
    "session.title": _session_action,
    "session.usage": _session_action,
    "prompt.submit": handle_prompt,
    "prompt.abort": _prompt_abort,
    "approval.respond": _noop,
    "setup.status": get_status,
    "model.info": handle_model,
    "model.list": handle_model,
    "model.options": _noop,
    "provider.models": _noop,
    "provider.probe": _noop,
    "command.dispatch": _noop,
    "complete.path": _noop,
    "complete.slash": _noop,
    "config.set": _noop,
    "file.attach": _noop,
    "image.attach": _noop,
    "image.attach_bytes": _noop,
    "input.detect_drop": _input_detect_drop,
    "gateway.disconnected": _noop,
}


def handle_rpc(method: str, params_json: str | dict[str, Any], ctx_json: str | dict[str, Any] = "{}") -> Any:
    """Unified FFI entry: dispatch a REST router name or JSON-RPC method.

    Args:
        method: router name (``get_version``, ``handle_session``, ...) or a
            JSON-RPC method (``session.create``, ``prompt.submit``, ...).
        params_json: JSON string (or already-parsed dict) with request params.
        ctx_json: JSON string (or dict) with the embedded context
            (hermesHome / sessionToken / profile / path / method).

    Returns:
        JSON-serializable result (dict/str/list/...).
    """
    if not isinstance(params_json, dict):
        params = json.loads(params_json) if params_json else {}
    else:
        params = params_json
    if not isinstance(ctx_json, dict):
        ctx = json.loads(ctx_json) if ctx_json else {}
    else:
        ctx = ctx_json
    # Defensive: a frame without `params` arrives as the JSON string "null"
    # (Rust `Value::Null.to_string()`), and handlers call `.get()` on params —
    # coerce non-dict values to {} so a bare `{"method":"session.list"}` frame
    # cannot crash the interpreter (which would tear the gateway down).
    if not isinstance(params, dict):
        params = {}
    if not isinstance(ctx, dict):
        ctx = {}

    # REST router names from src/embedded/ffi.rs.
    router = _ROUTERS.get(method)
    if router is not None:
        return router(params, ctx)

    # Gateway JSON-RPC methods.
    rpc = _RPC_METHODS.get(method)
    if rpc is not None:
        return rpc(params, ctx)

    raise ValueError(f"unknown embedded FFI method: {method}")


_ROUTERS: dict[str, Any] = {
    "get_version": lambda params, ctx: get_version(),
    "get_gateway_config": lambda params, ctx: get_gateway_config(),
    "get_status": get_status,
    "get_config": get_config,
    "handle_session": handle_session,
    "handle_prompt": handle_prompt,
    "handle_model": handle_model,
    "handle_skills": handle_skills,
    "handle_tools": handle_tools,
    "handle_mcp": handle_mcp,
    "handle_cron": handle_cron,
    "handle_messaging": handle_messaging,
    "handle_pairing": handle_pairing,
    "handle_git": handle_git,
    "handle_profiles": handle_profiles,
    "handle_analytics": handle_analytics,
    # Real frontend surface (refactor_plan.md Phase B).
    "handle_sessions": handle_sessions,
    "handle_profiles_exact": handle_profiles_exact,
    "handle_env": handle_env,
    "handle_fs": handle_fs,
    "handle_logs": handle_logs,
    "handle_media": handle_media,
    "handle_memory": handle_memory,
    "handle_mcp_servers": handle_mcp_servers,
    "handle_oauth_providers": handle_oauth_providers,
    "handle_audio": handle_audio,
    "handle_upload": handle_upload,
    "handle_config_schema": handle_config_schema,
    "handle_gateway_restart": handle_gateway_restart,
}
