export class CoreApiError extends Error {
  public readonly status: number;
  public readonly method: string;
  public readonly url: string;
  public readonly body: string;

  constructor(method: string, url: string, status: number, body: string) {
    super(`[coreApi] ${method} ${url} failed: ${status} — ${body}`);
    this.name = 'CoreApiError';
    this.method = method;
    this.url = url;
    this.status = status;
    this.body = body;
  }
}

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
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config: CoreApiConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.headers = {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
      'x-theitemapp-skip-webhooks': '1',
    };
  }

  updateApiKey(apiKey: string): void {
    this.headers['x-api-key'] = apiKey;
  }

  hasApiKey(): boolean {
    return typeof this.headers['x-api-key'] === 'string' && this.headers['x-api-key'].length > 0;
  }

  async verifyAuth(authorization?: string, cookie?: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/auth/me`, {
        method: 'GET',
        headers: this.requestHeaders(authorization, cookie),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Create a music_tracks row via the dynamic API (under the caller's auth so
   *  they own the record). Returns the inserted document id. */
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
   *  the user's token has expired during a long generation. */
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
    const headers: Record<string, string> = {};
    if (this.headers['x-api-key']) headers['x-api-key'] = this.headers['x-api-key'];
    if (this.headers['x-theitemapp-skip-webhooks']) {
      headers['x-theitemapp-skip-webhooks'] = this.headers['x-theitemapp-skip-webhooks'];
    }
    if (authorization?.trim()) headers.Authorization = authorization.trim();
    if (cookie?.trim()) headers.Cookie = cookie.trim();
    const res = await fetch(url, { method: 'POST', headers, body: form as unknown as BodyInit });
    if (!res.ok) {
      const body = await res.text();
      throw new CoreApiError('POST', url, res.status, body.slice(0, 500));
    }
    return (await res.json()) as { _id: string };
  }

  private requestHeaders(authorization?: string, cookie?: string): Record<string, string> {
    const header = typeof authorization === 'string' && authorization.trim().length > 0 ? authorization.trim() : '';
    const cookieHeader = typeof cookie === 'string' && cookie.trim().length > 0 ? cookie.trim() : '';
    return {
      ...this.headers,
      ...(header ? { Authorization: header } : {}),
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    };
  }
}
