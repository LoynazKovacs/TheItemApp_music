#!/usr/bin/env bash
# Download HeartMuLa checkpoints into the persistent volume on first boot, then
# start the FastAPI server.
#
# Robustness: the download is gated on a `.download_complete` sentinel that is
# written ONLY after all three repos finish. `snapshot_download` resumes partial
# downloads, so an interrupted/restarted container simply re-runs and completes
# the missing files instead of falsely concluding the checkpoints are present
# (an earlier bug gated on gen_config.json, which the first sub-download creates).
set -euo pipefail

CKPT="${HEARTMULA_MODEL_PATH:-/app/ckpt}"
SENTINEL="$CKPT/.download_complete"

download() {
  python3 - <<PY
from huggingface_hub import snapshot_download
import os
ckpt = os.environ.get("HEARTMULA_MODEL_PATH", "/app/ckpt")
jobs = [
    ("HeartMuLa/HeartMuLaGen", ckpt),
    ("HeartMuLa/HeartMuLa-oss-3B-happy-new-year", ckpt + "/HeartMuLa-oss-3B"),
    ("HeartMuLa/HeartCodec-oss-20260123", ckpt + "/HeartCodec-oss"),
]
for repo, dest in jobs:
    print(f"Downloading {repo} -> {dest}", flush=True)
    snapshot_download(repo, local_dir=dest)
print("All checkpoints downloaded.", flush=True)
PY
}

if [ ! -f "$SENTINEL" ]; then
  echo "[entrypoint] Checkpoints incomplete — downloading (resumable, multi-GB first time)..."
  download
  touch "$SENTINEL"
  echo "[entrypoint] Checkpoint download complete."
else
  echo "[entrypoint] Checkpoints complete ($SENTINEL present) — skipping download."
fi

echo "[entrypoint] Starting HeartMuLa engine on :8600"
exec uvicorn server:app --host 0.0.0.0 --port 8600
