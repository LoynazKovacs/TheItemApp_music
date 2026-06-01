export interface AppConfig {
  port: number;
  coreApiUrl: string;
  coreApiKey: string | null;
  engineBaseUrl: string;
  engineTimeoutMs: number;
  appKey: string;
  appRegistrationKey: string | null;
  registrationBaseUrl: string;
  registrationHeartbeatMs: number;
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseMs(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getConfig(): AppConfig {
  const port = parsePort(process.env.MUSIC_API_PORT, 3009);
  const appKey = (process.env.MUSIC_APP_KEY ?? '').trim() || 'music';

  return {
    port,
    coreApiUrl: (process.env.CORE_API_URL ?? '').trim() || 'http://backend:3001',
    coreApiKey: (process.env.MUSIC_CORE_API_KEY ?? '').trim() || null,
    engineBaseUrl: (process.env.MUSIC_ENGINE_BASE_URL ?? '').trim() || 'http://music-engine:8600',
    engineTimeoutMs: parseMs(process.env.MUSIC_ENGINE_TIMEOUT_MS, 15 * 60 * 1000),
    appKey,
    appRegistrationKey: (process.env.APP_REGISTRATION_KEY ?? '').trim() || null,
    registrationBaseUrl: (process.env.MUSIC_REGISTRATION_BASE_URL ?? '').trim() || `http://music-api:${port}`,
    registrationHeartbeatMs: parseMs(process.env.MUSIC_REGISTRATION_HEARTBEAT_MS, 5 * 60 * 1000),
  };
}
