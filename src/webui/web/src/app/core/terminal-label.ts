/**
 * Mirrored character-for-character from `CLAUDE_LABEL_RE` in
 * `terminal/terminal.controller.ts` (API package). A `mode:"claude"`
 * terminal's label becomes a POSITIONAL argument to `claude
 * --remote-control <label>` server-side, with no quoting — validating the
 * shape here is what lets the server skip quoting there. Checked
 * client-side before ever hitting the network purely for UX (the server
 * enforces the exact same pattern and would 400 regardless): a
 * round-trip to discover a leading dash is invalid is a poor experience.
 */
export const CLAUDE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
