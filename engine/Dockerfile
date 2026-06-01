# syntax=docker/dockerfile:1
#
# HeartMuLa music-generation engine.
#
# heartlib (https://github.com/HeartMuLa/heartlib, Apache-2.0) is a PyTorch
# library. We build on the cu121 PyTorch runtime image (matches the host's
# ComfyUI torch 2.4.1 / CUDA 12.1) and wrap the HeartMuLaGenPipeline in a small
# FastAPI server exposing POST /generate and GET /health.
#
# Checkpoints are NOT baked into the image (they are several GB). They download
# on first boot into the mounted heartmula-ckpt volume (see entrypoint.sh).

FROM pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# git: to pip-install heartlib from source. ffmpeg: torchaudio's mp3 encoder.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --upgrade pip \
  && pip install -r requirements.txt

COPY server.py entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 8600
ENTRYPOINT ["./entrypoint.sh"]
