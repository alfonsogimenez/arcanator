"""
Image retrieval via Bing Images scraping (no API key required).
Searches for real photos related to the podcast topic.
Returns 5 candidate images per slot so the user can choose.
"""
import io
import html
import json
import re
import time
import random
import urllib.parse
import unicodedata
from html.parser import HTMLParser
from pathlib import Path
from typing import List, Dict, Any, Callable
from concurrent.futures import ThreadPoolExecutor, as_completed

import httpx
from PIL import Image, ImageDraw

from backend.services.prompt_builder import build_search_query

_MAX_WORKERS     = 2    # keep low to avoid Bing rate limiting
_CANDIDATES      = 3    # images to download per slot
_TIMEOUT         = 30.0
_SEARCH_TIMEOUT  = 12.0
_DOWNLOAD_TIMEOUT = 30.0
_COMMONS_API_URL = "https://commons.wikimedia.org/w/api.php"
_COMMONS_FILE_PATH_URL = "https://commons.wikimedia.org/wiki/Special:FilePath"
_BING_SEARCH_URL = "https://www.bing.com/images/search"
_COMMONS_MIME_TYPES = {"image/jpeg", "image/png", "image/webp"}
_MIN_SOURCE_SHORT_SIDE = 400
_MIN_SOURCE_LONG_SIDE = 640
_MIN_SOURCE_PIXELS = 250_000
_MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024
_MAX_IMAGE_PIXELS = 45_000_000
_SEARCH_CACHE_TTL = 600.0
_SEARCH_CACHE_MAX = 128
_SEARCH_CACHE: Dict[tuple, tuple[float, List[Dict[str, str]]]] = {}
_COMMONS_BACKOFF_SECONDS = 60.0
_COMMONS_BACKOFF_UNTIL = 0.0
_UNUSABLE_IMAGE_EXTENSIONS = (".gif", ".svg", ".pdf", ".avif")
_LOW_QUALITY_URL_MARKERS = {
    "agefotostock.com", "alamy.com", "clipart", "dreamstime.com", "depositphotos.com",
    "eporner.com", "fapality.com", "freepik.com", "gettyimages.", "gifdb.com",
    "istockphoto.com", "shutterstock.com", "stock-vector", "thisvid.com",
    "vectorstock.com", "xgroovy.com", "xhamster.com", "/vector/",
}
_GENERIC_IMAGE_TERMS = {
    "foto", "fotos", "photo", "photos", "image", "images", "imagen", "imagenes",
    "picture", "pictures", "pic",
}
_SEARCH_STOP_TERMS = {
    "a", "al", "an", "and", "de", "del", "el", "en", "for", "la", "las",
    "los", "of", "para", "the", "to", "y",
}
_ASSET_IMAGE_TERMS = {
    "chart", "diagram", "drawing", "dibujo", "graph", "icon", "illustration",
    "ilustracion", "logo", "map", "mapa", "poster", "vector",
}
_HERALDRY_TERMS = {
    "arms", "blasao", "blason", "brasao", "brasão", "coat", "crest",
    "escudo", "heraldry", "heraldica", "heraldica", "shield", "shields",
}
_ANIMAL_TERMS = {
    "bird", "birds", "cat", "cats", "dog", "dogs", "horse", "horses",
    "gato", "gatos", "perro", "perros", "caballo", "caballos",
    "lion", "lions", "leon", "leones", "tiger", "tigers", "tigre", "tigres",
    "wolf", "wolves", "lobo", "lobos", "fox", "foxes", "zorro", "zorros",
    "bear", "bears", "oso", "osos", "elephant", "elephants", "elefante", "elefantes",
}
_ANIMAL_NEGATIVE_TERMS = {"bar", "pub", "sign", "roundabout", "logo", "statue"}
_FOOD_QUERY_TERMS = {
    "comida", "comidas", "culinaria", "culinario", "culinary", "cuisine",
    "food", "gastronomia", "gastronomy", "restaurant", "restaurants",
    "restaurante", "restaurantes",
}
_FOOD_RESULT_MARKERS = {
    "bacalhau", "barnacles", "cafe", "chef", "comida", "culinaria", "cuisine",
    "dessert", "desserts", "dish", "dishes", "drink", "food", "gastronomia",
    "gastronomy", "lobster", "market", "marzipan", "mercado", "pastel",
    "pastelaria", "port", "restaurant", "restaurants", "restaurante",
    "restaurantes", "ribeira", "salad", "seafood", "time", "wine",
}
_TERRACE_QUERY_TERMS = {
    "azotea", "azoteas", "esplanada", "esplanadas", "mirador", "miradores",
    "miradouro", "miradouros", "patio", "patios", "rooftop", "terraza",
    "terrazas", "terrace", "terraces",
}
_TERRACE_RESULT_MARKERS = {
    "azotea", "azoteas", "balcony", "deck", "esplanada", "esplanadas",
    "patio", "patios", "rooftop", "terrace", "terraces", "terraza",
    "terrazas",
}
_KNOWN_COMMONS_FILES = [
    (
        {"lisboa", "lisbon"},
        {"arms", "brasao", "coat", "escudo", "shield", "shields"},
        "Lisboa,_escudo.jpg",
        "https://commons.wikimedia.org/wiki/File:Lisboa,_escudo.jpg",
    )
]
_HERALDRY_RESULT_MARKERS = {"arms", "brasao", "coat", "crest", "escudo", "heraldica", "heraldico"}
_ROYAL_PLACE_TERMS = {
    "monasterio", "palace", "palacio", "teatro", "theatre", "theater",
}
_MACAU_LISBOA_TERMS = {"cotai", "macau", "macao"}
_LISBON_TERMS = {"lisboa", "lisbon", "lisbonne"}
_LISBON_LIFT_TERMS = {
    "ascensor", "ascensores", "bica", "elevador", "elevadores",
    "elevator", "elevators", "funicular", "funiculares", "gloria",
    "justa", "lavra", "lift", "lifts", "santa",
}

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
}
_IMAGE_HEADERS = {
    **_HEADERS,
    "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
}


