import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MusicApiService, type MusicTrack } from '../../services/music-api.service';

@Component({
  selector: 'music-player',
  standalone: true,
  imports: [CommonModule],
  providers: [MusicApiService],
  templateUrl: './music-player.html',
  styleUrl: './music-player.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MusicPlayerComponent implements OnInit, OnDestroy {
  private readonly api = inject(MusicApiService);
  private readonly cdr = inject(ChangeDetectorRef);

  @ViewChild('audioEl') audioEl?: ElementRef<HTMLAudioElement>;

  tracks = signal<readonly MusicTrack[]>([]);
  currentId = signal<string | null>(null);
  playing = signal<boolean>(false);
  loading = signal<boolean>(true);

  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    void this.refresh();
    // Light auto-refresh so freshly generated tracks appear without reopening.
    this.refreshTimer = setInterval(() => void this.refresh(), 15_000);
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  async refresh(): Promise<void> {
    const rows = await this.api.listTracks(200);
    // Only ready, playable tracks belong in the playlist.
    this.tracks.set(rows.filter((t) => t.status === 'ready' && !!this.api.audioUrl(t.audioFileId ?? null)));
    this.loading.set(false);
    this.cdr.markForCheck();
  }

  current(): MusicTrack | null {
    const id = this.currentId();
    return this.tracks().find((t) => t._id === id) ?? null;
  }

  currentUrl(): string | null {
    const t = this.current();
    return t ? this.api.audioUrl(t.audioFileId ?? null) : null;
  }

  select(track: MusicTrack): void {
    this.currentId.set(track._id);
    // Let the [src] binding update, then start playback.
    setTimeout(() => {
      const el = this.audioEl?.nativeElement;
      if (el) {
        el.load();
        void el.play().catch(() => {});
      }
    });
  }

  togglePlay(): void {
    const el = this.audioEl?.nativeElement;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  }

  prev(): void {
    this.step(-1);
  }

  next(): void {
    this.step(1);
  }

  private step(delta: number): void {
    const list = this.tracks();
    if (list.length === 0) return;
    const idx = list.findIndex((t) => t._id === this.currentId());
    const nextIdx = idx < 0 ? 0 : (idx + delta + list.length) % list.length;
    this.select(list[nextIdx]);
  }

  onPlay(): void {
    this.playing.set(true);
    this.cdr.markForCheck();
  }

  onPause(): void {
    this.playing.set(false);
    this.cdr.markForCheck();
  }

  trackById(_i: number, t: MusicTrack): string {
    return t._id;
  }
}
