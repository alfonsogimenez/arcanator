"""
Video assembly service using FFmpeg.

Pipeline:
  1. Per slot: image → short video segment with Ken-Burns (zoompan) + fade in/out.
  2. All segments concatenated via FFmpeg concat demuxer (stream copy, no re-encode).
  3. Audio muxed on the final pass.

Quality: H.264 High Profile, CRF 18, AAC 192 kbps, 1920×1080 @ 50 fps.
"""
import subprocess
import shutil
import random
import textwrap
from pathlib import Path
from typing import List, Dict, Any, Callable

# Output spec
FPS = 50
WIDTH = 1920
HEIGHT = 1080
CRF = 18
AUDIO_BITRATE = "192k"
FADE_DURATION = 0.4   # seconds fade-in / fade-out per segment
KEN_BURNS_ZOOM = 0.18
KEN_BURNS_SUPERSAMPLE = 3.0

# Ken-Burns anchor points (top-left corner of crop in an oversampled image).
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


def _cover_filter(width: int, height: int, scale_factor: float = 1.0) -> str:
    base_width = max(2, int(round(width * scale_factor / 2) * 2))
    base_height = max(2, int(round(height * scale_factor / 2) * 2))
    return (
        f"scale={base_width}:{base_height}:"
        f"force_original_aspect_ratio=increase:flags=lanczos,"
        f"crop={base_width}:{base_height}:(iw-{base_width})/2:(ih-{base_height})/2,"
        f"setsar=1"
    )


def _build_zoompan(frames: int, pan_x: str, pan_y: str, width: int, height: int) -> str:
    """Build zoompan + fade filter string for one segment."""
    last_frame = max(frames - 1, 1)
    progress_expr = f"on/{last_frame}"
    eased_progress_expr = f"({progress_expr})*({progress_expr})*(3-2*({progress_expr}))"

    # Compute the zoom from absolute frame progress. The higher FPS and
    # oversampled input make FFmpeg's integer crop rounding much less visible.
    zoom_expr = f"1.0+{KEN_BURNS_ZOOM}*{eased_progress_expr}"

    # Pre-crop to the output aspect before zoompan so vertical exports never stretch images.
    vf = (
        f"{_cover_filter(width, height, KEN_BURNS_SUPERSAMPLE)},"
        f"zoompan="
        f"z='{zoom_expr}':"
        f"x='{pan_x}':"
        f"y='{pan_y}':"
        f"d={frames}:"
        f"s={width}x{height}:"
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
    width: int,
    height: int,
) -> bool:
    """Encode a single image into a video segment with Ken-Burns effect."""
    if duration < 1.0:
        duration = 1.0

    frames = max(int(round(duration * FPS)), FPS)
    pan_x, pan_y = _KB_PANS[direction_index % len(_KB_PANS)]
    vf = _build_zoompan(frames, pan_x, pan_y, width, height)

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
    width: int,
    height: int,
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
            f"{_cover_filter(width, height)},"
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
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        ffmpeg_path = Path(ffmpeg)
        ffprobe_name = "ffprobe.exe" if ffmpeg_path.suffix.lower() == ".exe" else "ffprobe"
        ffprobe = str(ffmpeg_path.with_name(ffprobe_name))
    try:
        result = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(audio_path)],
            capture_output=True, text=True, encoding="utf-8", errors="replace"
        )
        return float(result.stdout.strip())
    except Exception:
        return 0.0


