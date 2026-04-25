# Arcanator YouTube Agent

Expert agent for the Google OAuth + YouTube publishing feature of Arcanator.

## Feature Overview

Users can log in with their Google account and publish the generated video directly to YouTube as a private video.

## Files Added / Modified

| File | Purpose |
|------|---------|
| `backend/services/auth.py` | Google OAuth 2.0 flow + signed session cookie |
| `backend/services/youtube.py` | YouTube Data API v3 upload |
| `backend/main.py` | Auth endpoints + `/api/jobs/{id}/publish-youtube` |
| `backend/requirements.txt` | Added `google-auth-oauthlib`, `google-api-python-client`, `itsdangerous` |
| `frontend/index.html` | Auth bar + "🚀 Generar y publicar en YouTube" button |
| `frontend/app.js` | `checkAuth()`, `renderAuthBar()`, YouTube button dispatch |
| `frontend/editor.html` | Auth bar in header + "📹 Publicar en YouTube" button + modal |
| `frontend/editor.js` | `checkAuth()`, `renderAuthBar()`, `openYTModal()`, SSE YouTube events |

## API Endpoints

```
GET  /api/auth/google          → redirect to Google consent screen
GET  /api/auth/callback        → exchange code, set cookie, redirect to /
POST /api/auth/logout          → delete cookie, redirect to /
GET  /api/auth/me              → { logged_in, name, email, picture }
POST /api/jobs/{id}/publish-youtube  body: { title, description }
     → streams youtube_progress / youtube_done / youtube_error SSE events
```

## Session Cookie

- Name: `arcanator_session`
- HttpOnly, SameSite=Lax, 30-day max-age
- Signed with `itsdangerous.URLSafeSerializer` using `SECRET_KEY` env var
- Contains: `name`, `email`, `picture`, `access_token`, `refresh_token`

## Required Environment Variables (Railway)

| Variable | Description |
|----------|-------------|
| `GOOGLE_CLIENT_ID` | OAuth 2.0 Client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 Client Secret |
| `SECRET_KEY` | Random secret for signing cookies (e.g. `openssl rand -hex 32`) |

## Google Cloud Setup (one-time)

1. Create project "arcanator" at https://console.cloud.google.com
2. Enable **YouTube Data API v3**
3. Configure OAuth consent screen:
   - User type: External
   - Scopes: `openid`, `email`, `profile`, `https://www.googleapis.com/auth/youtube.upload`
4. Create OAuth 2.0 Client ID (Web application)
5. Authorized redirect URIs:
   - `https://arcanator-production.up.railway.app/api/auth/callback`
   - `http://localhost:8000/api/auth/callback`
6. Copy Client ID + Secret → set in Railway env vars

## Upload Behaviour

- Privacy: **private** (user changes it in YouTube Studio if desired)
- Resumable upload with 5 MB chunks (MediaFileUpload)
- Token auto-refresh if expired (google-auth handles it)
- SSE events: `youtube_progress { message, percent }`, `youtube_done { youtube_url }`, `youtube_error { message }`

## User Flow

### Main page (index.html)
1. Page loads → `GET /api/auth/me` → if logged in, show avatar + name + logout
2. If logged in + file selected → "🚀 Generar y publicar en YouTube" button appears
3. Clicking it sets `autoPublishYT=true` → job created normally → redirects to `/editor.html?job=ID&yt=1`

### Editor page (editor.html)
1. Page loads → `GET /api/auth/me` → renders auth bar top-right
2. After export completes → if logged in, "📹 Publicar en YouTube" appears
3. If `?yt=1` param present + logged in → modal opens automatically after export
4. Modal: pre-filled title/description → "Publicar" → SSE progress → YouTube link shown

## Debugging

**OAuth error "redirect_uri_mismatch"**: The callback URL in Google Cloud Console must exactly match what the server sends. Check `_get_redirect_uri()` in `auth.py` — it uses `request.base_url`.

**401 on publish**: Session cookie missing or expired. User must log in again.

**Token expired during upload**: `google.auth.transport.requests.Request()` refresh is called automatically before upload starts.

**`GOOGLE_CLIENT_ID not set`**: `/api/auth/google` returns 503 with clear message.
