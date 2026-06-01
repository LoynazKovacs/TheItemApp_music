# Music — AI music generation for TheItemApp

Type a style (and optional lyrics) and get back a full song with vocals, generated
locally by [HeartMuLa](https://github.com/HeartMuLa/heartlib) (Apache-2.0) on the GPU.

## Architecture

Three services on the shared `theitemapp` Docker network — cleanly divided, no
ComfyUI involvement:

| Service | Tech | Port | Role |
|---|---|---|---|
| `music-engine` | Python · FastAPI · heartlib | 8600 | The model. `POST /generate` (lyrics + tags → mp3), `GET /health`. Owns its GPU usage. |
| `music-api` | Node · Fastify | 3009 | Its own backend. Registers with core, proxies generation behind auth, persists results, tracks status. |
| `music` | Angular 21 · Native Federation | 80 (→4211) | Studio (compose) + Player (playlist) micro-frontend prefabs. |

## How generation works (async)

1. The **Music Studio** prefab POSTs `{title, lyrics, tags, durationMs}` to
   `/music-api/api/generate`.
2. `music-api` creates a `music_tracks` row in `status: generating`, returns its
   id immediately, and runs HeartMuLa in the background (generation is ~real-time).
3. When done it uploads the audio to core's `files` and patches the row to
   `status: ready` with `audioFileId` (or `failed` + `error`).
4. The frontend polls the row and plays the result. The **Player** prefab browses
   the whole library as a playlist.

## Data model

`music_tracks` — `title`, `tags`, `lyrics`, `status`, `audioFileId` (→ `files`),
`durationMs`, `engine`, `error`. Defined in `dbseed/items.json`.

## Checkpoints

The HeartMuLa 3B + HeartCodec checkpoints (several GB) download on first engine
boot into the `heartmula-ckpt` Docker volume, so rebuilds skip the download.
Set `HF_TOKEN` in the environment if the Hub rate-limits anonymous downloads.

## Run

```
docker compose up -d --build
```

ObjectId namespace: `8c0000000000000000…`. App key: `music`.
