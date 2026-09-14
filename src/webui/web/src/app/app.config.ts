import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';
import { errorInterceptor } from './core/error.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // `ng new --zoneless` did not actually wire this into the generated
    // app.config.ts (verified: no zone.js dependency, no `polyfills` entry
    // in angular.json, and no provideZonelessChangeDetection() call in the
    // scaffolded file) — added explicitly, since the zoneless change
    // detection scheduler Angular relies on for signal-driven updates is
    // only installed when this provider is present, not merely by omitting
    // zone.js.
    provideZonelessChangeDetection(),
    // `withFetch()` is deliberately NOT passed here: as of Angular 22.1
    // it is @deprecated — `FetchBackend` is now `provideHttpClient()`'s
    // default `HttpBackend` with no flag needed (verified against the
    // installed @angular/common typings), so passing it would only add a
    // deprecation warning for no behavioral change. The plan's original
    // instruction predates this default flip.
    provideHttpClient(withInterceptors([errorInterceptor])),
    provideRouter(routes, withComponentInputBinding()),
  ],
};
