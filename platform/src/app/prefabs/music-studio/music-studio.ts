import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MusicApiService, type MusicTrack } from '../../services/music-api.service';

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
  tags = signal<string>('lofi,piano,chill,instrumental');
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

  // Quick-pick style chips.
  readonly stylePresets = [
    'lofi,piano,chill',
    'epic,cinematic,orchestral',
    'synthwave,retro,80s',
    'acoustic,folk,warm',
    'edm,dance,energetic',
    'jazz,smooth,saxophone',
  ];

  ngOnInit(): void {
    void this.refreshHealth();
    void this.refreshTracks();
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

  addPreset(preset: string): void {
    this.tags.set(preset);
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
