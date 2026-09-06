"""Local stdio MCP used by the v0.21 desktop acceptance test."""
from mcp.server import MCPServer

server = MCPServer("Desktop acceptance")

@server.tool()
def echo(message: str) -> str:
    """Return the supplied message for connection verification."""
    return message

if __name__ == "__main__":
    server.run()
