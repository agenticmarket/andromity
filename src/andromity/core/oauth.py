"""
MCP OAuth 2.1 Client — spec-compliant auth flow for remote MCP servers.

Security practices:
  - PKCE S256 mandatory (per MCP spec + RFC 7636) with cryptographically random verifier
  - State parameter (32 random bytes) for CSRF protection
  - Callback server binds ONLY to 127.0.0.1 (never 0.0.0.0)
  - Callback server shuts down immediately after receiving code
  - Constant-time state comparison (prevents timing oracle)
  - Tokens stored with expiry; refresh token rotation supported
  - Sensitive values (code_verifier, tokens) never logged
  - Token file chmod 600 (owner read/write only) on creation

References:
  - MCP Authorization spec 2025-03-26/basic/authorization
  - RFC 7591 Dynamic Client Registration
  - RFC 7636 PKCE
  - RFC 9728 OAuth 2.0 Protected Resource Metadata
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import html
import json
import logging
import os
import re
import secrets
import socket
import stat
import time
import urllib.parse
import webbrowser
from pathlib import Path
from typing import Callable, Optional

log = logging.getLogger(__name__)

# ── Constants ────────────────────────────────────────────────────────────────

CLIENT_NAME        = "Andromity"
CLIENT_VERSION     = "1.0.0"
CALLBACK_TIMEOUT_S = 120
TOKEN_FILE         = Path.home() / ".andromity" / "tokens.json"

_SUCCESS_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Andromity — Authentication Complete</title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;

      font-family:
        Inter, ui-sans-serif, system-ui, -apple-system,
        BlinkMacSystemFont, "Segoe UI", sans-serif;

      background: #0b0b0d;
      color: #ededed;
    }

    .card {
      width: min(380px, calc(100% - 40px));
      padding: 32px;

      text-align: center;

      background: #111114;
      border: 1px solid #27272a;
      border-radius: 14px;

      box-shadow:
        0 20px 60px rgba(0, 0, 0, 0.35);
    }

    .icon {
      width: 44px;
      height: 44px;
      margin: 0 auto 20px;

      display: grid;
      place-items: center;

      border-radius: 50%;
      background: #1a2a20;
      color: #62d992;

      font-size: 21px;
      font-weight: 600;
    }

    h1 {
      margin: 0 0 8px;

      font-size: 18px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }

    p {
      margin: 0;

      color: #85858b;
      font-size: 14px;
      line-height: 1.5;
    }

    .brand {
      margin-top: 24px;

      color: #4f4f55;
      font-size: 12px;
      letter-spacing: 0.02em;
    }
  </style>
</head>

<body>
  <main class="card">
    <div class="icon">✓</div>

    <h1>Authentication successful</h1>

    <p>
      You're signed in to Andromity.<br>
      You can close this tab and return to the application.
    </p>

    <div class="brand">ANDROMITY</div>
  </main>
</body>
</html>
""".encode("utf-8")

def _error_html(reason: str) -> bytes:
    return (
        "<!DOCTYPE html><html><head><meta charset='utf-8'>"
        "<title>Andromity \u2014 Auth Error</title>"
        "<style>"
        "body{font-family:system-ui,sans-serif;background:#0e0e10;color:#e0e0e0;"
        "display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}"
        ".box{text-align:center;padding:2rem 3rem;border:1px solid #500;"
        "border-radius:12px;background:#18181b}"
        ".icon{font-size:3rem;margin-bottom:1rem}"
        "h1{margin:0 0 .5rem;font-size:1.5rem;color:#f87171}"
        "p{color:#888;margin:0}"
        "</style></head><body>"
        "<div class='box'>"
        "<div class='icon'>\u274c</div>"
        f"<h1>Authentication Failed</h1><p>{html.escape(reason)}</p>"
        "</div></body></html>"
    ).encode("utf-8")


# ── PKCE (RFC 7636) ──────────────────────────────────────────────────────────

