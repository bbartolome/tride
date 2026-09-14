import { DISCARD_CONFIRM_TEXT, FORCE_PUSH_CONFIRM_TEXT } from './confirm-literals';

// These two literals must stay byte-for-byte identical to the server's
// `DISCARD_CONFIRM_LITERAL` / `FORCE_PUSH_CONFIRM_LITERAL`
// (api/src/git/git.controller.ts), which are compared with `===`. This
// spec exists so a drift here is caught by a red test rather than a silent
// 400 CONFIRMATION_REQUIRED at runtime.
describe('confirm literals', () => {
  it('DISCARD_CONFIRM_TEXT is exactly "discard"', () => {
    expect(DISCARD_CONFIRM_TEXT).toBe('discard');
  });

  it('FORCE_PUSH_CONFIRM_TEXT is exactly "force push"', () => {
    expect(FORCE_PUSH_CONFIRM_TEXT).toBe('force push');
  });
});
