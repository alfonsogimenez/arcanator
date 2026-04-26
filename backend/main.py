import uuid
import queue
import threading
import time
import json
import io
import os
from pathlib import Path

# Load .env file for local development (no-op if not present)
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent.parent / ".env")
except ImportError:
    pass
from typing import Dict, Optional

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
import asyncio

# OUTPUT_DIR can be overridden by environment variable (Railway volume mount)
_env_output = os.environ.get("OUTPUT_DIR")
if _env_output:
    OUTPUT_DIR = Path(_env_output)
else:
    BASE_DIR   = Path(__file__).parent.parent
    OUTPUT_DIR = BASE_DIR / "output"

# Frontend is at project root/frontend both locally and in Docker
BASE_DIR     = Path(__file__).parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Arcanator")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health():
    return JSONResponse({"status": "ok"})


# ---------------------------------------------------------------------------
# Admin: disk cleanup  (keep N most recent jobs, delete the rest)
# ---------------------------------------------------------------------------
@app.post("/api/admin/cleanup")
async def cleanup_old_jobs(keep: int = 3):
    """Delete all but the {keep} most recent jobs from disk and memory."""
    import shutil as _shutil
    with _lock:
        all_ids = list(_jobs.keys())

    # Sort by job directory mtime (newest first)
    def _mtime(jid):
        p = OUTPUT_DIR / jid
        return p.stat().st_mtime if p.exists() else 0

    sorted_ids = sorted(all_ids, key=_mtime, reverse=True)
    to_delete  = sorted_ids[keep:]
    freed_dirs = []

    for jid in to_delete:
        job_dir = OUTPUT_DIR / jid
        try:
            if job_dir.exists():
                _shutil.rmtree(str(job_dir))
                freed_dirs.append(jid)
        except Exception as e:
            print(f"[cleanup] could not remove {jid}: {e}")
        with _lock:
            _jobs.pop(jid, None)
            _event_queues.pop(jid, None)

    # Also remove orphan dirs not in _jobs
    for d in OUTPUT_DIR.iterdir():
        if d.is_dir() and d.name not in sorted_ids[:keep]:
            try:
                _shutil.rmtree(str(d))
                freed_dirs.append(d.name)
            except Exception:
                pass

    return JSONResponse({"deleted": len(freed_dirs), "kept": keep, "ids": freed_dirs})

# ---------------------------------------------------------------------------
# In-memory job store
# ---------------------------------------------------------------------------
_jobs: Dict[str, dict] = {}
_event_queues: Dict[str, queue.Queue] = {}
_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Disk persistence helpers
# ---------------------------------------------------------------------------
def _save_job(job_id: str):
    """Write job state to OUTPUT_DIR/{job_id}/job.json (best effort)."""
    try:
        with _lock:
            job = dict(_jobs.get(job_id, {}))
        if not job:
            return
        job_path = OUTPUT_DIR / job_id / "job.json"
        job_path.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
    except Exception as exc:
        print(f"[main] Error saving job {job_id}: {exc}")


def _load_jobs_from_disk():
    """Scan output dir and load all persisted jobs into _jobs on startup."""
    loaded = 0
    for job_json in OUTPUT_DIR.glob("*/job.json"):
        try:
            data = json.loads(job_json.read_text(encoding="utf-8"))
            job_id = data.get("id")
            if not job_id:
                continue
            # Jobs that were in-flight when the server died
            status = data.get("status", "")
            if status in ("queued", "transcribing", "generating_images"):
                data["status"] = "error"
                data["error"] = "El servidor se reinici\u00f3 durante el procesamiento."
            elif status == "exporting":
                # Images are already on disk — allow re-export
                data["status"] = "ready"
                data["error"] = None
            with _lock:
                _jobs[job_id] = data
                if job_id not in _event_queues:
                    _event_queues[job_id] = queue.Queue(maxsize=2000)
            loaded += 1
        except Exception as exc:
            print(f"[main] Error loading {job_json}: {exc}")
    if loaded:
        print(f"[main] {loaded} job(s) cargados desde disco.")


