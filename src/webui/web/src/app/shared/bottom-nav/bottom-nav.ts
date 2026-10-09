import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
} from '@angular/router';
import { filter, map } from 'rxjs';

interface NavTab {
  path: string;
  label: string;
  icon: string;
}

const TABS: NavTab[] = [
  { path: '/', label: 'Repos', icon: '📁' },
  { path: '/admin', label: 'Admin', icon: '⚙️' },
];

/**
 * Bottom tab bar for the mobile-first shell. Hides itself entirely on
 * `/denied` — there is nothing to navigate to once access has been
 * refused, and showing tabs there would imply the app still works.
 */
@Component({
  selector: 'app-bottom-nav',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './bottom-nav.html',
  styleUrl: './bottom-nav.scss',
})
export class BottomNav {
  private readonly router = inject(Router);

  protected readonly tabs = TABS;

  protected readonly hidden = toSignal(
    this.router.events.pipe(
      filter(
        (event): event is NavigationEnd => event instanceof NavigationEnd,
      ),
      map((event) => event.urlAfterRedirects.startsWith('/denied')),
    ),
    { initialValue: this.router.url.startsWith('/denied') },
  );
}