def pkce_generate() -> tuple[str, str]:
    """
    Return (code_verifier, code_challenge) using S256 method.
    code_verifier: 43-char URL-safe base64, no padding (256-bit entropy).
    code_challenge: base64url(SHA-256(code_verifier)), no padding.
    """
    raw            = secrets.token_bytes(32)
    code_verifier  = base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
    digest         = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return code_verifier, code_challenge


# ── Port Discovery ────────────────────────────────────────────────────────────

def _find_free_port(start: int = 54321, attempts: int = 10) -> int:
    for port in range(start, start + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise OSError(f"No free port in {start}\u2013{start + attempts}")


# ── OAuth Metadata Discovery (RFC 9728) ───────────────────────────────────────

async def discover_metadata(server_url: str) -> Optional[dict]:
    """Discover the resource's authorization server, including RFC 9728 challenges."""
    import httpx
    parsed = urllib.parse.urlparse(server_url)
    base = f"{parsed.scheme}://{parsed.netloc}"
    resource = base + parsed.path
    probes = []
    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
        try:
            async with client.stream("GET", server_url, headers={"Accept": "application/json, text/event-stream"}) as response:
                challenge = response.headers.get("www-authenticate", "")
            match = re.search(r'resource_metadata="([^"]+)"', challenge, re.I)
            if match:
                probes.append(match.group(1))
        except httpx.HTTPError:
            pass
        if parsed.path.strip("/"):
            probes.append(f"{base}/.well-known/oauth-protected-resource{parsed.path}")
        probes.append(f"{base}/.well-known/oauth-protected-resource")
        issuers = []
        resource_scopes = None
        for url in probes:
            try:
                r = await client.get(url)
                if r.status_code == 200:
                    document = r.json()
                    advertised = document.get("resource")
                    if advertised != resource:
                        continue
                    issuers = document.get("authorization_servers", [])
                    if issuers:
                        resource_scopes = document.get("scopes_supported")
                        break
            except (httpx.HTTPError, ValueError, AttributeError):
                continue
        # Legacy servers publish authorization metadata directly at their origin.
        for issuer in issuers or [base]:
            if not isinstance(issuer, str):
                continue
            auth = urllib.parse.urlparse(issuer)
            if auth.scheme not in ("https", "http") or not auth.netloc:
                continue
            origin = f"{auth.scheme}://{auth.netloc}"
            path = auth.path.rstrip("/")
            for url in dict.fromkeys([
                f"{origin}/.well-known/oauth-authorization-server{path}",
                f"{origin}/.well-known/openid-configuration{path}",
                f"{issuer.rstrip('/')}/.well-known/openid-configuration",
            ]):
                try:
                    r = await client.get(url)
                    if r.status_code != 200:
                        continue
                    meta = r.json()
                    if meta.get("issuer") != issuer:
                        continue
                    if meta.get("authorization_endpoint") and meta.get("token_endpoint"):
                        meta["resource"] = resource
                        if resource_scopes is not None:
                            meta["scopes_supported"] = resource_scopes
                        return meta
                except (httpx.HTTPError, ValueError, AttributeError):
                    continue
    return None


# ── Dynamic Client Registration (RFC 7591) ────────────────────────────────────

async def dynamic_register(registration_endpoint: str, redirect_uri: str, auth_method: str = "none") -> Optional[dict]:
    """
    Register Andromity using the authorization server's supported auth method.
    Returns registration dict (containing client_id) or None.
    """
    import httpx

    payload = {
        "client_name":                f"{CLIENT_NAME} v{CLIENT_VERSION}",
        "redirect_uris":              [redirect_uri],
        "grant_types":                ["authorization_code", "refresh_token"],
        "response_types":             ["code"],
        "token_endpoint_auth_method": auth_method,
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                registration_endpoint,
                json=payload,
                headers={"Content-Type": "application/json"},
            )
            r.raise_for_status()
            reg = r.json()
            log.info("DCR OK: client_id=%s", reg.get("client_id"))
            return reg
    except Exception as exc:
        log.warning("DCR failed: %s", exc)
        return None


# ── Local Callback Server ─────────────────────────────────────────────────────

async def run_callback_server(
    port: int,
    expected_state: str,
    timeout: float = CALLBACK_TIMEOUT_S,
    ready: Optional[asyncio.Event] = None,
) -> Optional[str]:
    """
    Asyncio TCP server on 127.0.0.1:PORT.
    Waits for GET /callback?code=xxx&state=yyy from the OAuth redirect.
    Validates state (CSRF) with constant-time comparison.
    Returns authorization code or None on timeout/error.
    """
    loop     = asyncio.get_running_loop()
    code_fut: asyncio.Future[Optional[str]] = loop.create_future()

    async def _handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            first = (await asyncio.wait_for(reader.readline(), 5.0)).decode("utf-8", "replace").strip()
            while True:                          # drain headers
                line = await asyncio.wait_for(reader.readline(), 5.0)
                if line in (b"\r\n", b"\n", b""):
                    break

            parts  = first.split()
            path   = parts[1] if len(parts) > 1 else "/"
            qs     = urllib.parse.parse_qs(urllib.parse.urlparse(path).query)
            code   = qs.get("code",  [""])[0]
            state  = qs.get("state", [""])[0]
            error  = qs.get("error", [""])[0]

            if path.split("?")[0] not in ("/callback", "/"):
                _http(writer, 404, b"")
            elif not _ct_eq(state, expected_state):
                _http(writer, 403, _error_html("Invalid state. Please retry authentication."))
            elif error:
                desc = qs.get("error_description", [error])[0]
                _http(writer, 400, _error_html(urllib.parse.unquote(desc)))
                if not code_fut.done():
                    code_fut.set_result(None)
            elif code:
                _http(writer, 200, _SUCCESS_HTML, b"text/html")
                if not code_fut.done():
                    code_fut.set_result(code)
            else:
                _http(writer, 400, _error_html("Missing authorization code. Please retry."))
                if not code_fut.done():
                    code_fut.set_result(None)
        except Exception as exc:
            log.debug("Callback handler: %s", exc)
            if not code_fut.done():
                code_fut.set_result(None)
        finally:
            try:
                await writer.drain()
                writer.close()
            except Exception:
                pass

    server = await asyncio.start_server(_handle, host="127.0.0.1", port=port)
    if ready:
        ready.set()
    log.debug("Callback server on 127.0.0.1:%d", port)
    try:
        async with server:
            return await asyncio.wait_for(code_fut, timeout=timeout)
    except asyncio.TimeoutError:
        log.warning("OAuth callback timed out after %ss", timeout)
        return None


def _http(writer: asyncio.StreamWriter, status: int, body: bytes, ctype: bytes = b"text/html"):
    txt = {200: b"OK", 400: b"Bad Request", 403: b"Forbidden"}.get(status, b"OK")
    header = (
        b"HTTP/1.1 " + str(status).encode() + b" " + txt + b"\r\n"
        b"Content-Type: " + ctype + b"; charset=utf-8\r\n"
        b"Content-Length: " + str(len(body)).encode() + b"\r\n"
        b"Connection: close\r\n\r\n"
    )
    writer.write(header + body)


def _ct_eq(a: str, b: str) -> bool:
    """Constant-time comparison to prevent timing attacks on state param."""
    return secrets.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


# ── Token Exchange ────────────────────────────────────────────────────────────

async def exchange_code(
    token_endpoint: str,
    code: str,
    code_verifier: str,   # never logged
    client_id: str,
    redirect_uri: str,
    resource: Optional[str] = None,
    client_secret: Optional[str] = None,
    auth_method: str = "none",
) -> Optional[dict]:
    import httpx
    payload = {
        "grant_type":    "authorization_code",
        "code":          code,
        "redirect_uri":  redirect_uri,
        "client_id":     client_id,
        "code_verifier": code_verifier,
    }
    if resource:
        payload["resource"] = resource
    auth = None
    if auth_method == "client_secret_basic":
        if not client_secret:
            return None
        auth = httpx.BasicAuth(urllib.parse.quote_plus(client_id), urllib.parse.quote_plus(client_secret))
        payload.pop("client_id")
    elif auth_method == "client_secret_post":
        if not client_secret:
            return None
        payload["client_secret"] = client_secret
    try:
        async with httpx.AsyncClient(timeout=15.0) as c:
            r = await c.post(
                token_endpoint, data=payload, auth=auth,
                headers={"Content-Type": "application/x-www-form-urlencoded"})
            r.raise_for_status()
            return r.json()
    except Exception as exc:
        log.warning("Token exchange failed: %s", exc)
        return None


async def refresh_access_token(
    token_endpoint: str,
    refresh_token: str,
    client_id: str,
    resource: Optional[str] = None,
    client_secret: Optional[str] = None,
    auth_method: str = "none",
) -> Optional[dict]:
    import httpx
    payload = {
        "grant_type":    "refresh_token",
        "refresh_token": refresh_token,
        "client_id":     client_id,
    }
    if resource:
        payload["resource"] = resource
    auth = None
    if auth_method == "client_secret_basic":
        if not client_secret:
            return None
        auth = httpx.BasicAuth(urllib.parse.quote_plus(client_id), urllib.parse.quote_plus(client_secret))
        payload.pop("client_id")
    elif auth_method == "client_secret_post":
        if not client_secret:
            return None
        payload["client_secret"] = client_secret
    try:
        async with httpx.AsyncClient(timeout=15.0) as c:
            r = await c.post(
                token_endpoint, data=payload, auth=auth,
                headers={"Content-Type": "application/x-www-form-urlencoded"})
            r.raise_for_status()
            return r.json()
    except Exception as exc:
        log.warning("Token refresh failed: %s", exc)
        return None


# ── Token Persistence ─────────────────────────────────────────────────────────

def _encrypt_bytes(raw: bytes) -> bytes:
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes
            class DATA_BLOB(ctypes.Structure):
                _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]
            in_blob = DATA_BLOB(len(raw), ctypes.cast(raw, ctypes.POINTER(ctypes.c_char)))
            out_blob = DATA_BLOB()
            if ctypes.windll.crypt32.CryptProtectData(ctypes.byref(in_blob), "andromity_token", None, None, None, 0, ctypes.byref(out_blob)):
                encrypted = ctypes.string_at(out_blob.pbData, out_blob.cbData)
                ctypes.windll.kernel32.LocalFree(out_blob.pbData)
                return b"DPAPI:" + encrypted
        except Exception as e:
            log.debug("DPAPI encryption fallback: %s", e)
    return raw


