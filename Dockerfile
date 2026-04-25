# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /app

# Install build deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM python:3.12-slim

WORKDIR /app

# Install FFmpeg (needed by video_gen.py) + curl (healthcheck)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy installed Python packages from builder
COPY --from=builder /install /usr/local

# Copy source code
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Pre-download the Whisper "base" model so first request is fast
# This bakes the model into the image (~150 MB)
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8')"

# Output directory — Railway mounts a volume here via RAILWAY_VOLUME_MOUNT_PATH
# If no volume is configured, falls back to /tmp/arcanator_output
ENV OUTPUT_DIR=/data/output
RUN mkdir -p /data/output

EXPOSE 8000

CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
