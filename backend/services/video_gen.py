"""
Video assembly service using FFmpeg.

Pipeline:
  1. Per slot: image → short video segment with Ken-Burns (zoompan) + fade in/out.
  2. All segments concatenated via FFmpeg concat demuxer (stream copy, no re-encode).
  3. Audio muxed on the final pass.

Quality: H.264 High Profile, CRF 18, AAC 192 kbps, 1920×1080 @ 25 fps.
"""
import subprocess
import shutil
import random
from pathlib import Path
from typing import List, Dict, Any, Callable

# Output spec
FPS = 25
WIDTH = 1920
HEIGHT = 1080
CRF = 18
AUDIO_BITRATE = "192k"
FADE_DURATION = 0.4   # seconds fade-in / fade-out per segment

# Ken-Burns anchor points (top-left corner of crop in a 2× scaled image).
# Variables: iw/ih = input (scaled) dims, zoom = current zoom factor.
_KB_PANS = [
    # centre zoom
    ("(iw-iw/zoom)/2", "(ih-ih/zoom)/2"),
    # pan right
    ("0",              "(ih-ih/zoom)/2"),
    # pan left
    ("iw-iw/zoom",     "(ih-ih/zoom)/2"),
    # pan up
    ("(iw-iw/zoom)/2", "0"),
    # pan down
    ("(iw-iw/zoom)/2", "ih-ih/zoom"),
    # diagonal top-left→bottom-right
    ("0",              "0"),
    # diagonal top-right→bottom-left
    ("iw-iw/zoom",     "0"),
]


def check_ffmpeg() -> str:
    """Return the ffmpeg executable path or raise RuntimeError."""
    path = shutil.which("ffmpeg")
    if not path:
        raise RuntimeError(
            "FFmpeg no encontrado en el sistema. "
            "Descárgalo desde https://ffmpeg.org/download.html y añádelo al PATH."
        )
    return path


def _build_zoompan(frames: int, pan_x: str, pan_y: str) -> str:
    """Build zoompan + fade filter string for one segment."""
    fade_f = int(FADE_DURATION * FPS)

    # Zoom linearly from 1.0 to 1.18 over the segment duration
    # Using incremental expression: zoom is maintained across frames by the filter
    zoom_expr = "min(zoom+0.0007,1.18)"

    # Scale source image to 1.5× before zoompan (2× uses too much RAM on low-memory servers)
    vf = (
        f"scale={int(WIDTH * 1.5)}:{int(HEIGHT * 1.5)}:flags=lanczos,"
        f"zoompan="
        f"z='{zoom_expr}':"
        f"x='{pan_x}':"
        f"y='{pan_y}':"
        f"d={frames}:"
        f"s={WIDTH}x{HEIGHT}:"
        f"fps={FPS},"
        f"fade=t=in:st=0:d={FADE_DURATION},"
        f"fade=t=out:st={max(0.0, frames / FPS - FADE_DURATION):.3f}:d={FADE_DURATION}"
    )
    return vf


