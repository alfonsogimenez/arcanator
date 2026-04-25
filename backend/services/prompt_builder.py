"""
Keyword extraction from Spanish text + English prompt building.
Uses YAKE (offline) for keywords and deep-translator (Google) for translation.
"""
import re
from typing import List

import yake
from deep_translator import GoogleTranslator

# YAKE extractor tuned for Spanish
_extractor = yake.KeywordExtractor(
    lan="es",
    n=2,          # up to bigrams
    dedupLim=0.8,
    top=6,
    features=None,
)

# Style suffix appended to every prompt for cinematic quality
_STYLE = (
    "cinematic photography, professional photo, sharp focus, "
    "8k ultra detailed, dramatic lighting, award winning photography, "
    "photorealistic, high resolution"
)

# Simple fallback word blacklist (stopwords that YAKE might not filter)
_BLACKLIST = {
    "también", "sobre", "porque", "cuando", "donde", "como", "pero",
    "que", "con", "para", "una", "uno", "los", "las", "del", "más",
    "muy", "hay", "así", "esto", "esta", "ese", "esa", "bien",
}


def build_prompt(text_es: str) -> str:
    """
    Extract keywords from Spanish text, translate to English,
    and return a descriptive image generation prompt.
    """
    text_es = text_es.strip()
    if not text_es:
        return f"abstract cinematic landscape, {_STYLE}"

    try:
        keywords = _extract_keywords(text_es)
        if not keywords:
            keywords = _fallback_words(text_es)

        kw_str = ", ".join(keywords[:5])

        # Translate Spanish keywords to English
        translated = GoogleTranslator(source="es", target="en").translate(kw_str)
        if not translated:
            translated = kw_str

        return f"{translated}, {_STYLE}"

    except Exception:
        # If translation service is unavailable, build prompt from raw text
        words = _fallback_words(text_es)
        return f"{' '.join(words[:5])}, {_STYLE}"


def _extract_keywords(text: str) -> List[str]:
    """Return cleaned keyword strings, lower score = more relevant in YAKE."""
    raw = _extractor.extract_keywords(text)
    # Sort by relevance (lower score = more relevant)
    raw.sort(key=lambda x: x[1])
    result = []
    for kw, _score in raw:
        kw_clean = kw.strip().lower()
        if kw_clean and kw_clean not in _BLACKLIST and len(kw_clean) > 2:
            result.append(kw)
    return result


def build_search_query(text_es: str) -> str:
    """
    Extract keywords from Spanish text and translate to English for use
    as a Bing/Google image search query (no style suffixes).
    """
    text_es = text_es.strip()
    if not text_es:
        return "landscape nature"

    try:
        keywords = _extract_keywords(text_es)
        if not keywords:
            keywords = _fallback_words(text_es)

        kw_str = " ".join(keywords[:5])

        translated = GoogleTranslator(source="es", target="en").translate(kw_str)
        if not translated:
            translated = kw_str

        return translated.strip()

    except Exception:
        words = _fallback_words(text_es)
        return " ".join(words[:5])


def _fallback_words(text: str) -> List[str]:
    """Extract the first meaningful words if YAKE returns nothing."""
    words = re.sub(r"[^\w\s]", "", text).split()
    return [w for w in words if w.lower() not in _BLACKLIST and len(w) > 3][:6]
