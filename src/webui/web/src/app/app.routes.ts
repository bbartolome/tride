import { Routes } from '@angular/router';
import { meGuard } from './core/me.guard';
import { browseMatcher } from './features/browse/browse.matcher';
import { repoDiffMatcher, repoMatcher } from './features/repo/repo.matcher';

// T24+ add the remaining routes (terminals, admin). Repos and the
// directory browser (T21), the repo shell + diff viewer (T22), `/denied`,
// and the catch-all exist so far.
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
  // `repoDiffMatcher` MUST come before `repoMatcher` — it is the more
  // specific of the two, and Angular tries matchers top to bottom (F159).
  {
    matcher: repoDiffMatcher,
    loadComponent: () =>
      import('./features/diff/diff-viewer/diff-viewer').then(
        (m) => m.DiffViewer,
      ),
    canActivate: [meGuard],
  },
  {
    matcher: repoMatcher,
    loadComponent: () =>
      import('./features/repo/repo-shell/repo-shell').then(
        (m) => m.RepoShell,
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
