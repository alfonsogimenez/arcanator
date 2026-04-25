"""
Transcription service using faster-whisper (local, no API key required).
Language is fixed to Spanish for maximum accuracy and speed.
"""
import gc
import threading
from typing import List, Dict, Any

_model = None
_model_lock = threading.Lock()


def _get_model():
    global _model
    with _model_lock:
        if _model is None:
            from faster_whisper import WhisperModel
            # base model: ~147MB download on first run, good accuracy for Spanish podcasts
            _model = WhisperModel("base", device="cpu", compute_type="int8")
    return _model


def unload_model():
    """Release Whisper model from memory to free RAM for FFmpeg export."""
    global _model
    with _model_lock:
        if _model is not None:
            del _model
            _model = None
            gc.collect()


def transcribe_audio(audio_path: str, interval_seconds: int) -> List[Dict[str, Any]]:
    """
    Transcribe audio file and group segments into chunks of ~interval_seconds.
    Returns a list of slot dicts with keys: index, start, end, text, prompt,
    image_url, image_path, custom.
    """
    model = _get_model()

    segments_iter, _info = model.transcribe(
        audio_path,
        language="es",
        beam_size=5,
        vad_filter=True,          # skip silence regions
        vad_parameters={"min_silence_duration_ms": 500},
        word_timestamps=False,
    )

    # Materialise the lazy generator
    raw_segments = list(segments_iter)

    if not raw_segments:
        return []

    # Group raw Whisper segments into fixed-duration slots
    slots: List[Dict[str, Any]] = []
    slot_index = 0
    bucket_texts: List[str] = []
    bucket_start: float = raw_segments[0].start
    bucket_end: float = raw_segments[0].start

    for seg in raw_segments:
        text = seg.text.strip()
        if not text:
            continue

        if not bucket_texts:
            bucket_start = seg.start

        bucket_texts.append(text)
        bucket_end = seg.end

        if (bucket_end - bucket_start) >= interval_seconds:
            slots.append(_make_slot(slot_index, bucket_start, bucket_end, bucket_texts))
            slot_index += 1
            bucket_texts = []
            bucket_start = bucket_end

    # Flush remaining text as the last slot
    if bucket_texts:
        slots.append(_make_slot(slot_index, bucket_start, bucket_end, bucket_texts))

    return slots


def _make_slot(index: int, start: float, end: float, texts: List[str]) -> Dict[str, Any]:
    return {
        "index": index,
        "start": round(start, 2),
        "end": round(end, 2),
        "text": " ".join(texts),
        "prompt": "",
        "image_url": None,
        "image_path": None,
        "custom": False,
    }
