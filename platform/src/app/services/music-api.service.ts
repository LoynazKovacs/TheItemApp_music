import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export type GenerateRequest = Readonly<{
  title?: string;
  lyrics?: string;
  tags?: string;
  durationMs?: number;
  temperature?: number;
  cfgScale?: number;
}>;

export type GenerateResponse = Readonly<{
  ok: boolean;
  trackId?: string;
  status?: string;
  error?: string;
}>;

export type MusicTrack = Readonly<{
  _id: string;
  title?: string;
  tags?: string;
  lyrics?: string;
  status?: 'generating' | 'ready' | 'failed';
  audioFileId?: string | { _id?: string } | null;
  durationMs?: number;
  error?: string;
  _meta?: { createdAt?: string };
}>;

export type EngineHealth = Readonly<{
  ok: boolean;
  upstreams?: { engine?: { ok: boolean; modelLoaded?: boolean; error?: string } };
  error?: string;
}>;

/**
 * Talks to /music-api endpoints and to core's dynamic API for the music_tracks
 * collection. Uses Angular HttpClient (shared singleton) so the host's auth
 * interceptor attaches the access token automatically.
 */
@Injectable({ providedIn: 'root' })
export class MusicApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = '/music-api';

  async health(): Promise<EngineHealth> {
    try {
      return await firstValueFrom(this.http.get<EngineHealth>(`${this.baseUrl}/api/upstreams/health`));
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    try {
      return await firstValueFrom(this.http.post<GenerateResponse>(`${this.baseUrl}/api/generate`, req));
    } catch (err: any) {
      const detail = err?.error?.error || err?.error?.message || (err instanceof Error ? err.message : 'Generation failed');
      return { ok: false, error: detail };
    }
  }

  /** Fetch a single track row by id (for polling generation status). */
  async getTrack(id: string): Promise<MusicTrack | null> {
    try {
      return await firstValueFrom(this.http.get<MusicTrack>(`/api/dynamic/music_tracks/${id}`));
    } catch {
      return null;
    }
  }

  /** List recent tracks (newest first). NB: core list sort param is `_s`. */
  async listTracks(limit = 100): Promise<MusicTrack[]> {
    try {
      const rows = await firstValueFrom(
        this.http.get<unknown>('/api/dynamic/music_tracks', {
          params: { _l: limit, _s: '-_id' },
        }),
      );
      return Array.isArray(rows) ? (rows as MusicTrack[]) : [];
    } catch {
      return [];
    }
  }

  /** Resolve the streamable audio URL for a track's file. */
  audioUrl(audioFileId: string | { _id?: string } | null | undefined): string | null {
    const id = typeof audioFileId === 'string' ? audioFileId : audioFileId?._id;
    return id ? `/api/files/${id}/content` : null;
  }
}