def _decrypt_bytes(enc: bytes) -> bytes:
    if os.name == "nt" and enc.startswith(b"DPAPI:"):
        try:
            import ctypes
            from ctypes import wintypes
            class DATA_BLOB(ctypes.Structure):
                _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]
            raw_enc = enc[6:]
            in_blob = DATA_BLOB(len(raw_enc), ctypes.cast(raw_enc, ctypes.POINTER(ctypes.c_char)))
            out_blob = DATA_BLOB()
            if ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(in_blob), None, None, None, None, 0, ctypes.byref(out_blob)):
                decrypted = ctypes.string_at(out_blob.pbData, out_blob.cbData)
                ctypes.windll.kernel32.LocalFree(out_blob.pbData)
                return decrypted
        except Exception as e:
            log.debug("DPAPI decryption failed: %s", e)
    return enc


def _load_store() -> dict:
    if not TOKEN_FILE.is_file():
        return {}
    try:
        raw_bytes = TOKEN_FILE.read_bytes()
        decrypted = _decrypt_bytes(raw_bytes)
        return json.loads(decrypted.decode("utf-8"))
    except Exception:
        return {}


def _normalize_origin(url: Optional[str]) -> str:
    if not url:
        return ""
    try:
        p = urllib.parse.urlparse(url)
        if p.scheme and p.netloc:
            return f"{p.scheme}://{p.netloc}".lower()
    except Exception:
        pass
    return url.strip().lower()


