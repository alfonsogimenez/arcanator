"""
auth.py – Google OAuth 2.0 session management for Arcanator.

Flow:
  1. GET /api/auth/google  → redirects user to Google consent screen
  2. Google redirects to GET /api/auth/callback?code=...
  3. We exchange the code for tokens, sign a session cookie, redirect to /

Session cookie:
  - Name: arcanator_session
  - HttpOnly, SameSite=Lax
  - Signed with SECRET_KEY using itsdangerous.URLSafeSerializer
  - Contains: name, email, picture, access_token, refresh_token
"""

import os
import json
from typing import Optional

from fastapi import Request, HTTPException
from fastapi.responses import RedirectResponse
from itsdangerous import URLSafeSerializer, BadSignature
from google_auth_oauthlib.flow import Flow

# ── Config ─────────────────────────────────────────────────────────────────
GOOGLE_CLIENT_ID     = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
SECRET_KEY           = os.environ.get("SECRET_KEY", "dev-secret-change-me")
COOKIE_NAME          = "arcanator_session"

# RAILWAY_PUBLIC_DOMAIN is set automatically by Railway (e.g. arcanator-production.up.railway.app)
# Use it to build a guaranteed-correct https callback URL.
# Falls back to constructing from request (for local dev).
_RAILWAY_DOMAIN = os.environ.get("RAILWAY_PUBLIC_DOMAIN", "")

_SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/youtube.upload",
]

_signer = URLSafeSerializer(SECRET_KEY, salt="session")


def _get_redirect_uri(request: Request) -> str:
    """Return the OAuth callback URL.
    In production (Railway), use RAILWAY_PUBLIC_DOMAIN to guarantee https://.
    Locally, construct from request.base_url.
    """
    if _RAILWAY_DOMAIN:
        return f"https://{_RAILWAY_DOMAIN}/api/auth/callback"
    # Local dev fallback
    base = str(request.base_url).rstrip("/")
    return f"{base}/api/auth/callback"


def _build_flow(redirect_uri: str) -> Flow:
    client_config = {
        "web": {
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [redirect_uri],
        }
    }
    flow = Flow.from_client_config(client_config, scopes=_SCOPES)
    flow.redirect_uri = redirect_uri
    return flow


# ── Cookie helpers ─────────────────────────────────────────────────────────

def sign_session(data: dict) -> str:
    return _signer.dumps(data)


def read_session(token: str) -> Optional[dict]:
    try:
        return _signer.loads(token)
    except BadSignature:
        return None


def get_current_user(request: Request) -> Optional[dict]:
    """Return user dict from cookie, or None if not logged in."""
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    return read_session(token)


def require_user(request: Request) -> dict:
    """Like get_current_user but raises 401 if not logged in."""
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Debes iniciar sesión con Google.")
    return user


# ── OAuth endpoints (called from main.py) ─────────────────────────────────

def auth_google(request: Request) -> RedirectResponse:
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        raise HTTPException(
            status_code=503,
            detail="Google OAuth no está configurado. Añade GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET."
        )
    redirect_uri = _get_redirect_uri(request)
    flow = _build_flow(redirect_uri)
    auth_url, _ = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
    )
    return RedirectResponse(auth_url)


def auth_callback(request: Request) -> RedirectResponse:
    code = request.query_params.get("code")
    if not code:
        raise HTTPException(status_code=400, detail="No se recibió el código de autorización.")

    # oauthlib raises a Warning-as-exception when Google returns fewer scopes
    # (e.g. youtube.upload not yet added to consent screen). Relax this check.
    import os as _os
    _os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")

    redirect_uri = _get_redirect_uri(request)
    flow = _build_flow(redirect_uri)

    # Exchange code for tokens
    import google.oauth2.credentials
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        flow.fetch_token(code=code)
    credentials = flow.credentials

    # Fetch user profile
    from googleapiclient.discovery import build
    service = build("oauth2", "v2", credentials=credentials)
    user_info = service.userinfo().get().execute()

    session_data = {
        "name":          user_info.get("name", ""),
        "email":         user_info.get("email", ""),
        "picture":       user_info.get("picture", ""),
        "access_token":  credentials.token,
        "refresh_token": credentials.refresh_token or "",
    }

    cookie_value = sign_session(session_data)
    response = RedirectResponse(url="/")
    response.set_cookie(
        key=COOKIE_NAME,
        value=cookie_value,
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 24 * 30,  # 30 days
        secure=False,  # set True if always HTTPS
    )
    return response


def auth_logout() -> RedirectResponse:
    response = RedirectResponse(url="/")
    response.delete_cookie(COOKIE_NAME)
    return response
