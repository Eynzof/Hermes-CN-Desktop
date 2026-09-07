"""Validate the owned OAuth fixture, separately from Desktop acceptance."""
import base64
import hashlib
import json
import secrets
import sys
from urllib.parse import parse_qs, urlparse
import httpx2 as httpx

base = sys.argv[1]
checks = []
with httpx.Client(base_url=base, timeout=15, follow_redirects=False, trust_env=False) as client:
    denied = client.get("/mcp")
    assert denied.status_code == 401 and "resource_metadata=" in denied.headers["www-authenticate"]
    checks.append("anonymous MCP rejected with OAuth discovery challenge")
    metadata = client.get("/.well-known/oauth-authorization-server").json()
    registration = client.post(metadata["registration_endpoint"], json={
        "client_name": "Hermes fixture self-check", "redirect_uris": [f"{base}/self-check-callback"],
        "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"], "scope": "digest"})
    registration.raise_for_status()
    client_id = registration.json()["client_id"]
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")

    def consent(decision):
        state = secrets.token_urlsafe(24)
        authorize = client.get(metadata["authorization_endpoint"], params={
            "client_id": client_id, "redirect_uri": f"{base}/self-check-callback",
            "response_type": "code", "scope": "digest", "state": state,
            "code_challenge": challenge, "code_challenge_method": "S256", "resource": f"{base}/mcp"})
        assert authorize.status_code in (302, 303, 307)
        consent_url = authorize.headers["location"]
        page = client.get(consent_url)
        assert page.status_code == 200 and 'name="decision"' in page.text
        result = client.post(consent_url, data={"decision": decision})
        assert result.status_code == 302
        values = parse_qs(urlparse(result.headers["location"]).query)
        assert values["state"] == [state]
        return values

    assert consent("deny")["error"] == ["access_denied"]
    checks.append("consent cancellation returns access_denied and unchanged state")
    code = consent("allow")["code"][0]
    grant = {"grant_type": "authorization_code", "client_id": client_id, "code": code,
        "redirect_uri": f"{base}/self-check-callback", "code_verifier": "x" * 64}
    invalid = client.post(metadata["token_endpoint"], data=grant)
    assert invalid.status_code == 400 and invalid.json()["error"] == "invalid_grant"
    checks.append("wrong PKCE verifier rejected")
    grant["code_verifier"] = verifier
    exchanged = client.post(metadata["token_endpoint"], data=grant)
    exchanged.raise_for_status()
    token = exchanged.json()
    assert client.post(metadata["token_endpoint"], data=grant).status_code == 400
    checks.append("valid PKCE exchange succeeds and code replay is rejected")

    def call(access):
        return client.post("/mcp", headers={"Authorization": f"Bearer {access}",
            "Accept": "application/json, text/event-stream"}, json={"jsonrpc": "2.0", "id": 1,
            "method": "tools/call", "params": {"name": "e2e_oauth_digest", "arguments": {"text": "oauth-self-check"}}})

    result = call(token["access_token"])
    result.raise_for_status()
    digest = hashlib.sha256(b"oauth-self-check").hexdigest()
    assert any(digest in c.get("text", "") for c in result.json()["result"]["content"])
    checks.append("authorized real MCP tool computes expected SHA256")
    refreshed = client.post(metadata["token_endpoint"], data={"grant_type": "refresh_token",
        "refresh_token": token["refresh_token"], "client_id": client_id})
    refreshed.raise_for_status()
    rotated = refreshed.json()
    assert rotated["refresh_token"] != token["refresh_token"] and call(rotated["access_token"]).status_code == 200
    assert client.post(metadata["token_endpoint"], data={"grant_type": "refresh_token",
        "refresh_token": token["refresh_token"], "client_id": client_id}).status_code == 400
    checks.append("refresh rotates credentials; old refresh token is rejected")
    # SDK 2.0.0's RevocationRequest requires the nullable client_secret field
    # to be present even for token_endpoint_auth_method=none public clients.
    revoked = client.post(metadata["revocation_endpoint"], data={
        "token": rotated["refresh_token"], "client_id": client_id,
        "client_secret": "", "token_type_hint": "refresh_token"})
    revoked.raise_for_status()
    assert call(rotated["access_token"]).status_code == 401
    checks.append("revocation invalidates the corresponding access token")

print(json.dumps({"kind": "fixture-self-check-only", "checks": checks}, indent=2))