def _search_cache_key(query: str, count: int, offset: int):
    return (query.strip().lower(), int(count), int(offset))


def _get_cached_search(query: str, count: int, offset: int):
    key = _search_cache_key(query, count, offset)
    item = _SEARCH_CACHE.get(key)
    if not item:
        return None
    created_at, entries = item
    if time.time() - created_at > _SEARCH_CACHE_TTL:
        _SEARCH_CACHE.pop(key, None)
        return None
    return [dict(entry) for entry in entries]


def _set_cached_search(query: str, count: int, offset: int, entries: List[Dict[str, str]]):
    if not entries:
        return
    if len(_SEARCH_CACHE) >= _SEARCH_CACHE_MAX:
        oldest_key = min(_SEARCH_CACHE, key=lambda key: _SEARCH_CACHE[key][0])
        _SEARCH_CACHE.pop(oldest_key, None)
    key = _search_cache_key(query, count, offset)
    _SEARCH_CACHE[key] = (time.time(), [dict(entry) for entry in entries])


def _dedupe_query_terms(query: str) -> str:
    terms = []
    seen = set()
    for term in re.findall(r"[\w-]+", query, flags=re.UNICODE):
        key = term.lower()
        if key in seen:
            continue
        seen.add(key)
        terms.append(term)
    return " ".join(terms).strip()


def _normalized_terms(query: str) -> List[str]:
    normalized = unicodedata.normalize("NFKD", query)
    ascii_text = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    return [term.lower() for term in re.findall(r"[\w-]+", ascii_text, flags=re.UNICODE)]


def _is_heraldry_query(query: str) -> bool:
    terms = set(_normalized_terms(query))
    return bool(terms.intersection(_HERALDRY_TERMS)) or "coat of arms" in query.lower()


def _is_food_query(query: str) -> bool:
    terms = set(_normalized_terms(query))
    return bool(terms.intersection(_FOOD_QUERY_TERMS))


def _is_terrace_query(query: str) -> bool:
    terms = set(_normalized_terms(query))
    return bool(terms.intersection(_TERRACE_QUERY_TERMS))


def _is_lisbon_lift_query(query: str) -> bool:
    terms = set(_normalized_terms(query))
    return bool(terms.intersection(_LISBON_TERMS)) and bool(terms.intersection(_LISBON_LIFT_TERMS))


def _is_raoul_mesnier_query(query: str) -> bool:
    terms = set(_normalized_terms(query))
    return "mesnier" in terms and bool(terms.intersection({"raul", "raoul", "ponsard"}))


def _append_unique_query(queries: List[str], seen: set, query: str):
    query = _dedupe_query_terms(query).strip()
    key = query.lower()
    if query and key not in seen:
        seen.add(key)
        queries.append(query)