@app.on_event("startup")
async def _startup():
    _load_jobs_from_disk()


def _get_job_or_404(job_id: str) -> dict:
    with _lock:
        job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


def _update_job(job_id: str, **kwargs):
    with _lock:
        if job_id in _jobs:
            _jobs[job_id].update(kwargs)
    _save_job(job_id)


def _push_event(job_id: str, event_type: str, data: dict):
    """Push an SSE-formatted event string into the job queue."""
    with _lock:
        q = _event_queues.get(job_id)
    if q:
        payload = f"event: {event_type}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
        try:
            q.put_nowait(payload)
        except queue.Full:
            pass  # Drop if queue full to avoid memory leak


# ---------------------------------------------------------------------------
# API: Create job
# ---------------------------------------------------------------------------
@app.post("/api/jobs")
async def create_job(
    audio: UploadFile = File(...),
    interval: int = Form(10),
):
    if not (5 <= interval <= 60):
        raise HTTPException(status_code=400, detail="El intervalo debe estar entre 5 y 60 segundos.")

    job_id = str(uuid.uuid4())
    job_dir = OUTPUT_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    (job_dir / "images").mkdir(exist_ok=True)
    (job_dir / "segments").mkdir(exist_ok=True)

    suffix = Path(audio.filename or "audio.mp3").suffix.lower()
    if suffix not in (".mp3", ".wav", ".m4a", ".ogg", ".flac", ".mp4", ".webm"):
        suffix = ".mp3"
    audio_path = job_dir / f"audio{suffix}"
    content = await audio.read()
    audio_path.write_bytes(content)

    job = {
        "id": job_id,
        "status": "queued",
        "audio_path": str(audio_path),
        "audio_url": f"/output/{job_id}/audio{suffix}",
        "interval": interval,
        "slots": [],
        "progress_message": "En cola...",
        "progress_percent": 0,
        "error": None,
        "download_url": None,
    }
    with _lock:
        _jobs[job_id] = job
        _event_queues[job_id] = queue.Queue(maxsize=2000)
    _save_job(job_id)

    thread = threading.Thread(target=_process_job, args=(job_id,), daemon=True)
    thread.start()
    return {"job_id": job_id}


# ---------------------------------------------------------------------------
# API: Job status (polling fallback)
# ---------------------------------------------------------------------------
@app.get("/api/jobs/{job_id}")
async def get_job_status(job_id: str):
    return _get_job_or_404(job_id)


# ---------------------------------------------------------------------------
# API: SSE stream
# ---------------------------------------------------------------------------
@app.get("/api/jobs/{job_id}/stream")
async def stream_events(job_id: str):
    _get_job_or_404(job_id)  # 404 if not found

    with _lock:
        q = _event_queues.get(job_id)

    async def generator():
        # Send a snapshot of current state first so the client can bootstrap
        with _lock:
            job = dict(_jobs.get(job_id, {}))
        snapshot = {
            "status": job.get("status"),
            "progress_message": job.get("progress_message"),
            "progress_percent": job.get("progress_percent"),
            "slots": job.get("slots", []),
        }
        yield f"event: state\ndata: {json.dumps(snapshot, ensure_ascii=False)}\n\n"

        if job.get("status") in ("done", "error"):
            return

        while True:
            try:
                event = q.get_nowait()
                yield event
                if '"event": "done"' in event or "event: done" in event or "event: error" in event:
                    break
            except queue.Empty:
                yield ": keepalive\n\n"
                await asyncio.sleep(0.25)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ---------------------------------------------------------------------------
# API: Update job metadata (overlay_text, etc.)
# ---------------------------------------------------------------------------
@app.patch("/api/jobs/{job_id}")
async def update_job_meta(job_id: str, body: dict):
    _get_job_or_404(job_id)
    allowed = {"overlay_text"}
    update = {k: v for k, v in body.items() if k in allowed}
    if not update:
        raise HTTPException(status_code=400, detail="No hay campos válidos para actualizar.")
    _update_job(job_id, **update)
    return {"ok": True}


