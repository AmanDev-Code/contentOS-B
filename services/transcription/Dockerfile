FROM python:3.11-slim

WORKDIR /app

# System deps for faster-whisper (CTranslate2) and audio handling
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Download model at build time so container starts fast
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('large-v3-turbo', compute_type='int8', device='cpu')"

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
