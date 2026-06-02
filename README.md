# Music — AI music generation for TheItemApp

Type a style (and optional lyrics) and get back a full song with vocals, generated
locally by [HeartMuLa](https://github.com/HeartMuLa/heartlib) (Apache-2.0) on the GPU.

## Architecture

Three services on the shared `theitemapp` Docker network — cleanly divided, no
ComfyUI involvement:

| Service | Tech | Port (internal → host) | Role |
|---|---|---|---|
| `music-engine` | Python · FastAPI · heartlib | 8600 → 8600 | The model. `POST /generate` (lyrics + tags → mp3), `GET /health`, and a `/app/resources` GPU self-report for the System Monitor. Owns its GPU usage. |
| `music-api` | Node · Fastify (ESM) | 3009 → 3010 | Its own backend. Registers with core, proxies generation behind auth, persists results, tracks status. |
| `music` | Angular 21 · Native Federation | 80 → 4211 | Studio (compose) + Player (playlist) micro-frontend prefabs, served by Caddy. |

(Host ports are the docker-compose defaults — `MUSIC_API_HOST_PORT=3010`,
`MUSIC_WEB_PORT=4211`, `MUSIC_ENGINE_PORT=8600`.)

## How generation works (async)

1. The **Music Studio** prefab POSTs `{title, lyrics, tags, durationMs}` (and
   optionally `temperature` / `cfgScale` / `topk`) to `/music-api/api/generate`.
2. `music-api` verifies auth, creates a `music_tracks` row in `status: generating`
   **under the caller's JWT** (so the row is owned by that user), returns its id
   immediately, and runs HeartMuLa in the background (generation is ~real-time).
3. When done it uploads the audio to core's `files` (also under the user's JWT, so
   the file is owned by the user) and patches the row to `status: ready` with
   `audioFileId` + `mimeType` (or `status: failed` + `error`).
4. The frontend polls the row and plays the result. The **Player** prefab browses
   the whole library of ready tracks as a playlist.

## Prefabs

- **Music Studio** (`musicStudio`, standalone) — compose form (tags, optional
  lyrics, duration), a categorized **style-chip picker** backed by `music_tags`,
  an engine-health badge, live generation progress, and inline playback of the
  result plus your recent tracks.
- **Music Player** (`musicPlayer`, multi) — playlist over ready `music_tracks`
  with a now-playing bar (play/pause, seek, next/previous) and light auto-refresh.

Two dashboards ship them: **Music Studio** (home — Studio + Player) and
**Library** (a `music_tracks` list + Player).

## Data models

- **`music_tracks`** — `title`, `tags`, `lyrics`, `status` (`generating` →
  `ready` / `failed`), `audioFileId` (→ `files`), `durationMs`, `engine`,
  `mimeType`, `error`. `status` / `audioFileId` / `error` are backend-managed.
- **`music_tags`** — a curated style-chip catalog (`key`, `label`, `category` of
  genre / mood / instrument / vocal / tempo / production, `order`, `enabled`).
  The Studio renders enabled tags as a chip picker grouped by category; the
  selected `label`s compose the comma-separated `tags` string sent to the engine.

Both are defined in `dbseed/items.json`; the tag seed is `dbseed/data/music_tags.json`.

## Engine, checkpoints & GPU

The HeartMuLa 3B + HeartCodec checkpoints (several GB) download on first engine
boot into the `heartmula-ckpt` Docker volume. The download is **resumable** and
gated by a `.download_complete` sentinel written only after all repos finish, so
an interrupted boot re-runs cleanly and rebuilds skip the download. Set `HF_TOKEN`
in the environment if the Hub rate-limits anonymous downloads.

`HEARTMULA_LAZY_LOAD=true` (the default) keeps HeartMuLa's modules off the GPU
between requests, so the engine **coexists with ComfyUI / Ollama** on the shared
GPU. The engine also implements the first-party `app-resources` contract:

- `GET /app/resources` — reports the `heartmula` workload's VRAM only while the
  model is resident (0 when idle), so the System Monitor attributes usage correctly.
- `POST /app/resources/unload/{key}` — drops the pipeline and frees VRAM in-process
  (it reloads lazily on the next `/generate`).

## Run

```
docker compose up -d --build
```

ObjectId namespace: `8c0000000000000000…`. App key: `music`.
