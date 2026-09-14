import { UrlMatchResult, UrlSegment } from '@angular/router';

/**
 * Matches `/browse`, `/browse/<a>`, `/browse/<a>/<b>/...` and captures
 * every segment after `browse` as a single `path` positional param, joined
 * back together with `/`.
 *
 * Angular's declarative `**` wildcard can only consume an *entire* route —
 * it is not valid mid-path — so `browse/**` (as plan.md writes it) is not
 * something Angular route config can express. A workspace-relative repo/
 * browse path itself contains slashes (`beacon`, `some/nested/proj`) and
 * must be captured as one whole value, hence this custom `UrlMatcher`
 * instead.
 *
 * Bare `/browse` yields `path: ''` (the workspace root) — it is a match,
 * not a miss.
 *
 * Bound to the `BrowsePage` component's `path` input via the router's
 * `withComponentInputBinding()` (already configured in app.config.ts).
 */
export function browseMatcher(segments: UrlSegment[]): UrlMatchResult | null {
  if (segments.length === 0 || segments[0].path !== 'browse') {
    return null;
  }
  return {
    consumed: segments,
    posParams: {
      path: new UrlSegment(
        segments
          .slice(1)
          .map((s) => s.path)
          .join('/'),
        {},
      ),
    },
  };
}