# ---------------------------------------------------------------------------
# API: Bulk-replace all slots (resize / add / delete columns)
# ---------------------------------------------------------------------------
@app.put("/api/jobs/{job_id}/slots")
async def put_slots(job_id: str, body: dict):
    _get_job_or_404(job_id)
    new_slots = body.get("slots")
    if not isinstance(new_slots, list):
        raise HTTPException(status_code=400, detail="Se espera { slots: [...] }")
    # Re-index to keep indices consistent
    for i, s in enumerate(new_slots):
        s["index"] = i
    _update_job(job_id, slots=new_slots)
    return {"ok": True, "count": len(new_slots)}


# ---------------------------------------------------------------------------
# API: Replace slot image
# ---------------------------------------------------------------------------
@app.patch("/api/jobs/{job_id}/slots/{index}")
async def replace_slot_image(job_id: str, index: int, image: UploadFile = File(...)):
    job = _get_job_or_404(job_id)
    slots = job.get("slots", [])
    if index < 0 or index >= len(slots):
        raise HTTPException(status_code=400, detail="Índice de slot inválido.")

    content = await image.read()
    img = Image.open(io.BytesIO(content)).convert("RGB")

    # Fit-and-crop to exactly 1920x1080 preserving aspect ratio
    target_w, target_h = 1920, 1080
    img_ratio = img.width / img.height
    target_ratio = target_w / target_h
    if img_ratio > target_ratio:
        new_h = target_h
        new_w = int(new_h * img_ratio)
    else:
        new_w = target_w
        new_h = int(new_w / img_ratio)
    img = img.resize((new_w, new_h), Image.LANCZOS)
    left = (new_w - target_w) // 2
    top = (new_h - target_h) // 2
    img = img.crop((left, top, left + target_w, top + target_h))

    job_dir = OUTPUT_DIR / job_id
    image_path = job_dir / "images" / f"{index:04d}.jpg"
    img.save(str(image_path), "JPEG", quality=95)

    image_url = f"/output/{job_id}/images/{index:04d}.jpg"
    with _lock:
        _jobs[job_id]["slots"][index]["image_url"] = image_url
        _jobs[job_id]["slots"][index]["image_path"] = str(image_path)
        _jobs[job_id]["slots"][index]["custom"] = True

    # Rebuild candidates list with new image as first entry
    with _lock:
        existing = _jobs[job_id]["slots"][index].get("candidates", [])
        new_candidate = {"url": "", "path": str(image_path), "image_url": image_url}
        _jobs[job_id]["slots"][index]["candidates"] = [new_candidate] + [
            c for c in existing if c.get("image_url") != image_url
        ]
    _save_job(job_id)

    return {"image_url": image_url, "candidates": _jobs[job_id]["slots"][index]["candidates"]}


# ---------------------------------------------------------------------------
# API: Select candidate image for a slot
# ---------------------------------------------------------------------------
@app.post("/api/jobs/{job_id}/slots/{index}/select-candidate")
async def select_candidate(job_id: str, index: int, body: dict):
    job = _get_job_or_404(job_id)
    slots = job.get("slots", [])
    if index < 0 or index >= len(slots):
        raise HTTPException(status_code=400, detail="Indice de slot invalido.")

    candidate_index = body.get("candidate_index", 0)
    with _lock:
        candidates = _jobs[job_id]["slots"][index].get("candidates", [])
        if candidate_index < 0 or candidate_index >= len(candidates):
            raise HTTPException(status_code=400, detail="candidate_index invalido.")
        # Rotate so selected candidate is first
        reordered = [candidates[candidate_index]] + [
            c for i, c in enumerate(candidates) if i != candidate_index
        ]
        _jobs[job_id]["slots"][index]["candidates"] = reordered
        _jobs[job_id]["slots"][index]["image_url"]  = reordered[0]["image_url"]
        _jobs[job_id]["slots"][index]["image_path"] = reordered[0]["path"]
    _save_job(job_id)

    return {"image_url": reordered[0]["image_url"], "candidates": reordered}


