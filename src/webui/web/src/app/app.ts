import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { BottomNav } from './shared/bottom-nav/bottom-nav';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, BottomNav],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {}