def _semantic_query_variants(query: str, primary: str = "") -> List[str]:
    """Add entity/place aliases that search engines and Commons commonly use."""
    terms = set(_normalized_terms(f"{query} {primary}"))
    variants: List[str] = []
    seen = set()

    if _is_raoul_mesnier_query(query):
        for item in (
            "Raoul Mesnier de Ponsard",
            "Raoul Mesnier de Ponsard elevator Lisbon",
            "Lisbon funicular Raoul Mesnier",
        ):
            _append_unique_query(variants, seen, item)

    if (
        _is_lisbon_lift_query(query)
        or (_is_raoul_mesnier_query(query) and terms.intersection(_LISBON_TERMS))
    ):
        for item in (
            "Elevador de Santa Justa Lisboa",
            "Santa Justa Lift Lisbon",
            "Ascensor da Bica Lisboa",
            "Elevador da Bica Lisboa",
            "Ascensor da Gloria Lisboa",
            "Elevador da Gloria Lisboa",
            "Ascensor do Lavra Lisboa",
            "Elevador do Lavra Lisboa",
        ):
            _append_unique_query(variants, seen, item)

    return variants


def _safe_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _source_dimensions_ok(width: Any, height: Any) -> bool:
    width = _safe_int(width)
    height = _safe_int(height)
    if not width or not height:
        return True
    short_side = min(width, height)
    long_side = max(width, height)
    return (
        short_side >= _MIN_SOURCE_SHORT_SIDE
        and long_side >= _MIN_SOURCE_LONG_SIDE
        and width * height >= _MIN_SOURCE_PIXELS
    )


def _infer_dimensions_from_text(*values: Any):
    text = " ".join(str(value or "") for value in values)
    text = urllib.parse.unquote(text).replace(",", "")
    patterns = (
        r"(?:fit|resize)=(\d{3,5})[x,\s]+(\d{3,5})",
        r"(\d{3,5})\s*(?:px)?\s*[x\u00d7]\s*(\d{3,5})\s*(?:px)?",
        r"[-_/](\d{3,5})x(\d{3,5})(?:[._/?#-]|$)",
    )
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if not match:
            continue
        width = _safe_int(match.group(1))
        height = _safe_int(match.group(2))
        if width and height:
            return width, height
    return 0, 0


def _url_looks_like_usable_image(url: str, query: str = "") -> bool:
    url_lower = urllib.parse.unquote(url).lower()
    clean_path = urllib.parse.urlparse(url_lower).path
    if clean_path.endswith(_UNUSABLE_IMAGE_EXTENSIONS):
        return False
    if _is_asset_query(query):
        return True
    return not any(marker in url_lower for marker in _LOW_QUALITY_URL_MARKERS)


def _is_asset_query(query: str) -> bool:
    terms = set(_normalized_terms(query))
    return bool(terms.intersection(_ASSET_IMAGE_TERMS))


def _known_commons_entries(query: str, offset: int) -> List[Dict[str, str]]:
    if offset > 0:
        return []

    terms = set(_normalized_terms(query))
    entries = []
    for subjects, markers, filename, page_url in _KNOWN_COMMONS_FILES:
        if terms.intersection(subjects) and terms.intersection(markers):
            file_url = f"{_COMMONS_FILE_PATH_URL}/{urllib.parse.quote(filename)}?width=1920"
            entries.append({"murl": file_url, "purl": page_url})
    return entries


def _strip_heraldry_terms(query: str) -> str:
    terms = [
        term
        for term in re.findall(r"[\w-]+", query, flags=re.UNICODE)
        if unicodedata.normalize("NFKD", term).encode("ascii", "ignore").decode("ascii").lower()
        not in _HERALDRY_TERMS
    ]
    return _dedupe_query_terms(" ".join(terms))


def _strip_query_terms(query: str, terms_to_strip: set[str]) -> str:
    terms = [
        term
        for term in re.findall(r"[\w-]+", query, flags=re.UNICODE)
        if unicodedata.normalize("NFKD", term).encode("ascii", "ignore").decode("ascii").lower()
        not in terms_to_strip
    ]
    return _dedupe_query_terms(" ".join(terms))


def _prepare_commons_query(query: str) -> str:
    if _is_heraldry_query(query):
        terms = set(_normalized_terms(query))
        if terms.intersection({"shield", "shields"}):
            subject = _strip_heraldry_terms(query) or query
            return f"{subject} coat of arms"
        return _dedupe_query_terms(query)

    try:
        translated = build_search_query(query)
    except Exception:
        translated = query

    cleaned = _dedupe_query_terms(translated) or _dedupe_query_terms(query)
    lower_terms = {term.lower() for term in re.findall(r"[\w-]+", cleaned, flags=re.UNICODE)}
    if lower_terms.intersection(_ANIMAL_TERMS) and "animal" not in lower_terms:
        cleaned = f"{cleaned} animal".strip()
        lower_terms.add("animal")
    if lower_terms.isdisjoint(_GENERIC_IMAGE_TERMS):
        suffix = "image" if not lower_terms.isdisjoint(_ASSET_IMAGE_TERMS) else "photo"
        cleaned = f"{cleaned} {suffix}".strip()
    if lower_terms.intersection(_ANIMAL_TERMS):
        cleaned = f"{cleaned} " + " ".join(f"-{term}" for term in sorted(_ANIMAL_NEGATIVE_TERMS))
    return cleaned


