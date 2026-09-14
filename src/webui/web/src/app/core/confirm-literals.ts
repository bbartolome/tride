/**
 * Typed-confirmation literals mirrored BYTE-FOR-BYTE from the server's
 * `GitController` (api/src/git/git.controller.ts):
 *  - `DISCARD_CONFIRM_LITERAL` = `'discard'`
 *  - `FORCE_PUSH_CONFIRM_LITERAL` = `'force push'`
 *
 * The server compares the request body's `confirm` field with `===` — no
 * trim, no case-folding — so these constants must match it exactly. Both
 * server-side checks throw the SAME `CONFIRMATION_REQUIRED` error code
 * (F89): there is no second code for force-push, it reuses discard's.
 *
 * These are exported as constants, and imported everywhere a confirm
 * dialog is opened for one of these two flows, rather than hardcoded at
 * each call site — a server-side rename would otherwise desync silently
 * and every confirmation would start failing with a 400.
 */
export const DISCARD_CONFIRM_TEXT = 'discard';
export const FORCE_PUSH_CONFIRM_TEXT = 'force push';
