"""
youtube.py – Upload a video file to YouTube using the YouTube Data API v3.

Usage:
    result = upload_video(
        access_token="...",
        refresh_token="...",
        video_path=Path("/data/output/job_id/final.mp4"),
        title="Mi podcast",
        description="Generado con Arcanator",
        on_progress=lambda msg, pct: None,
    )
    # result: {"youtube_url": "https://youtu.be/VIDEO_ID", "video_id": "VIDEO_ID"}
"""

import os
from pathlib import Path
from typing import Callable, Optional

GOOGLE_CLIENT_ID     = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")


def _build_credentials(access_token: str, refresh_token: str):
    import google.oauth2.credentials
    return google.oauth2.credentials.Credentials(
        token=access_token,
        refresh_token=refresh_token or None,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=GOOGLE_CLIENT_ID,
        client_secret=GOOGLE_CLIENT_SECRET,
        scopes=["https://www.googleapis.com/auth/youtube.upload"],
    )


def upload_video(
    access_token: str,
    refresh_token: str,
    video_path: Path,
    title: str,
    description: str,
    on_progress: Optional[Callable[[str, int], None]] = None,
) -> dict:
    """
    Upload video_path to YouTube as a private video.
    Returns {"youtube_url": "...", "video_id": "..."}.
    Raises Exception on failure.
    """
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaFileUpload
    from googleapiclient.errors import HttpError
    import google.auth.transport.requests

    credentials = _build_credentials(access_token, refresh_token)

    # Refresh token if expired
    if credentials.expired and credentials.refresh_token:
        credentials.refresh(google.auth.transport.requests.Request())

    youtube = build("youtube", "v3", credentials=credentials)

    body = {
        "snippet": {
            "title":       title[:100],        # YouTube max 100 chars
            "description": description[:5000],  # YouTube max 5000 chars
            "tags":        ["arcanator", "podcast", "video"],
            "categoryId":  "22",               # "People & Blogs"
        },
        "status": {
            "privacyStatus": "private",
            "selfDeclaredMadeForKids": False,
        },
    }

    file_size = video_path.stat().st_size
    media = MediaFileUpload(
        str(video_path),
        mimetype="video/mp4",
        resumable=True,
        chunksize=5 * 1024 * 1024,  # 5 MB chunks
    )

    request = youtube.videos().insert(
        part=",".join(body.keys()),
        body=body,
        media_body=media,
    )

    if on_progress:
        on_progress("Iniciando subida a YouTube...", 0)

    response = None
    while response is None:
        status, response = request.next_chunk()
        if status and on_progress:
            pct = int(status.progress() * 100)
            on_progress(f"Subiendo a YouTube... {pct}%", pct)

    video_id  = response["id"]
    youtube_url = f"https://youtu.be/{video_id}"

    if on_progress:
        on_progress("¡Vídeo publicado en YouTube!", 100)

    return {"youtube_url": youtube_url, "video_id": video_id}