def _save_store(store: dict) -> None:
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(store, indent=2).encode("utf-8")
    encrypted = _encrypt_bytes(serialized)
    if os.name == "nt":
        TOKEN_FILE.write_bytes(encrypted)
    else:
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
        fd = os.open(TOKEN_FILE, flags, stat.S_IRUSR | stat.S_IWUSR)
        with open(fd, "wb") as f:
            f.write(encrypted)


def store_token(server_name: str, token_resp: dict, client_id: str, token_endpoint: str, resource: Optional[str] = None,
                client_secret: Optional[str] = None, auth_method: str = "none") -> None:
    store = _load_store()
    expires_in = int(token_resp.get("expires_in") or 0)
    store[server_name] = {
        "access_token":   token_resp.get("access_token", ""),
        "refresh_token":  token_resp.get("refresh_token", ""),
        "expires_at":     int(time.time()) + expires_in if expires_in else 0,
        "client_id":      client_id,
        "token_endpoint": token_endpoint,
        "resource":       resource,
        "client_secret":  client_secret,
        "token_endpoint_auth_method": auth_method,
    }
    _save_store(store)
    log.info("Token stored for '%s'", server_name)


def load_token(server_name: str, server_url: Optional[str] = None) -> Optional[dict]:
    entry = _load_store().get(server_name)
    if not entry or not entry.get("access_token"):
        return None
    if server_url and entry.get("resource"):
        stored_origin = _normalize_origin(entry["resource"])
        requested_origin = _normalize_origin(server_url)
        if stored_origin and requested_origin and stored_origin != requested_origin:
            log.warning(
                "Blocked token replay for server '%s': requested origin '%s' does not match stored origin '%s'",
                server_name, requested_origin, stored_origin
            )
            return None
    exp = entry.get("expires_at", 0)
    if exp and time.time() > exp - 60 and not entry.get("refresh_token"):
        return None          # expired, no refresh possible
    return entry


