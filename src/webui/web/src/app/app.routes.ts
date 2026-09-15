import { Routes } from '@angular/router';
import { adminGuard } from './core/admin.guard';
import { meGuard } from './core/me.guard';
import { browseMatcher } from './features/browse/browse.matcher';
import { repoDiffMatcher, repoMatcher } from './features/repo/repo.matcher';

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
    path: 'terminals',
    loadComponent: () =>
      import('./features/terminal/terminals-list/terminals-list').then(
        (m) => m.TerminalsList,
      ),
    canActivate: [meGuard],
  },
  {
    path: 'terminal/:id',
    loadComponent: () =>
      import('./features/terminal/terminal-view/terminal-view').then(
        (m) => m.TerminalView,
      ),
    canActivate: [meGuard],
  },
  {
    // `meGuard` here guarantees `SessionStore` is loaded before `adminGuard`
    // (on the child route below) ever runs. The bottom-nav's `/admin` tab
    // link lands on the bare parent, so the empty child redirects straight
    // to `users` — there's nothing else under `/admin` yet.
    path: 'admin',
    canActivate: [meGuard],
    children: [
      { path: '', redirectTo: 'users', pathMatch: 'full' },
      {
        path: 'users',
        canActivate: [adminGuard],
        loadComponent: () =>
          import('./features/admin/users-page/users-page').then(
            (m) => m.UsersPage,
          ),
      },
    ],
  },
  {
    path: 'denied',
    loadComponent: () =>
      import('./features/denied/denied').then((m) => m.Denied),
  },
  { path: '**', redirectTo: '' },
];