# ---------------------------------------------------------------------------
# API: Free-text image search with offset (for the panel custom search)
# ---------------------------------------------------------------------------
@app.get("/api/search")
async def free_search_images(q: str, offset: int = 0):
    if not q.strip():
        raise HTTPException(status_code=400, detail="Query vacía.")
    from backend.services.image_gen import _scrape_bing_image_entries
    # Vary the query slightly per page so Bing returns different results
    query = q.strip()
    if offset > 0:
        query = f"{query} {offset}"
    raw = _scrape_bing_image_entries(query, count=24)
    entries = [{"url": e["murl"], "page_url": e["purl"]} for e in raw]
    return {"entries": entries, "query": q.strip(), "offset": offset}


# ---------------------------------------------------------------------------
# API: Search more images for a slot (returns external URLs, no download)
# ---------------------------------------------------------------------------
@app.get("/api/jobs/{job_id}/slots/{index}/search")
async def search_slot_images(job_id: str, index: int):
    job = _get_job_or_404(job_id)
    slots = job.get("slots", [])
    if index < 0 or index >= len(slots):
        raise HTTPException(status_code=400, detail="Indice de slot invalido.")

    from backend.services.image_gen import _scrape_bing_image_entries
    query = slots[index].get("prompt", slots[index].get("text", ""))
    raw   = _scrape_bing_image_entries(query, count=24)
    entries = [{"url": e["murl"], "page_url": e["purl"]} for e in raw]
    return {"entries": entries, "query": query}


# ---------------------------------------------------------------------------
# API: Use an external URL as the selected image for a slot
# ---------------------------------------------------------------------------
@app.post("/api/jobs/{job_id}/slots/{index}/use-url")
async def use_url_for_slot(job_id: str, index: int, body: dict):
    job = _get_job_or_404(job_id)
    slots = job.get("slots", [])
    if index < 0 or index >= len(slots):
        raise HTTPException(status_code=400, detail="Indice de slot invalido.")

    url = body.get("url", "").strip()
    if not url.startswith("http") and not url.startswith("/output/"):
        raise HTTPException(status_code=400, detail="URL invalida.")

    import shutil as _shutil
    from backend.services.image_gen import download_url_to_path
    job_dir    = OUTPUT_DIR / job_id
    images_dir = job_dir / "images"
    images_dir.mkdir(exist_ok=True)

    with _lock:
        n_cands = len(_jobs[job_id]["slots"][index].get("candidates", []))
    file_idx  = n_cands  # append as new file
    out_path  = images_dir / f"{index}_{file_idx}.jpg"

    if url.startswith("/output/"):
        # Local file — resolve path and copy (avoids HTTP round-trip)
        rel = url[len("/output/"):]
        src = OUTPUT_DIR / rel
        if not src.exists():
            raise HTTPException(status_code=404, detail="Fichero local no encontrado.")
        _shutil.copy2(str(src), str(out_path))
        ok = True
    else:
        ok = download_url_to_path(url, out_path)

    if not ok:
        raise HTTPException(status_code=422, detail="No se pudo descargar la imagen desde esa URL.")

    image_url  = f"/output/{job_id}/images/{index}_{file_idx}.jpg"
    page_url   = body.get("page_url", "").strip()
    new_cand   = {"url": url, "page_url": page_url, "path": str(out_path), "image_url": image_url}

    with _lock:
        existing = _jobs[job_id]["slots"][index].get("candidates", [])
        reordered = [new_cand] + existing
        _jobs[job_id]["slots"][index]["candidates"] = reordered
        _jobs[job_id]["slots"][index]["image_url"]  = image_url
        _jobs[job_id]["slots"][index]["image_path"] = str(out_path)

    _save_job(job_id)
    return {"image_url": image_url, "candidates": reordered}


