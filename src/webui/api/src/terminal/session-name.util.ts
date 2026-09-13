import { createHash } from 'crypto';

export type TerminalMode = 'shell' | 'claude';

/**
 * Derives a stable tmux session name from a terminal's identity.
 *
 * Pure and deterministic: the same (absCwd, mode, slot) triple always
 * yields the same name, so re-opening "the shell in this directory" finds
 * the same tmux session rather than spawning a new one.
 *
 * `absCwd` MUST already be the realpath'd, containment-checked path (see
 * WorkspacePathService / T17) — two different spellings of the same
 * directory (a trailing slash, a symlink, `..` segments) must be
 * normalized to one canonical string *before* this function ever sees it,
 * or they would hash to different session names for what is really the
 * same directory.
 *
 * The result is hex-only (`wui-` + 12 hex chars): tmux treats `.` and `:`
 * specially in target names, so anything base64-ish is unsafe here.
 */
export function computeSessionName(
  absCwd: string,
  mode: TerminalMode,
  slot: number,
): string {
  const digest = createHash('sha1')
    .update(`${absCwd}|${mode}|${slot}`)
    .digest('hex');
  return `wui-${digest.slice(0, 12)}`;
}
