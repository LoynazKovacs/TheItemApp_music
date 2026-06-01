import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from './config.js';
import { CoreApiClient } from './coreApiClient.js';
import { MusicEngineClient } from './musicEngineClient.js';

interface RouteDeps {
  config: AppConfig;
  coreApi: CoreApiClient;
  engine: MusicEngineClient;
}

/** "Everyone" group — the music-backend functional user is a member, so tracks
 *  scoped to it are readable/editable by the background generation job. */
const EVERYONE_GROUP_ID = '7000000000000000001d0002';

function createAuthPreHandler(coreApi: CoreApiClient) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authorization = authorizationHeader(request.headers.authorization);
    const cookie = cookieHeader(request.headers.cookie);
    if (!authorization && !cookie) {
      return reply.code(401).send({ error: 'Authentication required' });
    }
    const valid = await coreApi.verifyAuth(authorization, cookie);
    if (!valid) {
      return reply.code(401).send({ error: 'Authentication required' });
    }
  };
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const requireAuth = createAuthPreHandler(deps.coreApi);

  app.get('/api/health', async () => ({ ok: true, app: 'music-api' }));

  app.get('/api/upstreams/health', async (_request, reply) => {
    const engine = await deps.engine.getHealth();
    return reply.send({
      ok: engine.ok,
      upstreams: {
        engine: { ok: engine.ok, status: engine.status, modelLoaded: engine.modelLoaded, error: engine.error },
      },
    });
  });

  // ---------------------------------------------------------------------------
  // Generate a song.
  //
  // Generation is roughly real-time (a 2-min song takes ~2 min), so this does
  // NOT block the HTTP request. It creates a `music_tracks` row in the
  // `generating` state, returns the id immediately, and runs the heavy work in
  // the background — flipping the row to `ready` (with `audioFileId`) or
  // `failed` (with `error`) when done. The frontend polls the row for status.
  // ---------------------------------------------------------------------------
  app.post('/api/generate', { preHandler: requireAuth }, async (request, reply) => {
    const body = (request.body || {}) as {
      title?: string;
      lyrics?: string;
      tags?: string;
      durationMs?: number;
      temperature?: number;
      cfgScale?: number;
      topk?: number;
    };

    const lyrics = (body.lyrics ?? '').trim();
    const tags = (body.tags ?? '').trim();
    if (!lyrics && !tags) {
      return reply.code(400).send({ error: 'Provide lyrics and/or tags' });
    }

    const title = (body.title ?? '').trim() || defaultTitle(tags);
    const maxAudioLengthMs = clampDuration(body.durationMs);

    const authorization = authorizationHeader(request.headers.authorization);
    const cookie = cookieHeader(request.headers.cookie);

    // 1. Create the track row (owned by the caller) in the generating state.
    let trackId: string;
    try {
      const created = await deps.coreApi.createTrack(
        {
          title,
          lyrics,
          tags,
          status: 'generating',
          engine: 'heartmula',
          durationMs: maxAudioLengthMs,
          groupIds: [EVERYONE_GROUP_ID],
        },
        authorization,
        cookie,
      );
      trackId = created._id;
    } catch (error) {
      request.log.error({ error }, 'Failed to create music_tracks row');
      return reply.code(502).send({ ok: false, error: 'Could not create the track record' });
    }

    // 2. Kick off generation in the background. Do not await.
    void generateInBackground(app, deps, {
      trackId,
      title,
      lyrics,
      tags,
      maxAudioLengthMs,
      temperature: body.temperature,
      cfgScale: body.cfgScale,
      topk: body.topk,
      authorization,
      cookie,
    });

    return reply.send({ ok: true, trackId, status: 'generating' });
  });
}

interface BackgroundJob {
  trackId: string;
  title: string;
  lyrics: string;
  tags: string;
  maxAudioLengthMs: number;
  temperature?: number;
  cfgScale?: number;
  topk?: number;
  authorization?: string;
  cookie?: string;
}

async function generateInBackground(app: FastifyInstance, deps: RouteDeps, job: BackgroundJob): Promise<void> {
  const started = Date.now();
  try {
    const audio = await deps.engine.generate({
      lyrics: job.lyrics,
      tags: job.tags,
      maxAudioLengthMs: job.maxAudioLengthMs,
      temperature: job.temperature,
      cfgScale: job.cfgScale,
      topk: job.topk,
    });

    const fileId = await uploadGenerated(deps, job, audio.bytes, audio.mimeType);

    await deps.coreApi.patchTrack(job.trackId, {
      status: 'ready',
      audioFileId: fileId,
      mimeType: audio.mimeType,
      error: '',
    });
    app.log.info({ trackId: job.trackId, ms: Date.now() - started }, 'Track generated');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    app.log.error({ error, trackId: job.trackId }, 'Background generation failed');
    try {
      await deps.coreApi.patchTrack(job.trackId, { status: 'failed', error: message.slice(0, 500) });
    } catch (patchErr) {
      app.log.error({ patchErr, trackId: job.trackId }, 'Failed to mark track as failed');
    }
  }
}

async function uploadGenerated(
  deps: RouteDeps,
  job: BackgroundJob,
  bytes: Uint8Array,
  mimeType: string,
): Promise<string> {
  const filename = `${slugify(job.title) || 'track'}.mp3`;
  // Try under the caller's auth first (so they own the file). If their token has
  // expired during a long generation, fall back to the functional user.
  try {
    const uploaded = await deps.coreApi.uploadFile(
      { bytes, mimeType, filename },
      { title: job.title, visibility: 'private' },
      job.authorization,
      job.cookie,
    );
    return uploaded._id;
  } catch {
    const uploaded = await deps.coreApi.uploadFile(
      { bytes, mimeType, filename },
      { title: job.title, visibility: 'private' },
    );
    return uploaded._id;
  }
}

function clampDuration(durationMs?: number): number {
  const n = typeof durationMs === 'number' && Number.isFinite(durationMs) ? durationMs : 120_000;
  // HeartMuLa supports up to ~4 min; floor at 10s, cap at 240s.
  return Math.min(Math.max(Math.round(n), 10_000), 240_000);
}

function defaultTitle(tags: string): string {
  const first = tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 2).join(' ');
  const base = first ? `${first} track` : 'Untitled track';
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function authorizationHeader(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === 'string' && entry.trim().length > 0);
    return typeof first === 'string' ? first.trim() : undefined;
  }
  return undefined;
}

function cookieHeader(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return undefined;
}
