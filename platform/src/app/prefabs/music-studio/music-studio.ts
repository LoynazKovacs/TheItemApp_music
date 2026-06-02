import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MusicApiService, type MusicTrack, type MusicTag } from '../../services/music-api.service';

type GenState = 'idle' | 'generating' | 'ready' | 'failed';

@Component({
  selector: 'music-studio',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './music-studio.html',
  styleUrl: './music-studio.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MusicStudioComponent implements OnInit, OnDestroy {
  private readonly api = inject(MusicApiService);
  private readonly cdr = inject(ChangeDetectorRef);

  // Form state.
  title = signal<string>('');
  tags = signal<string>('lo-fi, piano, ambient');
  lyrics = signal<string>('');
  durationSec = signal<number>(60);

  // Generation state.
  state = signal<GenState>('idle');
  statusText = signal<string>('');
  errorText = signal<string | null>(null);
  elapsedSec = signal<number>(0);

  // Library + now playing.
  tracks = signal<readonly MusicTrack[]>([]);
  nowPlayingId = signal<string | null>(null);

  // Engine health.
  engineReady = signal<boolean | null>(null);
  engineError = signal<string | null>(null);

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;

  // Style-tag catalog (loaded from the music_tags model), grouped by category.
  tagGroups = signal<readonly { category: string; tags: readonly MusicTag[] }[]>([]);
  private readonly categoryOrder = ['genre', 'mood', 'instrument', 'vocal', 'tempo', 'production'];

  ngOnInit(): void {
    void this.refreshHealth();
    void this.refreshTracks();
    void this.loadTags();
  }

  async loadTags(): Promise<void> {
    const tags = await this.api.listTags();
    const byCat = new Map<string, MusicTag[]>();
    for (const t of tags) {
      const arr = byCat.get(t.category) ?? [];
      arr.push(t);
      byCat.set(t.category, arr);
    }
    const ordered = [...byCat.keys()].sort(
      (a, b) => (this.categoryOrder.indexOf(a) + 1 || 99) - (this.categoryOrder.indexOf(b) + 1 || 99),
    );
    this.tagGroups.set(
      ordered.map((category) => ({
        category,
        tags: (byCat.get(category) ?? []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
      })),
    );
    this.cdr.markForCheck();
  }

  /** Tokens currently in the comma-separated tags string (the source of truth). */
  private tokens(): string[] {
    return this.tags()
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }

  isTagSelected(label: string): boolean {
    const l = label.toLowerCase();
    return this.tokens().some((t) => t.toLowerCase() === l);
  }

  toggleTag(label: string): void {
    const l = label.toLowerCase();
    const toks = this.tokens();
    const next = toks.some((t) => t.toLowerCase() === l)
      ? toks.filter((t) => t.toLowerCase() !== l)
      : [...toks, label];
    this.tags.set(next.join(', '));
  }

  ngOnDestroy(): void {
    this.stopTimers();
  }

  async refreshHealth(): Promise<void> {
    const h = await this.api.health();
    this.engineReady.set(h.ok && Boolean(h.upstreams?.engine?.ok));
    this.engineError.set(h.ok ? null : h.error ?? h.upstreams?.engine?.error ?? 'Engine unreachable');
    this.cdr.markForCheck();
  }

  async refreshTracks(): Promise<void> {
    const rows = await this.api.listTracks(100);
    this.tracks.set(rows);
    this.cdr.markForCheck();
  }

  canGenerate(): boolean {
    return this.state() !== 'generating' && (this.tags().trim().length > 0 || this.lyrics().trim().length > 0);
  }

  async generate(): Promise<void> {
    if (!this.canGenerate()) return;
    this.state.set('generating');
    this.errorText.set(null);
    this.statusText.set('Sending to the engine…');
    this.startElapsed();

    const res = await this.api.generate({
      title: this.title().trim() || undefined,
      tags: this.tags().trim(),
      lyrics: this.lyrics().trim(),
      durationMs: Math.round(this.durationSec() * 1000),
    });

    if (!res.ok || !res.trackId) {
      this.fail(res.error || 'Could not start generation');
      return;
    }

    this.statusText.set('Composing your track… this is roughly real-time, so a 1-minute song takes ~1 minute.');
    this.cdr.markForCheck();
    void this.refreshTracks();
    this.pollTrack(res.trackId);
  }

  private pollTrack(trackId: string): void {
    this.stopPoll();
    // Generous ceiling: ~3x requested length + 2 min of headroom.
    const maxMs = this.durationSec() * 1000 * 3 + 120_000;
    const startedAt = Date.now();

    this.pollTimer = setInterval(async () => {
      if (Date.now() - startedAt > maxMs) {
        this.fail('Timed out waiting for the engine. The track may still finish — check the library.');
        void this.refreshTracks();
        return;
      }
      const track = await this.api.getTrack(trackId);
      if (!track) return;
      if (track.status === 'ready') {
        this.stopTimers();
        this.state.set('ready');
        this.statusText.set('Done!');
        this.nowPlayingId.set(track._id);
        await this.refreshTracks();
        this.cdr.markForCheck();
      } else if (track.status === 'failed') {
        this.fail(track.error || 'Generation failed');
        void this.refreshTracks();
      }
    }, 2500);
  }

  private fail(message: string): void {
    this.stopTimers();
    this.state.set('failed');
    this.errorText.set(message);
    this.statusText.set('');
    this.cdr.markForCheck();
  }

  private startElapsed(): void {
    this.elapsedSec.set(0);
    this.stopElapsed();
    this.elapsedTimer = setInterval(() => {
      this.elapsedSec.update((s) => s + 1);
      this.cdr.markForCheck();
    }, 1000);
  }

  private stopTimers(): void {
    this.stopPoll();
    this.stopElapsed();
  }

  private stopPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private stopElapsed(): void {
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
  }

  play(track: MusicTrack): void {
    this.nowPlayingId.set(track._id);
  }

  audioUrl(track: MusicTrack): string | null {
    return this.api.audioUrl(track.audioFileId ?? null);
  }

  trackById(_i: number, t: MusicTrack): string {
    return t._id;
  }

  fmtTime(s: number): string {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }
}
