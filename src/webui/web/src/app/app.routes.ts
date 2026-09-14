import { Routes } from '@angular/router';
import { meGuard } from './core/me.guard';
import { browseMatcher } from './features/browse/browse.matcher';

// T22+ add the remaining routes (repo shell, terminals, admin). Repos and
// the directory browser (T21), `/denied`, and the catch-all exist so far.
//
// `/repo/**` is not expressible as an Angular route (`**` may only be a
// whole-route catch-all, not mid-path) — T22 will give it the same
// `UrlMatcher` treatment as `browseMatcher` below when it adds the repo
// shell component. Links to `/repo/<path>` already exist (repos-page,
// browse-page) and simply fall through the catch-all until then.
export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./features/repos/repos-page/repos-page').then(
        (m) => m.ReposPage,
      ),
    canActivate: [meGuard],
  },
  {
    matcher: browseMatcher,
    loadComponent: () =>
      import('./features/browse/browse-page/browse-page').then(
        (m) => m.BrowsePage,
      ),
    canActivate: [meGuard],
  },
  {
    path: 'denied',
    loadComponent: () =>
      import('./features/denied/denied').then((m) => m.Denied),
  },
  { path: '**', redirectTo: '' },
];
