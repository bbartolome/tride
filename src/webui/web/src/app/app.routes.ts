import { Routes } from '@angular/router';
import { meGuard } from './core/me.guard';

// T21+ add the real routes (repos browser, terminals, admin). Only `/`
// (a placeholder), `/denied`, and the catch-all exist so far.
export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./features/repos/repos').then((m) => m.Repos),
    canActivate: [meGuard],
  },
  {
    path: 'denied',
    loadComponent: () =>
      import('./features/denied/denied').then((m) => m.Denied),
  },
  { path: '**', redirectTo: '' },
];
