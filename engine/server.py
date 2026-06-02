"""HeartMuLa music-generation engine.

Wraps heartlib's HeartMuLaGenPipeline in a tiny FastAPI service:

    GET  /health    — liveness + whether the model is resident
    POST /generate  — { lyrics, tags, ... } -> audio/mpeg

The pipeline is created lazily on the first /generate call (so /health is up
immediately while checkpoints finish downloading) and reused thereafter. A
single lock serialises generation because the model is not thread-safe and the
GPU only does one job at a time anyway.
"""
from __future__ import annotations

import logging
import os
import tempfile
import threading

import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("music-engine")

MODEL_PATH = os.environ.get("HEARTMULA_MODEL_PATH", "/app/ckpt")
VERSION = os.environ.get("HEARTMULA_VERSION", "3B")
DEVICE = os.environ.get("HEARTMULA_DEVICE", "cuda")
LAZY_LOAD = os.environ.get("HEARTMULA_LAZY_LOAD", "true").strip().lower() in ("1", "true", "yes", "y")

app = FastAPI(title="HeartMuLa Music Engine")

_pipe = None
_pipe_lock = threading.Lock()   # guards one-time construction
_gen_lock = threading.Lock()    # serialises generation calls


def _get_pipe():
    """Construct (once) and return the HeartMuLaGenPipeline."""
    global _pipe
    if _pipe is not None:
        return _pipe
    with _pipe_lock:
        if _pipe is None:
            from heartlib import HeartMuLaGenPipeline

            log.info("Loading HeartMuLaGenPipeline from %s (version=%s, lazy_load=%s)", MODEL_PATH, VERSION, LAZY_LOAD)
            _pipe = HeartMuLaGenPipeline.from_pretrained(
                MODEL_PATH,
                device={"mula": torch.device(DEVICE), "codec": torch.device(DEVICE)},
                dtype={"mula": torch.bfloat16, "codec": torch.float32},
                version=VERSION,
                lazy_load=LAZY_LOAD,
            )
            log.info("Pipeline ready.")
    return _pipe


class GenerateRequest(BaseModel):
    # Lyrics with section markers, e.g. "[Verse]\n...\n[Chorus]\n...". An empty
    # string yields an instrumental.
    lyrics: str = ""
    # Comma-separated style/mood/instrument tags, e.g. "piano,happy,romantic".
    tags: str = ""
    max_audio_length_ms: int = 120_000
    topk: int = 50
    temperature: float = 1.0
    cfg_scale: float = 1.5


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "engine": "heartmula",
        "version": VERSION,
        "lazy_load": LAZY_LOAD,
        "model_loaded": _pipe is not None,
    }


def _vram_mb() -> float:
    try:
        if torch.cuda.is_available():
            return round(torch.cuda.memory_allocated() / (1024 ** 2), 1)
    except Exception:
        pass
    return 0.0


@app.get("/app/resources")
def app_resources() -> dict:
    """System-monitor GPU self-report (first-party `app-resources` contract).

    Reports the HeartMuLa workload only while the model is resident, so the
    monitor attributes 0 when idle (lazy) and the real VRAM during generation.
    """
    workloads = []
    if _pipe is not None:
        workloads.append({
            "key": "heartmula",
            "label": f"HeartMuLa {VERSION}",
            "vramMB": _vram_mb(),
            "device": DEVICE,
            "status": "loaded",
            "unloadable": True,
        })
    return {"workloads": workloads}


@app.post("/app/resources/unload/{key}")
def app_resources_unload(key: str) -> dict:
    """Drop the pipeline and free VRAM. HeartMuLa is a torch model, so unlike
    CTranslate2/ComfyUI this genuinely returns memory in-process; it reloads
    lazily on the next /generate."""
    global _pipe
    freed = False
    # Don't yank the model out from under an in-flight generation.
    with _gen_lock:
        if _pipe is not None:
            _pipe = None
            freed = True
    import gc
    gc.collect()
    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
    return {"unloaded": key, "success": freed}


@app.post("/generate")
def generate(req: GenerateRequest):
    if not req.lyrics.strip() and not req.tags.strip():
        raise HTTPException(status_code=400, detail="Provide at least one of: lyrics, tags")

    try:
        pipe = _get_pipe()
    except Exception as exc:  # checkpoint missing / load failure
        log.exception("Failed to load pipeline")
        raise HTTPException(status_code=503, detail=f"Engine not ready: {exc}") from exc

    workdir = tempfile.mkdtemp(prefix="heartmula-")
    lyrics_path = os.path.join(workdir, "lyrics.txt")
    tags_path = os.path.join(workdir, "tags.txt")
    out_path = os.path.join(workdir, "output.mp3")
    with open(lyrics_path, "w", encoding="utf-8") as fh:
        fh.write(req.lyrics)
    with open(tags_path, "w", encoding="utf-8") as fh:
        fh.write(req.tags)

    # heartlib reads lyrics/tags from file paths (see examples/run_music_generation.py).
    try:
        with _gen_lock:
            log.info("Generating: %d ms, topk=%d, temp=%.2f, cfg=%.2f", req.max_audio_length_ms, req.topk, req.temperature, req.cfg_scale)
            with torch.no_grad():
                pipe(
                    {"lyrics": lyrics_path, "tags": tags_path},
                    max_audio_length_ms=req.max_audio_length_ms,
                    save_path=out_path,
                    topk=req.topk,
                    temperature=req.temperature,
                    cfg_scale=req.cfg_scale,
                )
    except Exception as exc:
        log.exception("Generation failed")
        raise HTTPException(status_code=500, detail=f"Generation failed: {exc}") from exc

    if not os.path.exists(out_path):
        raise HTTPException(status_code=500, detail="Engine produced no output file")

    def _cleanup() -> None:
        import shutil
        shutil.rmtree(workdir, ignore_errors=True)

    return FileResponse(
        out_path,
        media_type="audio/mpeg",
        filename="output.mp3",
        background=BackgroundTask(_cleanup),
    )