def _food_query_variants(query: str, primary: str) -> List[str]:
    if not _is_food_query(query):
        return []

    original_subject = _strip_query_terms(query, _FOOD_QUERY_TERMS)
    translated_subject = _strip_query_terms(primary, _FOOD_QUERY_TERMS | _GENERIC_IMAGE_TERMS)

    subjects = []
    for subject in (translated_subject, original_subject):
        if subject and subject.lower() not in {item.lower() for item in subjects}:
            subjects.append(subject)

    variants = []
    for subject in subjects:
        variants.extend(
            [
                f"{subject} food",
                f"{subject} cuisine",
                f"{subject} restaurant",
            ]
        )
    return variants[:4]


def _terrace_query_variants(query: str, primary: str) -> List[str]:
    if not _is_terrace_query(query):
        return []

    original_subject = _strip_query_terms(query, _TERRACE_QUERY_TERMS)
    translated_subject = _strip_query_terms(primary, _TERRACE_QUERY_TERMS | _GENERIC_IMAGE_TERMS)

    subjects = []
    for subject in (translated_subject, original_subject):
        if subject and subject.lower() not in {item.lower() for item in subjects}:
            subjects.append(subject)

    variants = []
    original_terms = set(_normalized_terms(query))
    if original_subject and original_terms.intersection({"terraza", "terrazas"}):
        variants.extend([f"terrazas {original_subject}", f"terraza {original_subject}"])

    for subject in subjects:
        subject_terms = set(_normalized_terms(subject))
        if subject_terms.intersection({"lisboa", "lisbon"}):
            variants.append(f"{subject} terrace Portugal")
        variants.extend(
            [
                f"{subject} terrace",
                f"{subject} terraces",
                f"{subject} rooftop terrace",
                f"{subject} patio terrace",
            ]
        )
    return variants[:8]


def _prepare_commons_queries(query: str) -> List[str]:
    primary = _prepare_commons_query(query)
    queries = [primary]
    original = _dedupe_query_terms(query)
    original_terms = _normalized_terms(original)
    if len(original_terms) >= 2:
        queries.append(f'"{original}"')
    queries.extend(_semantic_query_variants(query, primary))
    queries.extend(_food_query_variants(query, primary))
    queries.extend(_terrace_query_variants(query, primary))

    result = []
    seen = set()
    for item in queries:
        item = item.strip()
        if not (item.startswith('"') and item.endswith('"')):
            item = _dedupe_query_terms(item)
        key = item.lower()
        if item and key not in seen:
            seen.add(key)
            result.append(item)
    return result


def _normalized_phrase(query: str) -> str:
    return " ".join(_normalized_terms(query))


def _title_without_file_prefix(title: str) -> str:
    normalized = _normalized_phrase(title)
    return normalized[5:] if normalized.startswith("file ") else normalized


def _looks_like_royal_place(title_text: str, original_terms: List[str]) -> bool:
    return (
        original_terms[:2] == ["real", "madrid"]
        and bool(_ROYAL_PLACE_TERMS.intersection(title_text.split()))
    )


def _looks_like_wrong_lisboa_place(page_text: str, original_terms: List[str]) -> bool:
    original_set = set(original_terms)
    return (
        bool(original_set.intersection({"lisboa", "lisbon"}))
        and not original_set.intersection({"macau", "macao"})
        and bool(_MACAU_LISBOA_TERMS.intersection(page_text.split()))
    )


