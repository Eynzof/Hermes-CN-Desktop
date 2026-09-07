"""Read-only proof of the session persisted by the installed Core process."""
import json
import sqlite3
import sys
import re
from pathlib import Path

home, session_id = Path(sys.argv[1]), sys.argv[2]
ui_session_id = session_id
log = home / "logs" / "agent.log"
log_lines = log.read_text(encoding="utf-8", errors="replace").splitlines() if log.exists() else []
# New chat URLs use the gateway's short live handle; persisted history uses
# the full agent session ID. Resolve the explicit mapping written by Core.
for line in reversed(log_lines):
    match = re.search(r"tui prompt accepted: ui_session=(\S+).* agent_session_id=(\S+)", line)
    if match and match.group(1) == ui_session_id:
        session_id = match.group(2)
        break
db = sqlite3.connect((home / "state.db").as_uri() + "?mode=ro", uri=True, timeout=10)
db.row_factory = sqlite3.Row
row = db.execute(
    "SELECT id,source,model,profile_name,input_tokens,output_tokens,api_call_count,"
    "tool_call_count,billing_provider,billing_base_url,archived,pinned,title,model_config,parent_session_id "
    "FROM sessions WHERE id=?", (session_id,),
).fetchone()
messages = db.execute(
    "SELECT role,content,tool_name,tool_calls,finish_reason FROM messages WHERE session_id=? ORDER BY id",
    (session_id,),
).fetchall()
lines = [line for line in log_lines
         if session_id in line and any(term in line for term in ("conversation turn:", "API call #", "Turn ended:", "tui turn finished:"))] if log.exists() else []
session = dict(row) if row else None
if session:
    runtime = json.loads(session.pop("model_config") or "{}")
    session["reasoning_config"] = runtime.get("reasoning_config")
children = db.execute(
    "SELECT id,parent_session_id,source,model,billing_provider,billing_base_url,output_tokens,tool_call_count "
    "FROM sessions WHERE parent_session_id=?", (session_id,),
).fetchall()
print(json.dumps({"ui_session_id": ui_session_id, "session": session, "messages": [dict(item) for item in messages], "children": [dict(item) for item in children], "log": lines}, ensure_ascii=True))
