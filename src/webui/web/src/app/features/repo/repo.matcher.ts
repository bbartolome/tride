import { UrlMatchResult, UrlSegment } from '@angular/router';

/**
 * Matches `/repo/<a>`, `/repo/<a>/<b>/...` and captures every segment after
 * `repo` as a single `repo` positional param, joined back together with
 * `/` — the same `UrlMatcher` treatment as `browseMatcher` (F159), for the
 * same reason: `/repo/**` is not expressible with Angular's declarative
 * route syntax (`**` may only consume an entire route, never mid-path),
 * and a workspace-relative repo path itself contains slashes and must be
 * captured as one whole value.
 *
 * Unlike `browseMatcher`, a bare `/repo` is NOT a match — a repo path can
 * never be empty (`RepoSummary.path` is always at least one segment), so
 * at least two segments (`repo` + one path segment) are required.
 *
 * Bound to `RepoShell`'s `repo` input via `withComponentInputBinding()`.
 */
export function repoMatcher(segments: UrlSegment[]): UrlMatchResult | null {
  if (segments.length < 2 || segments[0].path !== 'repo') {
    return null;
  }
  return {
    consumed: segments,
    posParams: {
      repo: new UrlSegment(
        segments
          .slice(1)
          .map((s) => s.path)
          .join('/'),
        {},
      ),
    },
  };
}

/**
 * Matches `/repo/<a>/diff`, `/repo/<a>/<b>/diff`, ... — everything between
 * `repo` and a trailing `diff` segment is captured as the `repo` posParam,
 * the same way `repoMatcher` captures it. `file` and `staged` are query
 * params on this route (they mirror `GET /git/diff?path=&staged=`
 * directly), not path segments, so they are not this matcher's concern.
 *
 * MUST be registered before `repoMatcher` in the route table — Angular
 * tries matchers top to bottom, and this is the more specific of the two.
 * A repo genuinely named (or nested under a directory named) `diff` is
 * the reason this ordering matters: `/repo/foo/diff` must resolve here
 * (`repo: 'foo'`), while `/repo/foo/diff/bar` — where `diff` is not the
 * *last* segment — must fall through to `repoMatcher` and resolve as
 * `repo: 'foo/diff/bar'`, not be mistaken for a diff route.
 */
export function repoDiffMatcher(segments: UrlSegment[]): UrlMatchResult | null {
  if (segments.length < 3 || segments[0].path !== 'repo') {
    return null;
  }
  if (segments[segments.length - 1].path !== 'diff') {
    return null;
  }
  return {
    consumed: segments,
    posParams: {
      repo: new UrlSegment(
        segments
          .slice(1, -1)
          .map((s) => s.path)
          .join('/'),
        {},
      ),
    },
  };
}
