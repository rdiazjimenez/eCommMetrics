"""
Standalone script — not deployed to Azure.
Runs the one-time browser OAuth flow to authorize your TikTok account
and stores the resulting tokens in Azure Key Vault.

Prerequisites:
    pip install azure-identity azure-keyvault-secrets requests

Required env vars:
    AZURE_KEY_VAULT_URL    — e.g. https://mykeyvault.vault.azure.net/
    TIKTOK_CLIENT_KEY      — from TikTok developer portal
    TIKTOK_CLIENT_SECRET   — from TikTok developer portal

Usage:
    AZURE_KEY_VAULT_URL="..." TIKTOK_CLIENT_KEY="..." TIKTOK_CLIENT_SECRET="..." \\
        python setup/one_time_oauth.py
"""

import base64
import hashlib
import http.server
import os
import secrets
import threading
import urllib.parse
import webbrowser

import requests
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient

TIKTOK_AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/"
TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/"
REDIRECT_URI = "http://localhost:8080/callback"
SCOPE = "user.info.basic,video.list"

_callback_params: dict = {}
_server_ready = threading.Event()


class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/callback":
            _callback_params["_raw_query"] = [parsed.query]
            _callback_params.update(urllib.parse.parse_qs(parsed.query))
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<h1>Authorization complete. You may close this tab.</h1>")

    def log_message(self, *args) -> None:
        pass


def _run_server(server: http.server.HTTPServer) -> None:
    _server_ready.set()
    server.handle_request()


def main() -> None:
    client_key = os.environ["TIKTOK_CLIENT_KEY"]
    client_secret = os.environ["TIKTOK_CLIENT_SECRET"]
    kv_url = os.environ["AZURE_KEY_VAULT_URL"]

    state = secrets.token_urlsafe(16)
    # TikTok uses HEX(SHA256(verifier)) not BASE64URL — non-standard but documented.
    code_verifier = "OftZZn5jX613mWLDq81v2mYHU5ZSgwqHwsBuy6DofLoo2gxAnSpgxGfaNjZjeXyd"
    code_challenge = hashlib.sha256(code_verifier.encode()).hexdigest()

    params = {
        "client_key": client_key,
        "scope": SCOPE,
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    auth_url = TIKTOK_AUTH_URL + "?" + urllib.parse.urlencode(params)

    server = http.server.HTTPServer(("localhost", 8080), _CallbackHandler)
    t = threading.Thread(target=_run_server, args=(server,), daemon=True)
    t.start()
    _server_ready.wait()

    print("Opening browser for TikTok authorization...")
    webbrowser.open(auth_url)

    t.join(timeout=120)
    if not _callback_params.get("code"):
        raise RuntimeError("No authorization code received within 120 seconds.")

    received_state = _callback_params.get("state", [None])[0]
    if received_state != state:
        raise RuntimeError("State mismatch — possible CSRF.")

    # Extract raw (URL-encoded) code to avoid double-encoding issues.
    raw_query = _callback_params.get("_raw_query", [""])[0]
    import re as _re
    raw_code_match = _re.search(r"code=([^&]+)", raw_query)
    raw_code = raw_code_match.group(1) if raw_code_match else _callback_params["code"][0]
    print(f"Code (raw URL-encoded): {raw_code[:60]}...")

    # TikTok docs: code value must be URL-decoded; send as-is without re-encoding.
    decoded_code = urllib.parse.unquote(raw_code)
    body = "&".join([
        f"client_key={urllib.parse.quote(client_key, safe='')}",
        f"client_secret={urllib.parse.quote(client_secret, safe='')}",
        f"code={decoded_code}",
        "grant_type=authorization_code",
        f"redirect_uri={urllib.parse.quote(REDIRECT_URI, safe='')}",
        f"code_verifier={urllib.parse.quote(code_verifier, safe='')}",
    ])

    print(f"Exchanging code for tokens...")
    print(f"Code tail: {decoded_code[-20:]!r}")
    resp = requests.post(
        TIKTOK_TOKEN_URL,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=15,
    )
    print(f"Token response: {resp.text}")
    token_data = resp.json()

    if token_data.get("error"):
        raise RuntimeError(f"Token exchange failed: {token_data}")

    kv = SecretClient(vault_url=kv_url, credential=DefaultAzureCredential())
    kv.set_secret("tiktok-refresh-token", token_data["refresh_token"])
    kv.set_secret("tiktok-access-token", token_data["access_token"])
    kv.set_secret("tiktok-open-id", token_data["open_id"])

    print("Tokens stored in Key Vault successfully.")
    print(f"  open_id: {token_data['open_id']}")
    print(f"  access_token expires_in: {token_data.get('expires_in')}s")
    print(f"  refresh_token expires_in: {token_data.get('refresh_expires_in')}s")


if __name__ == "__main__":
    main()
