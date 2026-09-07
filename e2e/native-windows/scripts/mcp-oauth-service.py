"""Owned loopback OAuth issuer and real SDK MCP resource for native acceptance.

This is test infrastructure, not a Hermes or model replacement. SDK handlers
validate client registration, redirects, PKCE, scopes and bearer authorization.
State is disposable; evidence records events without credentials or codes.
"""
import hashlib
import html
import json
from pathlib import Path
import secrets
import sys
import time

from mcp.server import MCPServer
from mcp.server.auth.provider import (
    AccessToken, AuthorizationCode, OAuthAuthorizationServerProvider,
    RefreshToken, construct_redirect_uri,
)
from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions, RevocationOptions
from mcp.shared.auth import OAuthToken
from starlette.responses import HTMLResponse, RedirectResponse
import uvicorn

port, evidence_file = int(sys.argv[1]), Path(sys.argv[2])
base = f"http://127.0.0.1:{port}"


def record(event, **fields):
    with evidence_file.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"event": event, "at": time.time(), **fields}) + "\n")


class Issuer(OAuthAuthorizationServerProvider):
    def __init__(self):
        self.clients, self.pending, self.codes = {}, {}, {}
        self.access, self.refresh = {}, {}

    async def get_client(self, client_id):
        return self.clients.get(client_id)

    async def register_client(self, client_info):
        self.clients[client_info.client_id] = client_info
        record("client_registered")

    async def authorize(self, client, params):
        flow = secrets.token_urlsafe(32)
        self.pending[flow] = (client, params)
        record("authorization_started")
        return f"{base}/consent?flow={flow}"

    async def load_authorization_code(self, client, authorization_code):
        return self.codes.get(authorization_code)

    def issue(self, client_id, scopes, resource):
        access, refresh = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        self.access[access] = AccessToken(token=access, client_id=client_id, scopes=scopes,
            expires_at=int(time.time()) + 120, resource=resource, subject="hermes-e2e-user")
        self.refresh[refresh] = (RefreshToken(token=refresh, client_id=client_id, scopes=scopes,
            expires_at=int(time.time()) + 3600, subject="hermes-e2e-user"), resource)
        return OAuthToken(access_token=access, refresh_token=refresh, expires_in=120, scope=" ".join(scopes))

    async def exchange_authorization_code(self, client, authorization_code):
        self.codes.pop(authorization_code.code)
        record("authorization_code_exchanged")
        return self.issue(client.client_id, authorization_code.scopes, authorization_code.resource)

    async def load_refresh_token(self, client, refresh_token):
        item = self.refresh.get(refresh_token)
        return item[0] if item else None

    async def exchange_refresh_token(self, client, refresh_token, scopes):
        _, resource = self.refresh.pop(refresh_token.token)
        record("refresh_token_rotated")
        return self.issue(client.client_id, scopes, resource)

    async def load_access_token(self, token):
        return self.access.get(token)

    async def revoke_token(self, token):
        self.access = {k: v for k, v in self.access.items() if v.client_id != token.client_id}
        self.refresh = {k: v for k, v in self.refresh.items() if v[0].client_id != token.client_id}
        record("tokens_revoked")


issuer = Issuer()
mcp = MCPServer("Hermes E2E OAuth digest", auth_server_provider=issuer,
    auth=AuthSettings(issuer_url=base, resource_server_url=f"{base}/mcp",
        required_scopes=["digest"],
        client_registration_options=ClientRegistrationOptions(enabled=True,
            valid_scopes=["digest"], default_scopes=["digest"]),
        revocation_options=RevocationOptions(enabled=True)))


@mcp.custom_route("/consent", methods=["GET", "POST"])
async def consent(request):
    flow = request.query_params["flow"]
    if flow not in issuer.pending:
        return HTMLResponse("Flow expired or already used", status_code=400)
    client, params = issuer.pending[flow]
    if request.method == "GET":
        return HTMLResponse(f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
        <title>Hermes E2E MCP 授权</title><h1>授权本地 MCP 测试服务</h1>
        <p>独立测试身份 hermes-e2e-user；权限：计算文本 SHA256。</p>
        <p>客户端：{html.escape(client.client_name or client.client_id)}</p>
        <form method="post"><button name="decision" value="allow">同意授权</button>
        <button name="decision" value="deny">取消授权</button></form></html>''')
    decision = (await request.form()).get("decision")
    if decision not in ("allow", "deny"):
        return HTMLResponse("Choose allow or deny", status_code=400)
    issuer.pending.pop(flow)
    if decision == "deny":
        record("consent_denied")
        return RedirectResponse(construct_redirect_uri(str(params.redirect_uri),
            error="access_denied", state=params.state), status_code=302)
    code = secrets.token_urlsafe(32)
    issuer.codes[code] = AuthorizationCode(code=code, client_id=client.client_id,
        scopes=params.scopes or ["digest"], expires_at=time.time() + 120,
        code_challenge=params.code_challenge, redirect_uri=params.redirect_uri,
        redirect_uri_provided_explicitly=params.redirect_uri_provided_explicitly,
        resource=params.resource, subject="hermes-e2e-user")
    record("consent_accepted")
    return RedirectResponse(construct_redirect_uri(str(params.redirect_uri),
        code=code, state=params.state), status_code=302)


@mcp.tool()
def e2e_oauth_digest(text: str) -> str:
    """Compute the actual SHA256 of text after OAuth authorization."""
    digest = hashlib.sha256(text.encode()).hexdigest()
    record("tool_called", text=text, sha256=digest)
    return digest


app = mcp.streamable_http_app(stateless_http=True, json_response=True)


async def observed(scope, receive, send):
    async def response(message):
        if message["type"] == "http.response.start":
            record("http", method=scope["method"], path=scope["path"], status=message["status"])
        await send(message)
    await app(scope, receive, response if scope["type"] == "http" else send)


if __name__ == "__main__":
    uvicorn.run(observed, host="127.0.0.1", port=port, access_log=False, log_level="warning")
