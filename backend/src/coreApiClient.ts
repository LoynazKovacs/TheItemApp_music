/**
 * Core TheItemApp backend client for the music app.
 *
 * Thin adapter over the shared backend SDK's `CoreApiClient` + `verifyUser`
 * helper. It preserves this app's conventions so NO call-sites change:
 *  - the app's method names + signatures (`createTrack` / `patchTrack` /
 *    `uploadFile` / `verifyAuth` / `updateApiKey` / `hasApiKey`) used by the
 *    routes;
 *  - `$set`-wrapped track patches;
 *  - the originating user's `Authorization`/`Cookie` are forwarded on every
 *    write so the track row + audio file are owned by THAT user (their personal
 *    library), per files/dynamic RBAC;
 *  - the `x-theitemapp-skip-webhooks` header on every write;
 *  - re-exported `CoreApiError` so importers don't break.
 *
 * SDK gaps preserved with raw `fetch` (authenticated via `sdk.getApiKey()`):
 *  - `createTrack`, `patchTrack`, `uploadFile` forward the END USER's
 *    `Authorization`/`Cookie` WHILE still carrying the functional `x-api-key` +
 *    skip-webhooks header. The SDK's `updateAsUser` strips the functional key
 *    and supports neither cookie forwarding nor multipart upload, and there is
 *    no `createAsUser`/user-scoped `uploadFile`, so these keep raw requests.
 *  - `verifyAuth` delegates to the SDK's `verifyUser` (boolean helper consumed
 *    by the routes' auth preHandler).
 *
 * The functional `x-api-key` is auto-provisioned by core and rotated on each
 * registration — see `updateApiKey`.
 */

import {
  CoreApiClient as SdkCoreApiClient,
  CoreApiError,
  verifyUser,
  type CoreApiConfig as SdkCoreApiConfig,
} from '@loynazkovacs/theitemapp-backend-sdk';

export { CoreApiError };

export type CoreApiConfig = {
  baseUrl: string;
  apiKey: string | null;
};

export interface FileBlob {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
}

export class CoreApiClient {
  private readonly sdk: SdkCoreApiClient;
  private readonly baseUrl: string;

  constructor(config: CoreApiConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.sdk = new SdkCoreApiClient({ baseUrl: config.baseUrl, apiKey: config.apiKey } as SdkCoreApiConfig);
  }

  updateApiKey(apiKey: string): void {
    this.sdk.updateApiKey(apiKey);
  }

  hasApiKey(): boolean {
    return this.sdk.isReady();
  }

  async verifyAuth(authorization?: string, cookie?: string): Promise<boolean> {
    try {
      return (await verifyUser(this.baseUrl, { authorization, cookie })) !== null;
    } catch {
      return false;
    }
  }

  /** Create a music_tracks row via the dynamic API (under the caller's auth so
   *  they own the record). Returns the inserted document id.
   *
   *  SDK gap: the SDK has no `createAsUser`, and `updateAsUser`/`create` won't
   *  forward both the end-user creds AND the functional key, so this stays a raw
   *  request authenticated via `getApiKey()` while forwarding the user's creds. */
  async createTrack(
    doc: Record<string, unknown>,
    authorization?: string,
    cookie?: string,
  ): Promise<{ _id: string }> {
    const url = `${this.baseUrl}/api/dynamic/music_tracks`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.requestHeaders(authorization, cookie),
      body: JSON.stringify(doc),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new CoreApiError('POST', url, res.status, body.slice(0, 500));
    }
    return (await res.json()) as { _id: string };
  }

  /** Patch a music_tracks row via `$set`. Prefer the originating user's JWT
   *  (they own the row); the background job falls back to the app key only if
   *  the user's token has expired during a long generation.
   *
   *  SDK gap: `updateAsUser` strips the functional `x-api-key` and supports only
   *  a Bearer JWT (no cookie). This forwards BOTH the user's creds AND the
   *  functional key, so it stays a raw request authenticated via `getApiKey()`. */
  async patchTrack(
    id: string,
    patch: Record<string, unknown>,
    authorization?: string,
    cookie?: string,
  ): Promise<void> {
    const url = `${this.baseUrl}/api/dynamic/music_tracks/${encodeURIComponent(id)}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: this.requestHeaders(authorization, cookie),
      body: JSON.stringify({ $set: patch }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new CoreApiError('PUT', url, res.status, body.slice(0, 500));
    }
  }

  /**
   * Upload a binary blob to core's `/api/files/uploadDirect`. MUST be called
   * with the originating user's JWT so the generated track file is created in
   * THAT user's name (ownerId = the user), not the app's functional user.
   *
   * SDK gap: the SDK's `uploadFile` uses only the functional key (no end-user
   * forwarding) and a different visibility enum, so this stays a raw multipart
   * request authenticated via `getApiKey()`.
   */
  async uploadFile(
    blob: FileBlob,
    options: { title?: string; visibility?: 'private' | 'public' } = {},
    authorization?: string,
    cookie?: string,
  ): Promise<{ _id: string }> {
    const url = `${this.baseUrl}/api/files/uploadDirect`;
    const form = new FormData();
    form.append(
      'file',
      new Blob([blob.bytes as unknown as BlobPart], { type: blob.mimeType }),
      blob.filename,
    );
    if (options.title) form.append('title', options.title);
    form.append('kind', 'file');
    form.append('visibility', options.visibility ?? 'private');
    // Build headers manually WITHOUT Content-Type — FormData sets its own boundary.
    const apiKey = this.sdk.getApiKey();
    const headers: Record<string, string> = {};
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['x-theitemapp-skip-webhooks'] = '1';
    if (authorization?.trim()) headers.Authorization = authorization.trim();
    if (cookie?.trim()) headers.Cookie = cookie.trim();
    const res = await fetch(url, { method: 'POST', headers, body: form as unknown as BodyInit });
    if (!res.ok) {
      const body = await res.text();
      throw new CoreApiError('POST', url, res.status, body.slice(0, 500));
    }
    return (await res.json()) as { _id: string };
  }

  /** Functional-key headers (Content-Type + x-api-key + skip-webhooks). */
  private functionalHeaders(): Record<string, string> {
    const apiKey = this.sdk.getApiKey();
    return {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
      'x-theitemapp-skip-webhooks': '1',
    };
  }

  /** Functional-key headers plus the originating user's forwarded credentials. */
  private requestHeaders(authorization?: string, cookie?: string): Record<string, string> {
    const header = typeof authorization === 'string' && authorization.trim().length > 0 ? authorization.trim() : '';
    const cookieHeader = typeof cookie === 'string' && cookie.trim().length > 0 ? cookie.trim() : '';
    return {
      ...this.functionalHeaders(),
      ...(header ? { Authorization: header } : {}),
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    };
  }
}
