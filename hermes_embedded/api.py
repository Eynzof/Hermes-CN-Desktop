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


def get_status() -> dict[str, Any]:
    """GET /api/status — dashboard status."""
    return {
        "ok": True,
        "mode": "embedded",
        "runtime": "in-process",
        "ffiSurfaceVersion": FFI_SURFACE_VERSION,
    }


def get_config() -> dict[str, Any]:
    """GET /api/config — config view."""
    return {"ffiSurfaceVersion": FFI_SURFACE_VERSION}


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

    # GET — real rows for keys on disk + empty catalog surface.
    result: dict[str, Any] = {}
    for key, value in env.items():
        result[key] = {
            "is_set": True,
            "redacted_value": _redact(value),
            "description": "",
            "url": None,
            "category": "custom",
            "is_password": True,
            "tools": [],
            "advanced": False,
            "custom": True,
        }
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


# ── Original reference handlers (already covered) ───────────────────────


def handle_session(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """/api/session/* — list/get/create/resume."""
    path = params.get("path", "")
    if path.endswith("/list") or params.get("action") == "list":
        return {"sessions": []}
    session_id = params.get("session_id") or params.get("id")
    if session_id is not None:
        return {"session": {"id": session_id, "embedded": True}}
    return {"session": {"id": "embedded-session", "embedded": True}}


def handle_prompt(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """/api/prompt — submit/abort."""
    action = params.get("action") or (params.get("method") or "submit")
    if action == "abort":
        return {"ok": True, "aborted": True}
    return {"ok": True, "accepted": True, "embedded": True}


def handle_model(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """/api/model/* — list/get/set model."""
    return {"models": [], "embedded": True}


def handle_skills(params: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """/api/skills — skill routes."""
    return {"skills": []}


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
    "prompt.abort": handle_prompt,
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
    "get_status": lambda params, ctx: get_status(),
    "get_config": lambda params, ctx: get_config(),
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
