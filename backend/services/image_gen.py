"""
Image retrieval via Bing Images scraping (no API key required).
Searches for real photos related to the podcast topic.
Returns 5 candidate images per slot so the user can choose.
"""
import io
import re
import time
import random
import urllib.parse
from pathlib import Path
from typing import List, Dict, Any, Callable
from concurrent.futures import ThreadPoolExecutor, as_completed

import httpx
from PIL import Image, ImageDraw

from services.prompt_builder import build_search_query

_MAX_WORKERS     = 2    # keep low to avoid Bing rate limiting
_CANDIDATES      = 3    # images to download per slot
_TIMEOUT         = 30.0
_BING_SEARCH_URL = "https://www.bing.com/images/search"

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9,es;q=0.8",
}


def _scrape_bing_image_entries(query: str, count: int = 20) -> List[Dict[str, str]]:
    """Scrape Bing Images and return [{murl, purl}] for each result."""
    params = {"q": query, "count": str(count), "form": "HDRSC2"}
    url = f"{_BING_SEARCH_URL}?{urllib.parse.urlencode(params)}"
    try:
        with httpx.Client(timeout=_TIMEOUT, follow_redirects=True, verify=False, headers=_HEADERS) as client:
            resp = client.get(url)
        if resp.status_code != 200:
            print(f"[image_gen] Bing status {resp.status_code} para: '{query}'")
            return []
        entries = []
        for m in re.finditer(r'&quot;murl&quot;:&quot;(https?://[^&]+)&quot;', resp.text):
            murl = m.group(1)
            # purl comes BEFORE murl in Bing's JSON object — search backwards
            start = max(0, m.start() - 1200)
            snippet = resp.text[start: m.end() + 100]
            purl_match = re.search(r'&quot;purl&quot;:&quot;(https?://[^&]+)&quot;', snippet)
            entries.append({"murl": murl, "purl": purl_match.group(1) if purl_match else ""})
        print(f"[image_gen] Bing encontro {len(entries)} URLs para: '{query}'")
        return entries
    except Exception as exc:
        print(f"[image_gen] Error scrapeando Bing: {exc}")
        return []


def scrape_bing_image_urls(query: str, count: int = 20) -> List[str]:
    """Scrape Bing Images and return a list of direct image URLs (public)."""
    return [e["murl"] for e in _scrape_bing_image_entries(query, count)]


def _download_and_resize(img_url: str, output_path: Path) -> bool:
    """Download an image URL and resize/crop to 1920x1080. Returns True on success."""
    try:
        with httpx.Client(timeout=_TIMEOUT, follow_redirects=True, verify=False) as client:
            resp = client.get(img_url)
        if resp.status_code != 200 or len(resp.content) < 4096:
            return False
        img = Image.open(io.BytesIO(resp.content)).convert("RGB")
        img = _fit_crop(img, 1920, 1080)
        img.save(str(output_path), "JPEG", quality=92, optimize=True)
        return True
    except Exception as exc:
        print(f"[image_gen] Error descargando {img_url[:80]}: {exc}")
        return False


def download_url_to_path(img_url: str, output_path: Path) -> bool:
    """Public wrapper: download external URL, resize, save. Used by API endpoints."""
    return _download_and_resize(img_url, output_path)


def _fit_crop(img: Image.Image, target_w: int, target_h: int) -> Image.Image:
    src_w, src_h = img.size
    scale  = max(target_w / src_w, target_h / src_h)
    new_w  = int(src_w * scale)
    new_h  = int(src_h * scale)
    img    = img.resize((new_w, new_h), Image.LANCZOS)
    left   = (new_w - target_w) // 2
    top    = (new_h - target_h) // 2
    return img.crop((left, top, left + target_w, top + target_h))


def generate_candidates(query: str, images_dir: Path, index: int) -> List[Dict[str, str]]:
    """
    Scrape Bing once for query, download the first _CANDIDATES successful images.
    Files saved as {index}_0.jpg ... {index}_{N-1}.jpg.
    Returns list of dicts: [{url, page_url, path}].
    """
    entries = _scrape_bing_image_entries(query, count=30)
    if not entries:
        return []

    if len(entries) > 4:
        top  = entries[:4]
        tail = entries[4:]
        random.shuffle(tail)
        entries = top + tail

    candidates: List[Dict[str, str]] = []
    attempt = 0
    for entry in entries:
        if len(candidates) >= _CANDIDATES:
            break
        attempt += 1
        if attempt > _CANDIDATES * 6:
            break
        out_path = images_dir / f"{index}_{len(candidates)}.jpg"
        if _download_and_resize(entry["murl"], out_path):
            candidates.append({"url": entry["murl"], "page_url": entry["purl"], "path": str(out_path)})
        time.sleep(0.1)
    return candidates


def _create_fallback(output_path: Path, prompt: str):
    width, height = 1920, 1080
    img  = Image.new("RGB", (width, height), (15, 15, 30))
    draw = ImageDraw.Draw(img)
    for y in range(height):
        ratio = y / height
        draw.line([(0, y), (width, y)], fill=(int(15 + 20 * ratio), 15, int(30 + 40 * (1 - ratio))))
    label = prompt[:100] + ("..." if len(prompt) > 100 else "")
    draw.text((width // 2, height // 2), label, fill=(80, 90, 140), anchor="mm")
    img.save(str(output_path), "JPEG", quality=90)


def generate_all_images(
    slots: List[Dict[str, Any]],
    job_dir: Path,
    job_id: str,
    on_ready: Callable[[int, Dict[str, Any]], None],
) -> List[Dict[str, Any]]:
    """
    Fetch 5 candidate images for every slot in parallel.
    Calls on_ready(index, updated_slot) as each slot finishes.
    """
    images_dir = job_dir / "images"
    images_dir.mkdir(exist_ok=True)

    for slot in slots:
        slot["prompt"] = build_search_query(slot["text"])

    result_slots = list(slots)

    def _process(slot: Dict[str, Any]) -> Dict[str, Any]:
        idx        = slot["index"]
        query      = slot["prompt"]
        candidates = generate_candidates(query, images_dir, idx)

        if not candidates:
            fb_path = images_dir / f"{idx}_0.jpg"
            _create_fallback(fb_path, query)
            candidates = [{"url": "", "path": str(fb_path)}]

        slot = dict(slot)
        slot["candidates"] = [
            {
                "url":       c["url"],
                "page_url":  c.get("page_url", ""),
                "path":      c["path"],
                "image_url": f"/output/{job_id}/images/{idx}_{ci}.jpg",
            }
            for ci, c in enumerate(candidates)
        ]
        slot["image_url"]  = slot["candidates"][0]["image_url"]
        slot["image_path"] = slot["candidates"][0]["path"]
        return slot

    with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as pool:
        future_map = {pool.submit(_process, slot): slot["index"] for slot in slots}
        for future in as_completed(future_map):
            updated_slot = future.result()
            idx = updated_slot["index"]
            result_slots[idx] = updated_slot
            on_ready(idx, updated_slot)

    return result_slots