def clear_token(server_name: str) -> None:
    store = _load_store()
    store.pop(server_name, None)
    _save_store(store)


async def ensure_fresh_token(server_name: str, server_url: Optional[str] = None) -> Optional[str]:
    """Return valid access_token, auto-refreshing if expired. None = re-auth needed."""
    try:
        entry = load_token(server_name, server_url=server_url)
    except TypeError:
        entry = load_token(server_name)
    if not entry:
        return None
    exp = entry.get("expires_at", 0)
    if not exp or time.time() < exp - 60:
        return entry.get("access_token")
    # Refresh
    new_tok = await refresh_access_token(
        entry["token_endpoint"], entry["refresh_token"], entry["client_id"], entry.get("resource"),
        client_secret=entry.get("client_secret"), auth_method=entry.get("token_endpoint_auth_method", "none"))
    if not new_tok or not new_tok.get("access_token"):
        clear_token(server_name)
        return None
    if not new_tok.get("refresh_token"):
        new_tok["refresh_token"] = entry["refresh_token"]
    store_token(server_name, new_tok, entry["client_id"], entry["token_endpoint"], entry.get("resource"),
                client_secret=entry.get("client_secret"), auth_method=entry.get("token_endpoint_auth_method", "none"))
    return new_tok["access_token"]


# ── Full Flow Orchestrator ────────────────────────────────────────────────────