def _score_commons_page(page: Dict[str, Any], info: Dict[str, Any], query: str, original_query: str) -> int:
    terms = [
        term.lower()
        for term in _normalized_terms(query)
        if (
            term.lower() not in _GENERIC_IMAGE_TERMS
            and term.lower() not in _ANIMAL_NEGATIVE_TERMS
            and term.lower() not in {"animal", "animals"}
            and len(term) > 2
        )
    ]
    if not terms:
        return 0

    metadata = info.get("extmetadata") or {}
    metadata_text = " ".join(
        str(value.get("value", ""))
        for value in metadata.values()
        if isinstance(value, dict)
    )
    title = str(page.get("title", ""))
    haystack = " ".join(_normalized_terms(html.unescape(f"{title} {metadata_text}")))
    title_haystack = _normalized_phrase(title)
    file_title = _title_without_file_prefix(title)
    original_phrase = _normalized_phrase(original_query)
    original_terms = original_phrase.split()

    score = sum(haystack.count(term) for term in terms)
    if all(term in haystack for term in terms):
        score += 10
    if all(term in title_haystack for term in terms):
        score += 20
    if len(original_terms) >= 2 and original_phrase:
        if file_title.startswith(original_phrase):
            score += 120
        elif original_phrase in file_title:
            score += 80
        if _looks_like_royal_place(file_title, original_terms):
            score -= 120
        if _looks_like_wrong_lisboa_place(haystack, original_terms):
            score -= 160
    if _is_food_query(original_query):
        food_markers = _FOOD_RESULT_MARKERS.intersection(haystack.split())
        if food_markers:
            score += 50 + min(len(food_markers), 4) * 5
        else:
            score -= 80
    if _is_terrace_query(original_query):
        terrace_markers = _TERRACE_RESULT_MARKERS.intersection(haystack.split())
        if terrace_markers:
            score += 55 + min(len(terrace_markers), 4) * 5
        else:
            score -= 90
    if _is_heraldry_query(original_query):
        heraldry_markers = {"escudo", "brasao", "coat", "arms", "crest"}
        if "lisboa" in _normalized_terms(original_query) and "lisboa" in title_haystack:
            score += 30
        if title_haystack.startswith("file lisboa escudo") or title_haystack.startswith("file brasao de lisboa"):
            score += 80
        if "coat of arms" in html.unescape(title).lower() or heraldry_markers.intersection(title_haystack.split()):
            score += 35
    return score


def _commons_page_text(page: Dict[str, Any], info: Dict[str, Any]) -> str:
    metadata = info.get("extmetadata") or {}
    metadata_text = " ".join(
        str(value.get("value", ""))
        for value in metadata.values()
        if isinstance(value, dict)
    )
    return " ".join(_normalized_terms(html.unescape(f"{page.get('title', '')} {metadata_text}")))


def _search_wikimedia_image_entries(query: str, count: int = 20, offset: int = 0) -> List[Dict[str, str]]:
    """Search Wikimedia Commons and return direct image URLs ordered by relevance."""
    try:
        if time.time() < _COMMONS_BACKOFF_UNTIL:
            return []
        known_entries = _known_commons_entries(query, offset)
        responses = []
        commons_query_limit = 6 if offset <= 0 else 3
        commons_queries = _prepare_commons_queries(query)[:commons_query_limit]
        per_query_limit = min(max(count * 2, count), 50)
        if len(commons_queries) > 3:
            per_query_limit = min(max(count, 12), 24)

        def _fetch_commons(commons_query: str):
            global _COMMONS_BACKOFF_UNTIL
            params = {
                "action": "query",
                "generator": "search",
                "gsrsearch": commons_query,
                "gsrnamespace": "6",
                "gsrlimit": str(per_query_limit),
                "gsroffset": str(max(0, offset)),
                "prop": "imageinfo",
                "iiprop": "url|mime|size|extmetadata",
                "iiurlwidth": "1920",
                "format": "json",
                "origin": "*",
            }
            with httpx.Client(timeout=_SEARCH_TIMEOUT, follow_redirects=True, verify=False, headers=_HEADERS) as client:
                resp = client.get(_COMMONS_API_URL, params=params)
            if resp.status_code == 200:
                return commons_query, resp.json()
            if resp.status_code == 429:
                _COMMONS_BACKOFF_UNTIL = max(
                    _COMMONS_BACKOFF_UNTIL,
                    time.time() + _COMMONS_BACKOFF_SECONDS,
                )
            print(f"[image_gen] Commons status {resp.status_code} para: '{commons_query}'")
            return None

        max_commons_workers = 1 if offset > 0 else min(2, max(1, len(commons_queries)))
        with ThreadPoolExecutor(max_workers=max_commons_workers) as pool:
            future_map = {pool.submit(_fetch_commons, commons_query): commons_query for commons_query in commons_queries}
            for future in as_completed(future_map):
                try:
                    result = future.result()
                except Exception as exc:
                    print(f"[image_gen] Error buscando en Commons: {exc}")
                    continue
                if result:
                    responses.append(result)

        ranked = []
        seen = {entry["murl"] for entry in known_entries}
        seen_pages = {entry["purl"] for entry in known_entries}
        query_order = {commons_query: i for i, commons_query in enumerate(commons_queries)}
        for commons_query, payload in responses:
            query_index = query_order.get(commons_query, 999)
            pages = (payload.get("query") or {}).get("pages") or {}
            for page in pages.values():
                info = (page.get("imageinfo") or [{}])[0]
                mime = str(info.get("mime", "")).lower()
                if mime not in _COMMONS_MIME_TYPES:
                    continue
                if not _source_dimensions_ok(info.get("width"), info.get("height")):
                    continue
                page_text = None
                original_terms = _normalized_terms(query)
                if _is_heraldry_query(query):
                    page_text = _commons_page_text(page, info)
                    if not _HERALDRY_RESULT_MARKERS.intersection(page_text.split()):
                        continue
                page_text = page_text or _commons_page_text(page, info)
                if _looks_like_wrong_lisboa_place(page_text, original_terms):
                    continue
                if _is_food_query(query):
                    if not _FOOD_RESULT_MARKERS.intersection(page_text.split()):
                        continue
                if _is_terrace_query(query):
                    if not _TERRACE_RESULT_MARKERS.intersection(page_text.split()):
                        continue

                murl = str(info.get("thumburl") or info.get("url") or "").strip()
                purl = str(info.get("descriptionurl", "")).strip()
                if not _url_looks_like_usable_image(murl, query):
                    continue
                if not murl.startswith(("http://", "https://")) or murl in seen or purl in seen_pages:
                    continue

                seen.add(murl)
                seen_pages.add(purl)
                ranked.append(
                    (
                        _score_commons_page(page, info, commons_query, query),
                        query_index,
                        int(page.get("index", 999999)),
                        {
                            "murl": murl,
                            "purl": purl,
                        },
                    )
                )

        ranked.sort(key=lambda item: (-item[0], item[1], item[2]))
        entries = (known_entries + [entry for _score, _query_index, _index, entry in ranked])[:count]
        print(f"[image_gen] Commons encontro {len(entries)} URLs para: '{query}'")
        return entries
    except Exception as exc:
        print(f"[image_gen] Error buscando en Commons: {exc}")
        return []


