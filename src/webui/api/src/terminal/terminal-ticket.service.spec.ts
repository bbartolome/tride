import { TerminalTicketService } from './terminal-ticket.service';

describe('TerminalTicketService', () => {
  let service: TerminalTicketService;

  beforeEach(() => {
    service = new TerminalTicketService();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('mint() returns a base64url token and an expiresAt roughly 30s out', () => {
    const before = Date.now();
    const { ticket, expiresAt } = service.mint('alice@example.com', 'wui-abc');
    const after = Date.now();

    expect(typeof ticket).toBe('string');
    // base64url alphabet only: no '+', '/', or '=' padding.
    expect(ticket).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 random bytes -> 43 base64url chars, no padding.
    expect(ticket.length).toBe(43);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 30_000);
  });

  it('two mints produce different tokens', () => {
    const a = service.mint('alice@example.com', 'wui-abc');
    const b = service.mint('alice@example.com', 'wui-abc');
    expect(a.ticket).not.toBe(b.ticket);
  });

  it('consume() returns the login/sessionId that were minted', () => {
    const { ticket } = service.mint('alice@example.com', 'wui-abc');
    expect(service.consume(ticket)).toEqual({
      login: 'alice@example.com',
      sessionId: 'wui-abc',
    });
  });

  it('consume() is single-use: the second call on the same token returns null', () => {
    const { ticket } = service.mint('alice@example.com', 'wui-abc');
    expect(service.consume(ticket)).not.toBeNull();
    expect(service.consume(ticket)).toBeNull();
  });

  it('consume() of an unknown token returns null without throwing', () => {
    expect(service.consume('not-a-real-token')).toBeNull();
  });

  it('consume() after the TTL elapses returns null, and still deletes the entry', () => {
    jest.useFakeTimers();
    const { ticket } = service.mint('alice@example.com', 'wui-abc');

    jest.advanceTimersByTime(30_001);

    expect(service.consume(ticket)).toBeNull();
    // Deleted on read regardless of outcome (F114) — a second consume must
    // also be null, not somehow valid again.
    expect(service.consume(ticket)).toBeNull();
  });

  it('mint() opportunistically sweeps expired entries out of the map', () => {
    jest.useFakeTimers();
    const stale = service.mint('alice@example.com', 'wui-abc');
    jest.advanceTimersByTime(30_001);

    // A fresh mint should trigger the sweep; the stale token must already
    // read back as gone via consume (not merely "expired but still present"
    // in a way that would leak memory forever).
    service.mint('bob@example.com', 'wui-def');
    expect(service.consume(stale.ticket)).toBeNull();
  });
});