async def full_oauth_flow(
    server_name: str,
    server_url: str,
    on_status: Callable[[str], None],
    client_id: Optional[str] = None,
    client_secret: Optional[str] = None,
) -> Optional[str]:
    """
    Complete OAuth 2.1 + PKCE + DCR flow.
    Calls on_status(msg) with progress updates for UI display.
    Returns access_token string, or None on failure.
    """
    on_status("🔍 Discovering OAuth endpoints…")
    meta = await discover_metadata(server_url)
    if not meta:
        on_status("⚠ Server does not expose OAuth metadata. Use PAT instead.")
        return None

    auth_ep  = meta.get("authorization_endpoint")
    token_ep = meta.get("token_endpoint")
    reg_ep   = meta.get("registration_endpoint")

    if not auth_ep or not token_ep:
        on_status("⚠ Incomplete OAuth metadata. Use PAT instead.")
        return None

    # Free port for callback
    try:
        port = _find_free_port()
    except OSError as exc:
        on_status(f"⚠ No free port available: {exc}")
        return None

    redirect_uri = f"http://127.0.0.1:{port}/callback"
    methods = meta.get("token_endpoint_auth_methods_supported", ["none"])
    auth_method = next((method for method in ("none", "client_secret_basic", "client_secret_post") if method in methods), None)
    if auth_method is None:
        on_status("This server's token authentication method is not supported. Use an access token.")
        return None

    # Dynamic Client Registration
    if reg_ep and not client_id:
        on_status("📋 Registering Andromity as OAuth client…")
        reg = await dynamic_register(reg_ep, redirect_uri, auth_method=auth_method)
        if reg and reg.get("client_id"):
            client_id = reg["client_id"]
            client_secret = reg.get("client_secret")
            auth_method = reg.get("token_endpoint_auth_method", auth_method)
        else:
            on_status("Client registration failed. Retry or configure oauth.client_id for a registered public client.")
            return None
    if not client_id:
        on_status("This server requires a registered public client. Configure oauth.client_id or use an access token.")
        return None
    if auth_method not in ("none", "client_secret_basic", "client_secret_post"):
        on_status("The registered client's authentication method is not supported.")
        return None
    if auth_method != "none" and not client_secret:
        on_status("This server requires a client secret. Retry registration or configure oauth.client_secret.")
        return None

    # PKCE + state
    code_verifier, code_challenge = pkce_generate()
    state = secrets.token_hex(32)

    # Build auth URL (resource indicator RFC 8707 binds token to this server)
    scopes     = meta.get("scopes_supported", [])
    scope_str  = " ".join(scopes) if isinstance(scopes, list) else str(scopes)
    resource = meta.get("resource") or server_url.split("?")[0]
    auth_params = {
        "client_id":             client_id,
        "response_type":         "code",
        "redirect_uri":          redirect_uri,
        "state":                 state,
        "code_challenge":        code_challenge,
        "code_challenge_method": "S256",
        "resource":              resource,
    }
    if scope_str:
        auth_params["scope"] = scope_str
    auth_url = auth_ep + ("&" if "?" in auth_ep else "?") + urllib.parse.urlencode(auth_params)

    on_status(f"🌐 Opening browser… (waiting up to {CALLBACK_TIMEOUT_S}s)")
    ready = asyncio.Event()
    callback = asyncio.create_task(run_callback_server(port, expected_state=state, ready=ready))
    listener_ready = asyncio.create_task(ready.wait())
    try:
        await asyncio.wait([callback, listener_ready], return_when=asyncio.FIRST_COMPLETED)
        if callback.done():
            await callback
            return None
        await asyncio.to_thread(webbrowser.open, auth_url)
        on_status("⏳ Waiting for authentication in browser…")
        code = await callback
    finally:
        if not callback.done():
            callback.cancel()
        listener_ready.cancel()
        await asyncio.gather(callback, listener_ready, return_exceptions=True)

    if not code:
        on_status("⏱ Authentication timed out or was cancelled.")
        return None

    on_status("🔑 Exchanging authorization code for token…")
    tok = await exchange_code(token_ep, code, code_verifier, client_id, redirect_uri, resource,
                              client_secret=client_secret, auth_method=auth_method)

    if not tok or not tok.get("access_token"):
        on_status("✕ Token exchange failed. Please try again.")
        return None

    store_token(server_name, tok, client_id, token_ep, resource,
                client_secret=client_secret, auth_method=auth_method)
    on_status("✅ Authenticated! Token saved.")
    return tok["access_token"]
