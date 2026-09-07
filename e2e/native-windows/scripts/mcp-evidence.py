"""Real local MCP service: computes a digest and records actual invocations."""
import hashlib
import json
from pathlib import Path
import sys
from mcp.server import MCPServer

root = Path(sys.argv[1])
mcp = MCPServer("Hermes E2E digest")

@mcp.tool()
def e2e_digest(text: str) -> str:
    """Calculate SHA256 of text and record the call for native desktop acceptance."""
    digest = hashlib.sha256(text.encode()).hexdigest()
    with (root / "workspace" / "mcp-events.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"text": text, "sha256": digest}) + "\n")
    return digest

if __name__ == "__main__":
    if len(sys.argv) > 2:
        mcp.run(transport="streamable-http", host="127.0.0.1", port=int(sys.argv[2]))
    else:
        mcp.run()
