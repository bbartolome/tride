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
 * `[1, max]` otherwise. Never throws — an out-of-range or garbage value is
 * silently normalized rather than rejected, since these are display/paging
 * knobs, not security-relevant input.
 */
export function parseIntParam(
  value: unknown,
  defaultValue: number,
  max: number,
): number {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  return Math.min(Math.max(parsed, 1), max);
}
