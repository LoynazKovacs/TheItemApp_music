import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'music-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {}
