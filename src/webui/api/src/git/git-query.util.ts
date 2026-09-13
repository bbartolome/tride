/**
 * Small, dependency-free query-string parsing helpers shared by every git/fs
 * controller (T8 introduces them for `/api/repos?refresh=` and
 * `/api/fs/file?max=`; later tasks reuse both for `limit`/`skip`/`context`
 * etc.). Deliberately not decorator-based validation (F46) — same inline
 * parse-and-throw convention as `users.controller.ts`.
 */

/**
 * True for the conventional "flag is set" query values (`?refresh=1` or
 * `?refresh=true`); false for anything else, including absent/undefined,
 * empty string, `"0"`, or `"false"`.
 */
export function parseBoolFlag(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  return value === '1' || value.toLowerCase() === 'true';
}

/**
 * Parses a query-string integer, falling back to `defaultValue` when
 * `value` is missing/empty/not a valid integer, and clamping the result to
 * `[min, max]` otherwise. Never throws — an out-of-range or garbage value
 * is silently normalized rather than rejected, since these are
 * display/paging knobs, not security-relevant input.
 *
 * `min` defaults to `1` (every original caller — `context`, `limit`, the
 * workspace file-read `max` byte count — wants a strictly positive
 * minimum). Pass `min: 0` for a parameter like `skip` where an explicit
 * `?skip=0` must mean "no offset", not get floored up to `1` — discovered
 * by an e2e test whose `git log` pagination silently dropped the newest
 * commit until this was added (T10).
 */
export function parseIntParam(
  value: unknown,
  defaultValue: number,
  max: number,
  min = 1,
): number {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  return Math.min(Math.max(parsed, min), max);
}
