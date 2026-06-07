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
 *  - the `x-theitemapp-skip-webhooks` header on every write (the SDK sets it by
 *    default — `skipWebhooks` defaults to `true`);
 *  - re-exported `CoreApiError` so importers don't break.
 *
 * User-attributed writes/uploads (`createTrack`, `patchTrack`, `uploadFile`)
 * forward the END USER's `Authorization`/`Cookie` (so the track row + audio
 * file are owned by the caller, per files/dynamic RBAC) WHILE still carrying
 * the functional `x-api-key` + skip-webhooks header. This is exactly the SDK's
 * `asUser({ authorization, cookie }, { keepApiKey: true })` scoped client — no
 * raw `fetch` needed. `verifyAuth` delegates to the SDK's `verifyUser` (boolean
 * helper consumed by the routes' auth preHandler).
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

  /**
   * Create a music_tracks row via the dynamic API, attributed to the originating
   * user by forwarding their `authorization`/`cookie` via
   * `asUser(..., { keepApiKey: true })` (user creds + functional key + skip-
   * webhooks header). Returns the inserted document id.
   */
  async createTrack(
    doc: Record<string, unknown>,
    authorization?: string,
    cookie?: string,
  ): Promise<{ _id: string }> {
    return this.sdk
      .asUser({ authorization, cookie }, { keepApiKey: true })
      .create<{ _id: string }>('music_tracks', doc);
  }

  /**
   * Patch a music_tracks row via `$set`. Prefer the originating user's creds
   * (they own the row); the background job falls back to the app key only if
   * the user's token has expired during a long generation (called with no
   * `authorization`/`cookie`, so the scoped client carries just the functional
   * key).
   *
   * Uses `asUser(..., { keepApiKey: true })` so the request forwards BOTH the
   * user's creds AND the functional key — the same dual-auth the raw request
   * used to send.
   */
  async patchTrack(
    id: string,
    patch: Record<string, unknown>,
    authorization?: string,
    cookie?: string,
  ): Promise<void> {
    await this.sdk
      .asUser({ authorization, cookie }, { keepApiKey: true })
      .update('music_tracks', id, { $set: patch });
  }

  /**
   * Upload a binary blob to core's `/api/files/uploadDirect`. MUST be called
   * with the originating user's `authorization`/`cookie` so the generated track
   * file is created in THAT user's name (ownerId = the user), not the app's
   * functional user.
   *
   * Delegates to `asUser(..., { keepApiKey: true }).uploadFile(...)` — the
   * scoped client forwards the user's creds AND the functional key + skip-
   * webhooks header, and builds the multipart body. `kind: 'file'` and the
   * `private`-default visibility match the prior raw form fields.
   */
  async uploadFile(
    blob: FileBlob,
    options: { title?: string; visibility?: 'private' | 'public' } = {},
    authorization?: string,
    cookie?: string,
  ): Promise<{ _id: string }> {
    return this.sdk
      .asUser({ authorization, cookie }, { keepApiKey: true })
      .uploadFile(blob.bytes, {
        filename: blob.filename,
        mimeType: blob.mimeType,
        kind: 'file',
        visibility: options.visibility === 'public' ? 'everyone' : 'private',
        ...(options.title ? { title: options.title } : {}),
      });
  }
}