def _generate_segment(
    image_path: Path,
    duration: float,
    output_path: Path,
    direction_index: int,
    ffmpeg: str,
) -> bool:
    """Encode a single image into a video segment with Ken-Burns effect."""
    if duration < 1.0:
        duration = 1.0

    frames = max(int(round(duration * FPS)), FPS)
    pan_x, pan_y = _KB_PANS[direction_index % len(_KB_PANS)]
    vf = _build_zoompan(frames, pan_x, pan_y)

    cmd = [
        ffmpeg, "-y",
        "-loop", "1",
        "-framerate", str(FPS),
        "-i", str(image_path),
        "-t", f"{duration:.3f}",
        "-vf", vf,
        "-c:v", "libx264",
        "-crf", str(CRF),
        "-preset", "ultrafast",
        "-threads", "1",          # limit threads to reduce peak RAM usage
        "-pix_fmt", "yuv420p",
        "-r", str(FPS),
        "-an",
        str(output_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        print(f"[video_gen] zoompan failed for {image_path.name}: {result.stderr[-400:]}")
        return False
    return True


def _generate_segment_simple(
    image_path: Path,
    duration: float,
    output_path: Path,
    ffmpeg: str,
) -> bool:
    """Fallback: static scaled segment without zoompan."""
    if duration < 1.0:
        duration = 1.0
    cmd = [
        ffmpeg, "-y",
        "-loop", "1",
        "-framerate", str(FPS),
        "-i", str(image_path),
        "-t", f"{duration:.3f}",
        "-vf", (
            f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,"
            f"crop={WIDTH}:{HEIGHT},"
            f"fade=t=in:st=0:d={FADE_DURATION},"
            f"fade=t=out:st={max(0.0, duration - FADE_DURATION):.3f}:d={FADE_DURATION}"
        ),
        "-c:v", "libx264", "-crf", str(CRF), "-preset", "ultrafast",
        "-threads", "1",
        "-pix_fmt", "yuv420p", "-r", str(FPS), "-an",
        str(output_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return result.returncode == 0


def _get_audio_duration(audio_path: Path, ffmpeg: str) -> float:
    """Return audio duration in seconds using ffprobe."""
    ffprobe = ffmpeg.replace("ffmpeg", "ffprobe")
    try:
        result = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(audio_path)],
            capture_output=True, text=True, encoding="utf-8", errors="replace"
        )
        return float(result.stdout.strip())
    except Exception:
        return 0.0


def assemble_video(
    slots: List[Dict[str, Any]],
    audio_path: Path,
    job_dir: Path,
    output_path: Path,
    on_progress: Callable[[str, int], None],
    overlay_text: str = "",
) -> None:
    """
    Build the final MP4:
      1. Encode one segment per slot.
      2. Concatenate segments with stream-copy.
      3. Mux audio track.
    """
    ffmpeg = check_ffmpeg()
    segments_dir = job_dir / "segments"
    segments_dir.mkdir(exist_ok=True)

    total = len(slots)
    if total == 0:
        raise RuntimeError("No hay slots para exportar.")

    # Extend the last slot to cover the full audio duration + 1 s of tail
    # so the last image doesn't cut exactly on the last audio frame.
    audio_duration = _get_audio_duration(audio_path, ffmpeg)
    if audio_duration > 0:
        slots = list(slots)  # don't mutate the original
        last = dict(slots[-1])
        last["end"] = audio_duration + 1.0
        slots[-1] = last

    # Randomise Ken-Burns direction per slot (deterministic via index)
    rng = random.Random(42)
    directions = [rng.randint(0, len(_KB_PANS) - 1) for _ in range(total)]

    # ------------------------------------------------------------------ #
    # Phase 1: Generate video segments (0 → 80 %)
    # ------------------------------------------------------------------ #
    segment_paths: List[Path] = []

    for i, slot in enumerate(slots):
        img_path_str = slot.get("image_path") or ""
        image_path = Path(img_path_str) if img_path_str else Path("__nonexistent__")
        if not img_path_str or not image_path.exists():
            from backend.services.image_gen import _create_fallback
            image_path = job_dir / "images" / f"{i:04d}.jpg"
            _create_fallback(image_path, slot.get("text", ""))

        duration = max(slot["end"] - slot["start"], 1.0)
        seg_path = segments_dir / f"{i:04d}.mp4"
        percent = int(i / total * 78)
        on_progress(f"Codificando segmento {i + 1} / {total}...", percent)

        ok = _generate_segment(image_path, duration, seg_path, directions[i], ffmpeg)
        if not ok:
            ok = _generate_segment_simple(image_path, duration, seg_path, ffmpeg)
        if not ok:
            raise RuntimeError(f"No se pudo generar el segmento {i}. Comprueba la instalación de FFmpeg.")

        segment_paths.append(seg_path)

    # ------------------------------------------------------------------ #
    # Phase 2: Concatenate (80 → 90 %)
    # ------------------------------------------------------------------ #
    on_progress("Concatenando segmentos...", 80)

    concat_file = job_dir / "concat.txt"
    with open(concat_file, "w", encoding="utf-8") as f:
        for seg in segment_paths:
            # FFmpeg concat demuxer requires forward slashes and single-quoted paths
            f.write(f"file '{seg.as_posix()}'\n")

    # ------------------------------------------------------------------ #
    # Phase 3: Final mux with audio (90 → 100 %)
    # ------------------------------------------------------------------ #
    on_progress("Añadiendo audio y generando MP4 final...", 90)

    # Build optional drawtext overlay (seconds 2–7)
    # Try multiple font locations: Debian/Docker first, then Windows fallbacks.
    import os as _os
    _FONT_CANDIDATES = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",  # Debian/Docker
        "C:/Windows/Fonts/arialbd.ttf",   # Windows – Arial Bold
        "C:/Windows/Fonts/arial.ttf",     # Windows – Arial
        "C:/Windows/Fonts/calibrib.ttf",  # Windows – Calibri Bold
        "C:/Windows/Fonts/calibri.ttf",   # Windows – Calibri
    ]
    _font_found = next((p for p in _FONT_CANDIDATES if _os.path.exists(p)), None)

    vf_overlay = ""
    if overlay_text:
        # Escape special characters for FFmpeg drawtext
        safe_text = (
            overlay_text
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace(":", "\\:")
        )
        if _font_found:
            # FFmpeg drawtext: colon in Windows drive letter must be escaped as \:
            _font_ffmpeg = _font_found.replace("\\", "/").replace(":", "\\:")
            font_clause = f"fontfile='{_font_ffmpeg}':"
        else:
            font_clause = ""
        vf_overlay = (
            f"setpts=PTS-STARTPTS,"
            f"drawtext="
            f"{font_clause}"
            f"text='{safe_text}':"
            f"fontsize=64:"
            f"fontcolor=white:"
            f"borderw=3:bordercolor=black:"
            f"x=(w-text_w)/2:"
            f"y=h*0.12:"
            f"enable='between(t,2,7)'"
        )

    if vf_overlay:
        cmd_final = [
            ffmpeg, "-y",
            "-f", "concat", "-safe", "0",
            "-i", str(concat_file),
            "-i", str(audio_path),
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-vf", vf_overlay,
            "-c:v", "libx264",
            "-crf", str(CRF),
            "-preset", "ultrafast",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", AUDIO_BITRATE,
            "-movflags", "+faststart",
            str(output_path),
        ]
    else:
        cmd_final = [
            ffmpeg, "-y",
            "-f", "concat", "-safe", "0",
            "-i", str(concat_file),
            "-i", str(audio_path),
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", AUDIO_BITRATE,
            "-movflags", "+faststart",
            str(output_path),
        ]
    result = subprocess.run(cmd_final, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        raise RuntimeError(f"Error en el paso final de FFmpeg:\n{result.stderr[-600:]}")

    on_progress("¡Video listo!", 100)