# ---------------------------------------------------------------------------
# API: Export video
# ---------------------------------------------------------------------------
@app.post("/api/jobs/{job_id}/export")
async def export_video(job_id: str):
    job = _get_job_or_404(job_id)
    # Allow re-export if a previous export was interrupted (status=error but images exist)
    if job["status"] == "error" and job.get("slots") and all(
        s.get("image_path") for s in job["slots"]
    ):
        _update_job(job_id, status="ready", error=None)
        job = _get_job_or_404(job_id)
    if job["status"] not in ("ready", "done"):
        raise HTTPException(status_code=400, detail="El job no está listo para exportar.")

    overlay_text = (job.get("overlay_text") or "").strip()
    if not overlay_text:
        raise HTTPException(status_code=422, detail="El texto de cabecera es obligatorio antes de exportar.")

    # Reset queue for export events
    with _lock:
        _event_queues[job_id] = queue.Queue(maxsize=2000)

    _update_job(job_id, status="exporting", progress_message="Iniciando exportación...", progress_percent=0)
    thread = threading.Thread(target=_run_export, args=(job_id, overlay_text), daemon=True)
    thread.start()
    return {"status": "exporting"}


# ---------------------------------------------------------------------------
# Background workers
# ---------------------------------------------------------------------------
def _process_job(job_id: str):
    try:
        from backend.services.video_gen import _get_audio_duration, check_ffmpeg

        with _lock:
            job = dict(_jobs[job_id])
        audio_path = job["audio_path"]

        _update_job(job_id, status="transcribing", progress_message="Analizando audio...", progress_percent=50)
        _push_event(job_id, "progress", {"message": "Analizando audio...", "percent": 50})

        ffmpeg = check_ffmpeg()
        audio_duration = _get_audio_duration(Path(audio_path), ffmpeg)
        audio_end = round(audio_duration, 2) if audio_duration > 0 else 0.0

        initial_slots = [
            {
                "index": 0,
                "start": 0.0,
                "end": min(5.0, audio_end),
                "text": "",
                "prompt": "",
                "image_url": None,
                "image_path": None,
                "custom": False,
                "candidates": [],
            }
        ]

        _update_job(job_id,
                    slots=initial_slots,
                    status="ready",
                    progress_message="¡Listo para editar!",
                    progress_percent=100)
        _push_event(job_id, "progress", {"message": "Listo. Abriendo editor...", "percent": 100})
        _push_event(job_id, "done", {"job_id": job_id})

    except Exception as exc:
        _update_job(job_id, status="error", error=str(exc))
        _push_event(job_id, "error", {"message": str(exc)})
        import traceback
        traceback.print_exc()


def _run_export(job_id: str, overlay_text: str = ""):
    from backend.services.video_gen import assemble_video

    try:
        with _lock:
            job = dict(_jobs[job_id])
        job_dir = OUTPUT_DIR / job_id
        audio_path = Path(job["audio_path"])
        slots = job["slots"]
        output_path = job_dir / "final.mp4"

        def on_progress(message: str, percent: int):
            _update_job(job_id, progress_message=message, progress_percent=percent)
            _push_event(job_id, "export_progress", {"message": message, "percent": percent})

        assemble_video(slots, audio_path, job_dir, output_path, on_progress, overlay_text=overlay_text)

        download_url = f"/output/{job_id}/final.mp4"
        _update_job(job_id, status="done", download_url=download_url, progress_percent=100,
                    progress_message="¡Video exportado!")
        _push_event(job_id, "export_done", {"download_url": download_url})

    except Exception as exc:
        _update_job(job_id, status="error", error=str(exc))
        _push_event(job_id, "export_error", {"message": str(exc)})
        import traceback
        traceback.print_exc()


# ---------------------------------------------------------------------------
# Static file mounts (must come AFTER all API routes)
# ---------------------------------------------------------------------------
app.mount("/output", StaticFiles(directory=str(OUTPUT_DIR)), name="output")
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