class _BingImageResultParser(HTMLParser):
    """Collect Bing Images result metadata from real image result anchors."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.primary_blocks: List[str] = []
        self.fallback_blocks: List[str] = []

    def handle_starttag(self, tag: str, attrs):
        if tag.lower() != "a":
            return

        attrs_by_name = {name.lower(): value for name, value in attrs if name and value}
        metadata = attrs_by_name.get("m")
        if not metadata or "murl" not in metadata:
            return

        classes = set(attrs_by_name.get("class", "").split())
        if "iusc" in classes:
            self.primary_blocks.append(metadata)
        else:
            self.fallback_blocks.append(metadata)


def _content_query_terms(query: str) -> List[str]:
    return [
        term
        for term in _normalized_terms(query)
        if term not in _GENERIC_IMAGE_TERMS
        and term not in _SEARCH_STOP_TERMS
        and len(term) > 2
    ]


def _query_match_term_sets(query: str) -> List[List[str]]:
    terms = _content_query_terms(query)
    return [terms] if len(terms) >= 2 else []


def _entry_matches_full_query(entry: Dict[str, str], query: str, term_sets: List[List[str]] | None = None) -> bool:
    term_sets = term_sets if term_sets is not None else _query_match_term_sets(query)
    if not term_sets:
        return True

    text = " ".join(
        _normalized_terms(
            " ".join(
                str(entry.get(key, ""))
                for key in ("murl", "purl", "title", "desc")
            )
        )
    )
    text_terms = set(text.split())
    for terms in term_sets:
        if " ".join(terms) in text:
            return True
        if all(term in text_terms for term in terms):
            return True
    return False


def _entry_search_text(entry: Dict[str, Any]) -> str:
    return " ".join(
        _normalized_terms(
            " ".join(
                str(entry.get(key, ""))
                for key in ("murl", "purl", "title", "desc")
            )
        )
    )


def _score_search_entry(entry: Dict[str, Any], query: str) -> int:
    terms = _content_query_terms(query)
    if not terms:
        return 1

    text = _entry_search_text(entry)
    text_terms = set(text.split())
    query_phrase = " ".join(terms)
    score = 0

    if query_phrase and query_phrase in text:
        score += 70
    matching_terms = 0
    for term in terms:
        if term in text_terms:
            score += 12
            matching_terms += 1
        elif term in text:
            score += 6
            matching_terms += 1
    if matching_terms >= max(2, len(terms) - 1):
        score += 35
    elif matching_terms == 1 and len(terms) <= 2:
        score += 8

    width = _safe_int(entry.get("width"))
    height = _safe_int(entry.get("height"))
    if width and height:
        if _source_dimensions_ok(width, height):
            score += 8
        else:
            score -= 60

    if not _url_looks_like_usable_image(str(entry.get("murl", "")), query):
        score -= 80

    return score


def _entries_from_metadata_blocks(
    blocks: List[str],
    count: int,
    query: str,
    term_sets: List[List[str]],
) -> List[Dict[str, str]]:
    entries: List[Dict[str, str]] = []
    seen = set()

    for block in blocks:
        try:
            data = json.loads(html.unescape(block))
        except (TypeError, json.JSONDecodeError):
            continue

        murl = str(data.get("murl", "")).strip()
        if not murl.startswith(("http://", "https://")) or murl in seen:
            continue

        width = _safe_int(data.get("w") or data.get("ow"))
        height = _safe_int(data.get("h") or data.get("oh"))
        if not (width and height):
            width, height = _infer_dimensions_from_text(
                murl,
                data.get("purl", ""),
                data.get("t", ""),
                data.get("desc", ""),
            )

        entry = {
            "murl": murl,
            "purl": str(data.get("purl", "")).strip(),
            "title": str(data.get("t", "")).strip(),
            "desc": str(data.get("desc", "")).strip(),
            "width": width,
            "height": height,
        }
        if not _url_looks_like_usable_image(murl, query):
            continue
        if not _source_dimensions_ok(entry["width"], entry["height"]):
            continue

        seen.add(murl)
        entries.append(entry)
        if len(entries) >= count:
            break

    return entries


def _parse_bing_image_entries(html_text: str, count: int, query: str) -> List[Dict[str, str]]:
    parser = _BingImageResultParser()
    parser.feed(html_text)
    term_sets = _query_match_term_sets(query)

    entries = _entries_from_metadata_blocks(parser.primary_blocks, count, query, term_sets)
    if entries:
        return entries

    return _entries_from_metadata_blocks(parser.fallback_blocks, count, query, term_sets)


def _bing_query_variants(query: str) -> List[str]:
    query = query.strip()
    if not query:
        return []

    variants = [query]
    normalized = re.sub(
        r"\bmirador\s+(?:de\s+)?san\s+pedro\s+de\s+alcantara\b",
        "Miradouro de Sao Pedro de Alcantara",
        query,
        flags=re.IGNORECASE,
    )
    if normalized != query:
        variants.append(normalized)
    return variants


def _bing_market_candidates(query: str) -> List[str]:
    terms = set(_normalized_terms(query))
    markets = [""]
    if terms.intersection({"lisboa", "lisbon", "portugal", "porto"}):
        markets.extend(["pt-PT", "en-US"])
    else:
        markets.extend(["es-ES", "en-US", "pt-PT"])

    result = []
    seen = set()
    for market in markets:
        if market not in seen:
            seen.add(market)
            result.append(market)
    return result


def _score_bing_result_set(entries: List[Dict[str, str]], query: str) -> int:
    terms = _content_query_terms(query)
    if not entries:
        return 0
    if not terms:
        return len(entries)

    score = min(len(entries), 10)
    for rank, entry in enumerate(entries[:12]):
        text = _entry_search_text(entry)
        text_terms = set(text.split())
        hits = 0
        for term in terms:
            if term in text_terms or term in text:
                hits += 1
        score += hits * max(1, 12 - rank)
        if hits >= max(2, len(terms) - 1):
            score += 25
    return score


def _search_bing_image_entries(query: str, count: int = 20, offset: int = 0) -> List[Dict[str, str]]:
    best_entries: List[Dict[str, str]] = []
    best_score = -1
    best_market = ""

    try:
        with httpx.Client(timeout=_SEARCH_TIMEOUT, follow_redirects=True, verify=False, headers=_HEADERS) as client:
            for bing_query in _bing_query_variants(query):
                for market in _bing_market_candidates(bing_query):
                    params = {
                        "q": bing_query,
                        "first": str(max(1, offset + 1)),
                        "form": "HDRSC3",
                        "safeSearch": "Strict",
                    }
                    if market:
                        params["mkt"] = market
                    url = f"{_BING_SEARCH_URL}?{urllib.parse.urlencode(params)}"
                    resp = client.get(url)
                    if resp.status_code != 200:
                        print(f"[image_gen] Bing status {resp.status_code} para: '{bing_query}'")
                        continue

                    entries = []
                    seen = set()
                    seen_pages = set()
                    for entry in _parse_bing_image_entries(resp.text, count, bing_query):
                        key = entry["murl"]
                        page_key = entry.get("purl", "")
                        if key in seen or (page_key and page_key in seen_pages):
                            continue
                        seen.add(key)
                        if page_key:
                            seen_pages.add(page_key)
                        entries.append(entry)

                    score = _score_bing_result_set(entries, bing_query)
                    if score > best_score:
                        best_score = score
                        best_entries = entries
                        best_market = market

        market_label = best_market or "default"
        print(f"[image_gen] Bing encontro {len(best_entries)} URLs para: '{query}' ({market_label})")
        return best_entries
    except Exception as exc:
        print(f"[image_gen] Error scrapeando Bing: {exc}")
        return []


def _merge_image_entries(*groups: List[Dict[str, str]], count: int) -> List[Dict[str, str]]:
    entries = []
    seen = set()
    for group in groups:
        for entry in group:
            key = entry.get("murl") or entry.get("purl")
            if not key or key in seen:
                continue
            seen.add(key)
            entries.append(entry)
            if len(entries) >= count:
                return entries
    return entries


def _scrape_image_entries_uncached(query: str, count: int = 20, offset: int = 0) -> List[Dict[str, str]]:
    """Return image search results from Bing using the exact user query."""
    return _search_bing_image_entries(query, count=count, offset=offset)


def _scrape_bing_image_entries(query: str, count: int = 20, offset: int = 0) -> List[Dict[str, str]]:
    cached = _get_cached_search(query, count, offset)
    if cached is not None:
        return cached

    entries = _scrape_image_entries_uncached(query, count=count, offset=offset)
    _set_cached_search(query, count, offset, entries)
    return entries


def scrape_bing_image_urls(query: str, count: int = 20) -> List[str]:
    """Return a list of direct image URLs (public)."""
    return [e["murl"] for e in _scrape_bing_image_entries(query, count)]


def _download_headers(referer_url: str = "") -> Dict[str, str]:
    headers = dict(_IMAGE_HEADERS)
    referer_url = (referer_url or "").strip()
    if referer_url.startswith(("http://", "https://")):
        parsed = urllib.parse.urlparse(referer_url)
        headers["Referer"] = referer_url
        headers["Origin"] = f"{parsed.scheme}://{parsed.netloc}"
    return headers


def _quote_url_for_request(url: str) -> str:
    parsed = urllib.parse.urlsplit(url.strip())
    path = urllib.parse.quote(parsed.path, safe="/%:@")
    query = urllib.parse.quote(parsed.query, safe="=&?/:+,%")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, query, parsed.fragment))


def _fetch_image_bytes(client: httpx.Client, url: str, headers: Dict[str, str]):
    with client.stream("GET", url, headers=headers) as resp:
        content_length = _safe_int(resp.headers.get("content-length"))
        if content_length and content_length > _MAX_DOWNLOAD_BYTES:
            return resp.status_code, b"", resp.headers.get("content-type", ""), f"content-length {content_length}"

        chunks = []
        total = 0
        for chunk in resp.iter_bytes():
            total += len(chunk)
            if total > _MAX_DOWNLOAD_BYTES:
                return resp.status_code, b"", resp.headers.get("content-type", ""), f"download > {_MAX_DOWNLOAD_BYTES}"
            chunks.append(chunk)

        return resp.status_code, b"".join(chunks), resp.headers.get("content-type", ""), ""


def _download_and_resize(img_url: str, output_path: Path, referer_url: str = "") -> bool:
    """Download an image URL and resize/crop to 1920x1080. Returns True on success."""
    try:
        if not _url_looks_like_usable_image(img_url):
            return False
        request_url = _quote_url_for_request(img_url)
        header_options = [_download_headers(referer_url)]
        if referer_url:
            header_options.append(_download_headers(""))

        status_code = 0
        content = b""
        reject_reason = ""
        with httpx.Client(timeout=_DOWNLOAD_TIMEOUT, follow_redirects=True, verify=False) as client:
            for headers in header_options:
                status_code, content, _content_type, reject_reason = _fetch_image_bytes(client, request_url, headers)
                if status_code == 200 and len(content) >= 4096:
                    break
        if status_code != 200 or len(content) < 4096:
            suffix = f" reason={reject_reason}" if reject_reason else ""
            print(f"[image_gen] Descarga rechazada status={status_code} bytes={len(content)}{suffix} url={img_url[:100]}")
            return False
        img = Image.open(io.BytesIO(content))
        if img.width * img.height > _MAX_IMAGE_PIXELS:
            print(f"[image_gen] Imagen demasiado grande {img.width}x{img.height}: {img_url[:100]}")
            return False
        img = img.convert("RGB")
        if not _source_dimensions_ok(img.width, img.height):
            print(f"[image_gen] Imagen demasiado pequena {img.width}x{img.height}: {img_url[:100]}")
            return False
        img = _fit_crop(img, 1920, 1080)
        img.save(str(output_path), "JPEG", quality=92, optimize=True)
        return True
    except Exception as exc:
        print(f"[image_gen] Error descargando {img_url[:80]}: {exc}")
        return False


def download_url_to_path(img_url: str, output_path: Path, referer_url: str = "") -> bool:
    """Public wrapper: download external URL, resize, save. Used by API endpoints."""
    return _download_and_resize(img_url, output_path, referer_url=referer_url)


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
        if _download_and_resize(entry["murl"], out_path, referer_url=entry.get("purl", "")):
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
