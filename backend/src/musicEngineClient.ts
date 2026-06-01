export interface MusicEngineOptions {
  baseUrl: string;
  timeoutMs: number;
}

export interface GenerateParams {
  lyrics: string;
  tags: string;
  maxAudioLengthMs?: number;
  topk?: number;
  temperature?: number;
  cfgScale?: number;
}

export interface GeneratedAudio {
  bytes: Uint8Array;
  mimeType: string;
}

/**
 * Thin client around the HeartMuLa engine's HTTP API on port 8600.
 *
 *   GET  /health    — liveness + model residency
 *   POST /generate  — { lyrics, tags, ... } -> audio/mpeg bytes
 */
export class MusicEngineClient {
  constructor(private readonly options: MusicEngineOptions) {}

  async getHealth(): Promise<{ ok: boolean; status: number; modelLoaded?: boolean; error?: string }> {
    try {
      const res = await this.fetchWithTimeout('/health', { method: 'GET' }, 10_000);
      if (!res.ok) return { ok: false, status: res.status, error: `Upstream HTTP ${res.status}` };
      const data = (await res.json()) as { model_loaded?: boolean };
      return { ok: true, status: res.status, modelLoaded: Boolean(data?.model_loaded) };
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async generate(params: GenerateParams): Promise<GeneratedAudio> {
    const res = await this.fetchWithTimeout(
      '/generate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lyrics: params.lyrics ?? '',
          tags: params.tags ?? '',
          max_audio_length_ms: params.maxAudioLengthMs ?? 120_000,
          topk: params.topk ?? 50,
          temperature: params.temperature ?? 1.0,
          cfg_scale: params.cfgScale ?? 1.5,
        }),
      },
      this.options.timeoutMs,
    );
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`[MusicEngine] generate ${res.status}: ${errText.slice(0, 500)}`);
    }
    const mimeType = res.headers.get('content-type') || 'audio/mpeg';
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, mimeType };
  }

  private async fetchWithTimeout(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${this.options.baseUrl}${path}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