def _as_float(value: Any, fallback: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _wrap_overlay_text(text: str, font_size: int, output_width: int) -> str:
    clean_text = " ".join(str(text).split())
    if not clean_text:
        return ""

    usable_width = max(160.0, output_width * 0.80)
    average_char_width = max(8.0, font_size * 0.58)
    max_chars = max(8, int(usable_width / average_char_width))
    return "\n".join(
        textwrap.wrap(
            clean_text,
            width=max_chars,
            break_long_words=True,
            break_on_hyphens=False,
        )
    )


def _escape_drawtext_text(text: str) -> str:
    return (
        text
        .replace("\\", "\\\\")
        .replace("'", "\\'")
        .replace(":", "\\:")
        .replace("%", "\\%")
    )


def _normalize_slots_to_audio_duration(
    slots: List[Dict[str, Any]],
    audio_duration: float,
) -> List[Dict[str, Any]]:
    """Close timeline gaps by extending the previous image slot."""
    if not slots:
        return []

    normalized: List[Dict[str, Any]] = []
    for src in slots:
        slot = dict(src)
        fallback_start = normalized[-1]["end"] if normalized else 0.0
        start = _as_float(slot.get("start"), fallback_start)
        end = _as_float(slot.get("end"), start)
        if end <= start:
            end = start + 1.0
        slot["start"] = max(0.0, start)
        slot["end"] = max(0.0, end)
        normalized.append(slot)

    eps = 0.001
    normalized[0]["start"] = 0.0
    for i in range(1, len(normalized)):
        prev = normalized[i - 1]
        slot = normalized[i]
        prev_end = _as_float(prev.get("end"), 0.0)
        start = _as_float(slot.get("start"), prev_end)

        if start > prev_end + eps:
            prev["end"] = start
        elif start < prev_end - eps:
            start = prev_end
            slot["start"] = start

        if _as_float(slot.get("end"), start) <= start + eps:
            slot["end"] = start + 1.0

    if audio_duration > 0:
        capped: List[Dict[str, Any]] = []
        for slot in normalized:
            if _as_float(slot.get("start"), 0.0) >= audio_duration - eps:
                break
            if _as_float(slot.get("end"), 0.0) > audio_duration + eps:
                slot["end"] = audio_duration
                capped.append(slot)
                break
            capped.append(slot)
        normalized = capped
        if normalized and _as_float(normalized[-1].get("end"), 0.0) < audio_duration - eps:
            normalized[-1]["end"] = audio_duration

    for i, slot in enumerate(normalized):
        slot["index"] = i
        slot["start"] = round(_as_float(slot.get("start"), 0.0), 6)
        slot["end"] = round(_as_float(slot.get("end"), slot["start"]), 6)

    return normalized


def _limit_slots_to_duration(
    slots: List[Dict[str, Any]],
    max_duration: float,
) -> List[Dict[str, Any]]:
    if max_duration <= 0:
        return []

    limited: List[Dict[str, Any]] = []
    eps = 0.001
    for src in slots:
        start = _as_float(src.get("start"), 0.0)
        end = _as_float(src.get("end"), start)
        if start >= max_duration - eps:
            break
        slot = dict(src)
        slot["end"] = min(end, max_duration)
        if slot["end"] > start + eps:
            limited.append(slot)
        if end >= max_duration - eps:
            break

    if limited:
        limited[-1]["end"] = max_duration
    for i, slot in enumerate(limited):
        slot["index"] = i
        slot["start"] = round(_as_float(slot.get("start"), 0.0), 6)
        slot["end"] = round(_as_float(slot.get("end"), slot["start"]), 6)
    return limited


def assemble_video(
    slots: List[Dict[str, Any]],
    audio_path: Path,
    job_dir: Path,
    output_path: Path,
    on_progress: Callable[[str, int], None],
    overlay_text: str = "",
    overlay_font_size: int = 64,
    output_width: int = WIDTH,
    output_height: int = HEIGHT,
    max_duration: float | None = None,
) -> None:
    """
    Build the final MP4:
      1. Encode one segment per slot.
      2. Concatenate segments with stream-copy.
      3. Mux audio track.
    """
    ffmpeg = check_ffmpeg()
    work_suffix = "_short" if max_duration or output_width != WIDTH or output_height != HEIGHT else ""
    segments_dir = job_dir / f"segments{work_suffix}"
    segments_dir.mkdir(exist_ok=True)

    audio_duration = _get_audio_duration(audio_path, ffmpeg)
    if audio_duration > 0:
        slots = _normalize_slots_to_audio_duration(slots, audio_duration)
    target_duration = audio_duration
    if max_duration is not None:
        target_duration = min(max_duration, audio_duration) if audio_duration > 0 else max_duration
        slots = _limit_slots_to_duration(slots, target_duration)

    total = len(slots)
    if total == 0:
        raise RuntimeError("No hay slots para exportar.")

    # Extend the last slot to cover the full audio duration + 1 s of tail
    # so the last image doesn't cut exactly on the last audio frame.
    if target_duration > 0:
        slots = list(slots)  # don't mutate the original
        last = dict(slots[-1])
        last["end"] = target_duration + 1.0
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

        ok = _generate_segment(image_path, duration, seg_path, directions[i], ffmpeg, output_width, output_height)
        if not ok:
            ok = _generate_segment_simple(image_path, duration, seg_path, ffmpeg, output_width, output_height)
        if not ok:
            raise RuntimeError(f"No se pudo generar el segmento {i}. Comprueba la instalación de FFmpeg.")

        segment_paths.append(seg_path)

    # ------------------------------------------------------------------ #
    # Phase 2: Concatenate (80 → 90 %)
    # ------------------------------------------------------------------ #
    on_progress("Concatenando segmentos...", 80)

    concat_file = job_dir / f"concat{work_suffix}.txt"
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
        overlay_font_size = max(36, min(112, int(round(_as_float(overlay_font_size, 64)))))
        overlay_border = max(2, round(overlay_font_size / 20))
        overlay_line_spacing = max(4, round(overlay_font_size * 0.16))
        overlay_lines = [
            _escape_drawtext_text(line)
            for line in _wrap_overlay_text(overlay_text, overlay_font_size, output_width).splitlines()
            if line
        ]
        if _font_found:
            # FFmpeg drawtext: colon in Windows drive letter must be escaped as \:
            _font_ffmpeg = _font_found.replace("\\", "/").replace(":", "\\:")
            font_clause = f"fontfile='{_font_ffmpeg}':"
        else:
            font_clause = ""
        line_height = overlay_font_size + overlay_line_spacing
        drawtext_filters = []
        for line_index, line in enumerate(overlay_lines):
            y_expr = f"h*0.09+{line_index * line_height}"
            drawtext_filters.append(
                f"drawtext="
                f"{font_clause}"
                f"text='{line}':"
                f"fontsize={overlay_font_size}:"
                f"fontcolor=white:"
                f"borderw={overlay_border}:bordercolor=black:"
                f"fix_bounds=1:"
                f"x=(w-text_w)/2:"
                f"y={y_expr}:"
                f"enable='between(t,2,7)'"
            )
        if drawtext_filters:
            vf_overlay = "setpts=PTS-STARTPTS," + ",".join(drawtext_filters)

    if vf_overlay:
        output_limit_args = ["-t", f"{target_duration:.3f}"] if max_duration is not None and target_duration > 0 else []
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
            *output_limit_args,
            str(output_path),
        ]
    else:
        output_limit_args = ["-t", f"{target_duration:.3f}"] if max_duration is not None and target_duration > 0 else []
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
            *output_limit_args,
            str(output_path),
        ]
    result = subprocess.run(cmd_final, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        raise RuntimeError(f"Error en el paso final de FFmpeg:\n{result.stderr[-600:]}")

    on_progress("¡Video listo!", 100)
