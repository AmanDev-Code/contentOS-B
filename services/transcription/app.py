"""
Trndinn Transcription Sidecar — faster-whisper service.

Single-purpose: receives audio file, returns word-level transcript.
Designed to be called by the NestJS Auto Caption Generator backend.
"""

import hashlib
import os
import tempfile
import time
from typing import Optional

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import JSONResponse

app = FastAPI(title="Trndinn Transcription Sidecar", version="1.0.0")

# Lazy-load model on first request (avoid slow startup blocking healthcheck)
_model = None
_model_loading = False

MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE", "large-v3-turbo")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
MAX_AUDIO_DURATION_SEC = int(os.environ.get("MAX_AUDIO_DURATION_SEC", "120"))


def get_model():
    """Get or load the Whisper model (singleton)."""
    global _model, _model_loading
    if _model is not None:
        return _model
    if _model_loading:
        raise HTTPException(status_code=503, detail="Model is loading, retry in a few seconds")
    _model_loading = True
    try:
        from faster_whisper import WhisperModel

        _model = WhisperModel(MODEL_SIZE, compute_type=COMPUTE_TYPE, device=DEVICE)
        return _model
    finally:
        _model_loading = False


@app.get("/health")
async def health():
    """Health check — returns 200 if service is alive."""
    return {"status": "ok", "model": MODEL_SIZE, "device": DEVICE}


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: Optional[str] = Query(None, description="ISO 639-1 language code or null for auto-detect"),
):
    """
    Transcribe an audio file and return word-level timestamps.

    Accepts WAV/MP3/FLAC/OGG audio. Returns segments with word-level timing.
    """
    model = get_model()

    # Validate content type loosely (accept audio/* or application/octet-stream)
    content_type = file.content_type or ""
    if not (content_type.startswith("audio/") or content_type == "application/octet-stream"):
        raise HTTPException(status_code=400, detail=f"Expected audio file, got: {content_type}")

    # Write to temp file (faster-whisper needs file path)
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    try:
        content = await file.read()
        # Basic size guard: 200MB max
        if len(content) > 200 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Audio file too large (max 200MB)")

        tmp.write(content)
        tmp.flush()
        tmp.close()

        # Compute SHA256 for dedup/caching upstream
        audio_hash = hashlib.sha256(content).hexdigest()

        start_time = time.time()

        # Transcribe with word-level timestamps
        segments_gen, info = model.transcribe(
            tmp.name,
            word_timestamps=True,
            language=language,
            vad_filter=True,
            vad_parameters=dict(
                min_silence_duration_ms=500,
                speech_pad_ms=200,
            ),
        )

        # Collect all segments and words
        segments = []
        all_words = []

        for segment in segments_gen:
            seg_data = {
                "start": round(segment.start, 3),
                "end": round(segment.end, 3),
                "text": segment.text.strip(),
                "words": [],
            }

            if segment.words:
                for word in segment.words:
                    word_data = {
                        "word": word.word.strip(),
                        "start": round(word.start, 3),
                        "end": round(word.end, 3),
                        "probability": round(word.probability, 3),
                    }
                    seg_data["words"].append(word_data)
                    all_words.append(word_data)

            segments.append(seg_data)

        elapsed_ms = round((time.time() - start_time) * 1000)

        return JSONResponse(
            content={
                "success": True,
                "audio_hash": audio_hash,
                "language": info.language,
                "language_probability": round(info.language_probability, 3),
                "duration_seconds": round(info.duration, 2),
                "transcription_ms": elapsed_ms,
                "segments": segments,
                "words": all_words,
                "full_text": " ".join(seg["text"] for seg in segments),
            }
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")
    finally:
        # Cleanup temp file
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
