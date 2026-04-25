# Arcanator — Documentación Técnica

## Índice

1. [Visión general](#1-visión-general)
2. [Arquitectura](#2-arquitectura)
3. [Estructura de ficheros](#3-estructura-de-ficheros)
4. [Backend](#4-backend)
   - [API REST](#41-api-rest)
   - [Pipeline de procesamiento](#42-pipeline-de-procesamiento)
   - [Persistencia en disco](#43-persistencia-en-disco)
5. [Servicios](#5-servicios)
   - [Transcripción](#51-transcripción-transcriptionpy)
   - [Extracción de keywords](#52-extracción-de-keywords-prompt_builderpy)
   - [Scraping y descarga de imágenes](#53-scraping-y-descarga-de-imágenes-image_genpy)
   - [Generación de vídeo](#54-generación-de-vídeo-video_genpy)
6. [Frontend](#6-frontend)
   - [Página de subida](#61-página-de-subida-indexhtml--appjs)
   - [Editor de timeline](#62-editor-de-timeline-editorhtml--editorjs)
   - [Panel de búsqueda](#63-panel-de-búsqueda)
   - [Lightbox](#64-lightbox)
   - [Sincronización de waveform](#65-sincronización-de-waveform)
7. [Modelo de datos](#7-modelo-de-datos)
8. [Flujo completo de un job](#8-flujo-completo-de-un-job)
9. [Despliegue](#9-despliegue)
   - [Local](#91-local)
   - [Railway (Docker)](#92-railway-docker)
10. [Dependencias](#10-dependencias)

---

## 1. Visión general

**Arcanator** es una aplicación web que convierte un podcast de audio en un vídeo ilustrado automáticamente. El proceso es:

1. El usuario sube un fichero de audio (MP3, WAV, M4A, OGG, FLAC, MP4, WebM)
2. La app transcribe el audio con Whisper y lo divide en fragmentos temporales (slots)
3. Para cada slot busca imágenes automáticamente en Bing Images
4. El usuario revisa y ajusta las imágenes en un editor de timeline
5. La app exporta un vídeo MP4 con efecto Ken-Burns y audio original sincronizado

No requiere ninguna API key externa. Todo el procesamiento es local.

---

## 2. Arquitectura

```
┌─────────────────────────────────────────────────────┐
│                     Navegador                       │
│  index.html / app.js  ←→  editor.html / editor.js  │
│  (subida + progreso)       (timeline + exportación) │
└────────────────────┬────────────────────────────────┘
                     │ HTTP / SSE
┌────────────────────▼────────────────────────────────┐
│              FastAPI  (main.py)                     │
│                                                     │
│  POST /api/jobs              → crea job             │
│  GET  /api/jobs/{id}/stream  → SSE tiempo real      │
│  GET  /api/jobs/{id}         → estado (polling)     │
│  PATCH /api/jobs/{id}/slots/{n}   → subir imagen    │
│  POST /api/jobs/{id}/slots/{n}/select-candidate     │
│  POST /api/jobs/{id}/slots/{n}/use-url              │
│  GET  /api/search            → búsqueda libre       │
│  GET  /api/jobs/{id}/slots/{n}/search               │
│  POST /api/jobs/{id}/export                         │
│  GET  /api/health                                   │
│                                                     │
│  Estáticos: /frontend/*, /output/*                  │
└──────┬──────────┬──────────┬───────────────────────┘
       │          │          │
  transcription  image_gen  video_gen
  (Whisper)    (Bing+PIL)  (FFmpeg)
                   │
             prompt_builder
             (YAKE + GoogleTranslate)
```

**Modelo de concurrencia:**
- Cada job corre en un hilo daemon (`threading.Thread`)
- `_jobs: Dict[str, dict]` es el store en memoria, protegido con `threading.Lock`
- Los eventos SSE se canalizan por `queue.Queue` por job (máx. 2000 mensajes)
- La persistencia en disco (`job.json`) se escribe tras cada mutación de estado

---

## 3. Estructura de ficheros

```
Arcanator/
├── backend/
│   ├── main.py                  # FastAPI app, endpoints, job manager
│   ├── requirements.txt
│   └── services/
│       ├── __init__.py
│       ├── transcription.py     # faster-whisper wrapper
│       ├── prompt_builder.py    # YAKE + Google Translate ES→EN
│       ├── image_gen.py         # Bing scraping + descarga + candidatos
│       └── video_gen.py         # FFmpeg Ken-Burns + concat + mux
├── frontend/
│   ├── index.html               # Página de subida
│   ├── app.js                   # Lógica de subida y progreso
│   ├── editor.html              # Editor de timeline
│   ├── editor.js                # Toda la lógica del editor
│   └── styles.css               # CSS custom (Tailwind + overrides)
├── output/                      # Generado en runtime (gitignored)
│   └── {job_id}/
│       ├── job.json             # Estado persistido del job
│       ├── audio.{ext}          # Audio original
│       ├── images/
│       │   ├── {n}_0.jpg        # Candidato 0 del slot n
│       │   ├── {n}_1.jpg        # Candidato 1 del slot n
│       │   └── {n}_2.jpg        # Candidato 2 del slot n
│       ├── segments/            # Segmentos de vídeo intermedios
│       └── output.mp4           # Vídeo final exportado
├── Dockerfile
├── railway.toml
├── .dockerignore
├── .gitignore
├── TECHNICAL.md                 # Este fichero
├── install.bat                  # Instalación automática Windows
└── start.bat                    # Arranque rápido Windows
```

---

## 4. Backend

### 4.1 API REST

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| `GET` | `/api/health` | Healthcheck (Railway) |
| `POST` | `/api/jobs` | Crea job: `audio` (file) + `interval` (int, 5-60s) |
| `GET` | `/api/jobs/{id}` | Estado completo del job |
| `GET` | `/api/jobs/{id}/stream` | SSE: `state`, `slot_ready`, `export_progress`, `export_done`, `export_error` |
| `PATCH` | `/api/jobs/{id}/slots/{n}` | Reemplaza imagen del slot con fichero local |
| `POST` | `/api/jobs/{id}/slots/{n}/select-candidate` | Selecciona candidato por índice; lo rota a posición 0 |
| `GET` | `/api/jobs/{id}/slots/{n}/search` | Búsqueda Bing para el slot (`entries` con `url` + `page_url`) |
| `POST` | `/api/jobs/{id}/slots/{n}/use-url` | Descarga URL externa y la añade como candidato |
| `GET` | `/api/search?q=&offset=` | Búsqueda libre para el panel lateral |
| `POST` | `/api/jobs/{id}/export` | Lanza exportación a MP4 |

**Respuesta de búsqueda** (endpoints `/api/search` y `/slots/{n}/search`):
```json
{
  "entries": [
    { "url": "https://...", "page_url": "https://..." }
  ],
  "query": "...",
  "offset": 0
}
```

**Estructura de candidato** (interna y en respuestas de API):
```json
{
  "url": "https://url-directa-imagen-bing",
  "page_url": "https://pagina-web-fuente",
  "path": "/ruta/absoluta/images/0_0.jpg",
  "image_url": "/output/{job_id}/images/0_0.jpg"
}
```

### 4.2 Pipeline de procesamiento

`_process_job(job_id)` corre en hilo daemon:

```
1. Transcripción
   faster-whisper "base", language="es", beam_size=5, vad_filter=True
   → agrupa segmentos en slots de interval_seconds

2. Generación de imágenes (paralelo, MAX_WORKERS=2)
   Para cada slot:
     a. build_search_query(text_es)    → keywords EN
     b. _scrape_bing_image_entries()   → [{murl, purl}]
     c. _download_and_resize() × 3    → JPEG 1920×1080 fit-crop
     d. slot["candidates"] = [...]
     e. on_image_ready() → SSE "slot_ready" + _save_job()

3. Exportación (bajo demanda, POST /export)
   Para cada slot:
     FFmpeg zoompan (Ken-Burns) + fade in/out → segmento H.264
   Concat demuxer → une segmentos sin re-encode
   Mux final → añade audio AAC 192k
   → output.mp4
```

### 4.3 Persistencia en disco

- **`_save_job(job_id)`** — escribe `OUTPUT_DIR/{job_id}/job.json` (best-effort, no lanza excepción)
- Se llama tras cada mutación: creación, `_update_job()`, selección de candidato, use-url, reemplazo local, on_image_ready()
- **`_load_jobs_from_disk()`** — escanea `OUTPUT_DIR/*/job.json` al arrancar el servidor
- Jobs en estados intermedios al arrancar (`queued`, `transcribing`, `generating_images`, `exporting`) se marcan como `error` (no recuperables)
- Decorador `@app.on_event("startup")` llama a `_load_jobs_from_disk()`

---

## 5. Servicios

### 5.1 Transcripción (`transcription.py`)

- **Modelo:** `faster-whisper` `base` (~147 MB), CPU, `compute_type=int8`
- Singleton con lazy-load protegido por `threading.Lock`
- Parámetros: `language="es"`, `beam_size=5`, `vad_filter=True`, `min_silence_duration_ms=500`
- Agrupa segmentos de Whisper en slots de duración `interval_seconds`
- El texto restante al final se incluye en un último slot aunque no alcance el intervalo

### 5.2 Extracción de keywords (`prompt_builder.py`)

- **YAKE** extrae hasta 6 bigramas relevantes del texto español (offline, sin red)
- Blacklist de stopwords filtra palabras que YAKE puede dejar pasar
- **deep-translator** (GoogleTranslator) traduce las keywords ES→EN
- `build_search_query(text_es)` → string de keywords en inglés para usar como query en Bing

### 5.3 Scraping y descarga de imágenes (`image_gen.py`)

**`_scrape_bing_image_entries(query, count)`**
- GET a `https://www.bing.com/images/search` con headers de Chrome real
- Extrae `murl` (URL directa de imagen) con regex sobre el HTML entity-encoded de Bing
- Extrae `purl` (página web fuente) buscando **hacia atrás** 1200 caracteres antes de cada `murl`, porque en el JSON de Bing el campo `purl` precede al `murl` en cada objeto resultado
- `verify=False` en httpx para entornos con proxy corporativo SSL (Zscaler)
- Retorna `[{"murl": "...", "purl": "..."}]`

**`generate_candidates(query, images_dir, index)`**
- Descarga hasta 3 candidatos por slot (`_CANDIDATES = 3`)
- Mezcla aleatoriamente los resultados a partir del 5º para variedad
- Redimensiona cada imagen a 1920×1080 con `_fit_crop` (scale-to-fill + center crop, Lanczos)
- Genera imagen de fallback con PIL si ninguna descarga tiene éxito

**`generate_all_images(slots, job_dir, job_id, on_ready)`**
- `ThreadPoolExecutor(max_workers=2)` para paralelizar slots
- Llama `on_ready(index, slot)` por cada slot completado → emite evento SSE `slot_ready`

### 5.4 Generación de vídeo (`video_gen.py`)

- **Salida:** H.264 High Profile, CRF 18, 1920×1080 @ 25 fps, AAC 192 kbps
- **Ken-Burns:** filtro `zoompan` de FFmpeg, zoom lineal de 1.0 → 1.18, 7 patrones de pan aleatorios (centro, izquierda, derecha, arriba, abajo, diagonal ↘, diagonal ↙)
- **Fade:** fade-in + fade-out de 0.4s por segmento vía filtro `fade`
- **Concat:** concat demuxer (fichero `.txt` de lista) → une segmentos sin re-encodear
- **Mux final:** `-map 0:v -map 1:a` en lugar de `-shortest` para evitar truncado de audio; el último slot se extiende hasta la duración exacta del audio obtenida con `ffprobe`
- `shutil.which("ffmpeg")` localiza el binario en el PATH del sistema

---

## 6. Frontend

Stack: **HTML + Tailwind CSS (CDN) + Vanilla JS**. Sin framework, sin build step.

### 6.1 Página de subida (`index.html` + `app.js`)

- Formulario con drag-and-drop para el fichero de audio + slider de intervalo (5-60s)
- `POST /api/jobs` con `FormData`
- Conecta a `GET /api/jobs/{id}/stream` (SSE) para mostrar progreso en tiempo real
- Polling fallback cada 2s vía `setInterval` si SSE falla (`es.onerror`)
- Redirige a `editor.html?job={id}` cuando el status pasa a `done`

### 6.2 Editor de timeline (`editor.html` + `editor.js`)

**Timeline horizontal**
- Una tarjeta `slot-card` (220px de ancho fijo) por cada slot
- Cada tarjeta: badge de tiempo, texto transcrito, columna de candidatos, botones
- Scroll horizontal sincronizado con el waveform

**Columna de candidatos (`appendCandidateImg`)**
- Muestra hasta 3 imágenes candidatas (124px de alto cada una)
- La imagen en posición 0 (seleccionada) tiene el badge ✓ (`.candidate-check`)
- Toda imagen que tiene `page_url` (independientemente de si está seleccionada) muestra el badge 🔗 (`.candidate-source-link`) con enlace a la web de origen
- Click en imagen posición 0 → `openLightbox(imgUrl)`
- Click en imagen posición 1 o 2 → `selectCandidate()` → `POST select-candidate` → la rota a posición 0
- La imagen se añade al DOM **antes** que los overlays para que éstos queden encima en z-index
- Drag & drop: cada imagen es `draggable=true`; el card completo es drop target

**Acciones del slot**
- `🔍 Ver búsqueda` → abre panel lateral con query automática del slot
- `📁 Local` → file picker → `PATCH /slots/{n}` con `FormData`
- Drag & drop desde panel o desde otra tarjeta → `POST use-url`

### 6.3 Panel de búsqueda

- Desliza desde la derecha (`transform: translateX`, 560px de ancho)
- Query inicial = `slot.prompt` (keywords EN generadas por YAKE+translate)
- Campo de búsqueda editable + botón "Buscar" + Enter
- Scroll infinito: `IntersectionObserver` sobre `#panel-sentinel`; al llegar al final llama `loadPanelResults(query, reset=false)` con `offset` incremental
- Cada imagen del panel muestra 🔗 si tiene `page_url` (posición `absolute`, esquina inferior izquierda)
- Click en imagen → `useExternalUrl(slotIdx, url, pageUrl)` → `POST use-url` con `{ url, page_url }`
- El candidato resultante queda guardado con `page_url`, por lo que aparece el badge 🔗 en la columna

### 6.4 Lightbox

- `#lightbox`: `position: fixed`, `z-index: 100`, fondo `rgba(0,0,0,0.9)`
- Se activa al hacer click en la imagen candidata en posición 0
- `openLightbox(url)` / `closeLightbox()` añaden/quitan la clase `hidden`
- Se cierra con: click en el fondo, botón ✕, o tecla Escape
- Tecla Escape: cierra el lightbox si está abierto; si no, no interfiere

### 6.5 Sincronización de waveform

- **WaveSurfer.js 7** renderiza el waveform en `#waveform` (altura 80px, barras 2px)
- `applyWaveformZoom()` calcula el zoom como `timelineScrollWidth / audioDuration` px/seg
- Resultado: el waveform tiene exactamente la misma longitud horizontal que el timeline
- Sincronización bidireccional de `scrollLeft`:
  - Listener en `timelineScroll` → actualiza el contenedor interno de WaveSurfer
  - Listener en el contenedor de WaveSurfer → actualiza `timelineScroll`
- La función se llama cuando ambas condiciones se cumplen: `wavesurferReady=true` Y `timelineBuiltScrollWidth > 0`

---

## 7. Modelo de datos

### Job

```json
{
  "id": "uuid-v4",
  "status": "queued | transcribing | generating_images | done | error",
  "audio_path": "/ruta/absoluta/audio.mp3",
  "audio_url": "/output/{id}/audio.mp3",
  "interval": 10,
  "slots": [ ],
  "progress_message": "...",
  "progress_percent": 0,
  "error": null,
  "download_url": "/output/{id}/output.mp4"
}
```

### Slot

```json
{
  "index": 0,
  "start": 0.0,
  "end": 10.5,
  "text": "Texto transcrito del fragmento...",
  "prompt": "english search keywords",
  "image_url": "/output/{id}/images/0_0.jpg",
  "image_path": "/ruta/absoluta/images/0_0.jpg",
  "custom": false,
  "candidates": [
    {
      "url": "https://url-directa-bing",
      "page_url": "https://pagina-web-fuente",
      "path": "/ruta/absoluta/images/0_0.jpg",
      "image_url": "/output/{id}/images/0_0.jpg"
    }
  ]
}
```

El candidato en posición 0 es siempre el **seleccionado** (el que aparece en el vídeo exportado).

---

## 8. Flujo completo de un job

```
Usuario sube audio
        │
        ▼
POST /api/jobs
  → crea entrada en _jobs + escribe job.json
  → lanza _process_job() en hilo daemon
  → devuelve { job_id }
        │
        ▼  (frontend conecta SSE)
_process_job():
  ┌─ 1. Transcripción ──────────────────────────────┐
  │  status = "transcribing"                         │
  │  faster-whisper → raw_segments → slots[]         │
  └─────────────────────────────────────────────────┘
        │
  ┌─ 2. Imágenes (ThreadPoolExecutor, workers=2) ───┐
  │  status = "generating_images"                    │
  │  por cada slot (paralelo):                       │
  │    YAKE → translate → query_en                   │
  │    _scrape_bing_image_entries() → [{murl,purl}]  │
  │    _download_and_resize() × 3 → candidatos       │
  │    on_image_ready() → SSE "slot_ready"           │
  │    _save_job()                                   │
  └─────────────────────────────────────────────────┘
        │
        ▼  SSE "slot_ready" → frontend renderiza tarjeta
        │  (usuario revisa, ajusta imágenes)
        │
  ┌─ 3. Exportación (POST /export) ─────────────────┐
  │  por cada slot:                                  │
  │    FFmpeg: imagen → zoompan + fade → segmento    │
  │  concat demuxer → une todos los segmentos        │
  │  mux → añade audio AAC                           │
  │  SSE "export_progress" (por slot)                │
  │  SSE "export_done" → { download_url }            │
  └─────────────────────────────────────────────────┘
        │
        ▼
Usuario descarga output.mp4
```

---

## 9. Despliegue

### 9.1 Local (Windows)

**Requisitos:** Python 3.12, FFmpeg añadido al PATH

```powershell
# Primera vez
cd C:\Arcanator\backend
python -m venv venv
venv\Scripts\pip install -r requirements.txt

# Arrancar servidor
$env:PATH = "C:\...\ffmpeg\bin;" + $env:PATH
cd C:\Arcanator\backend
venv\Scripts\uvicorn.exe main:app --host 0.0.0.0 --port 8000 --reload
```

Accesible en:
- Local: `http://localhost:8000`
- Red local (móvil/otro PC en misma WiFi): `http://{IP-local}:8000`

Si el firewall de Windows bloquea el acceso desde la red local:
```powershell
New-NetFirewallRule -DisplayName "Arcanator" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow
```

### 9.2 Railway (Docker)

**`Dockerfile`** — multi-stage:
- **Stage builder** (`python:3.12-slim`): instala deps Python con `pip install --prefix=/install`
- **Stage runtime** (`python:3.12-slim`): instala `ffmpeg` + `curl`, copia código, pre-descarga modelo Whisper base (~150 MB baked en imagen para que el primer request sea rápido)

**`railway.toml`**:
```toml
[build]
dockerfile = "Dockerfile"

[deploy]
startCommand = "uvicorn backend.main:app --host 0.0.0.0 --port $PORT"
healthcheckPath = "/api/health"
healthcheckTimeout = 30
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3
```

**Configuración en Railway:**
- Variable de entorno: `OUTPUT_DIR=/data/output`
- Volumen persistente montado en `/data/output` (para que los jobs sobrevivan reinicios)
- El healthcheck `GET /api/health` devuelve `{"status": "ok"}`

---

## 10. Dependencias

### Python (backend/requirements.txt)

| Paquete | Versión | Uso |
|---------|---------|-----|
| fastapi | 0.111.0 | Framework HTTP / API REST |
| uvicorn[standard] | 0.29.0 | Servidor ASGI |
| faster-whisper | 1.0.3 | Transcripción local (modelo base, CPU, int8) |
| httpx | 0.27.0 | HTTP client para scraping Bing y descarga de imágenes (`verify=False` para proxy Zscaler) |
| python-multipart | 0.0.9 | Soporte `multipart/form-data` para subida de ficheros |
| yake | 0.4.8 | Extracción de keywords offline |
| deep-translator | 1.11.4 | Traducción ES→EN via Google |
| Pillow | 10.3.0 | Resize/crop de imágenes, generación de imagen fallback |

### Sistema

| Herramienta | Uso |
|-------------|-----|
| Python 3.12 | Runtime |
| FFmpeg 8.x | Generación de segmentos Ken-Burns, concat, mux de audio |

### JavaScript (frontend, CDN — sin instalación)

| Librería | Versión | Uso |
|----------|---------|-----|
| WaveSurfer.js | 7.x | Visualización y reproducción del waveform |
| Tailwind CSS | 3.x (play CDN) | Clases utilitarias de estilos |
