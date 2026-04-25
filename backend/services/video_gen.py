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

    # Extend the last slot to cover the full audio duration (Whisper often misses
    # the last few seconds of silence, which would cause -shortest to cut the video)
    audio_duration = _get_audio_duration(audio_path, ffmpeg)
    if audio_duration > 0 and slots[-1]["end"] < audio_duration:
        slots = list(slots)  # don't mutate the original
        last = dict(slots[-1])
        last["end"] = audio_duration
        slots[-1] = last

    # Randomise Ken-Burns direction per slot (deterministic via index)
    rng = random.Random(42)
    directions = [rng.randint(0, len(_KB_PANS) - 1) for _ in range(total)]

    # ------------------------------------------------------------------ #
    # Phase 1: Generate video segments (0 → 80 %)
    # ------------------------------------------------------------------ #
    segment_paths: List[Path] = []

    for i, slot in enumerate(slots):
        image_path = Path(slot.get("image_path") or "")
        if not image_path.exists():
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

    cmd_final = [
        ffmpeg, "-y",
        "-f", "concat", "-safe", "0",
        "-i", str(concat_file),
        "-i", str(audio_path),
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "copy",            # no re-encode: fast and lossless quality
        "-c:a", "aac",
        "-b:a", AUDIO_BITRATE,
        "-movflags", "+faststart", # optimise for web streaming
        str(output_path),
    ]
    result = subprocess.run(cmd_final, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        raise RuntimeError(f"Error en el paso final de FFmpeg:\n{result.stderr[-600:]}")

    on_progress("¡Video listo!", 100)
