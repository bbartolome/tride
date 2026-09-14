import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ApiClient } from './api.client';
import { DISCARD_CONFIRM_TEXT, FORCE_PUSH_CONFIRM_TEXT } from './confirm-literals';

/**
 * Asserts the actual HTTP request BODY `ApiClient` sends for the
 * confirmation-gated and paths/all-exclusive mutations — a mocked
 * `ApiClient` in a component spec can't see this, since the confirm
 * literal and the paths/all exclusivity are baked into these methods
 * themselves, not passed in by the caller.
 */
describe('ApiClient — request shapes', () => {
  let api: ApiClient;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    api = TestBed.inject(ApiClient);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('gitStage({all: true}) sends {all: true} and never a paths key', () => {
    api.gitStage('my-repo', { all: true }).subscribe();
    const req = httpMock.expectOne('/api/git/stage');
    expect(req.request.body).toEqual({ repo: 'my-repo', all: true });
    expect(req.request.body).not.toHaveProperty('paths');
    req.flush({ ok: true });
  });

  it('gitStage({paths}) sends exactly the given paths and no `all` key', () => {
    api.gitStage('my-repo', { paths: ['a.txt', 'b.txt'] }).subscribe();
    const req = httpMock.expectOne('/api/git/stage');
    expect(req.request.body).toEqual({ repo: 'my-repo', paths: ['a.txt', 'b.txt'] });
    expect(req.request.body).not.toHaveProperty('all');
    req.flush({ ok: true });
  });

  it('gitUnstage({all: true}) sends {all: true} and never a paths key', () => {
    api.gitUnstage('my-repo', { all: true }).subscribe();
    const req = httpMock.expectOne('/api/git/unstage');
    expect(req.request.body).toEqual({ repo: 'my-repo', all: true });
    expect(req.request.body).not.toHaveProperty('paths');
    req.flush({ ok: true });
  });

  it('gitDiscard sends the exact server-mirrored confirm literal alongside the paths', () => {
    api.gitDiscard('my-repo', ['a.txt']).subscribe();
    const req = httpMock.expectOne('/api/git/discard');
    expect(req.request.body).toEqual({
      repo: 'my-repo',
      paths: ['a.txt'],
      confirm: DISCARD_CONFIRM_TEXT,
    });
    expect(DISCARD_CONFIRM_TEXT).toBe('discard');
    req.flush({ ok: true });
  });

  it('gitPush forwards a force push confirmation exactly as given', () => {
    api
      .gitPush('my-repo', { force: true, confirm: FORCE_PUSH_CONFIRM_TEXT })
      .subscribe();
    const req = httpMock.expectOne('/api/git/push');
    expect(req.request.body).toEqual({
      repo: 'my-repo',
      force: true,
      confirm: FORCE_PUSH_CONFIRM_TEXT,
    });
    expect(FORCE_PUSH_CONFIRM_TEXT).toBe('force push');
    req.flush({ ok: true });
  });

  it('a non-force gitPush carries no confirm field', () => {
    api.gitPush('my-repo').subscribe();
    const req = httpMock.expectOne('/api/git/push');
    expect(req.request.body).toEqual({ repo: 'my-repo' });
    expect(req.request.body).not.toHaveProperty('confirm');
    req.flush({ ok: true });
  });

  it('gitCommit sends exactly the message/amend/signoff flags it was given', () => {
    api
      .gitCommit('my-repo', { message: 'fix bug', amend: true, signoff: false })
      .subscribe();
    const req = httpMock.expectOne('/api/git/commit');
    expect(req.request.body).toEqual({
      repo: 'my-repo',
      message: 'fix bug',
      amend: true,
      signoff: false,
    });
    req.flush({ sha: 'deadbeef' });
  });

  it('every mutation carries the X-Webui-Request CSRF header; GET does not', () => {
    api.gitStage('my-repo', { all: true }).subscribe();
    const mutateReq = httpMock.expectOne('/api/git/stage');
    expect(mutateReq.request.headers.get('X-Webui-Request')).toBe('1');
    mutateReq.flush({ ok: true });

    api.gitStatus('my-repo').subscribe();
    const getReq = httpMock.expectOne((r) => r.url === '/api/git/status');
    expect(getReq.request.headers.has('X-Webui-Request')).toBe(false);
    getReq.flush({
      branch: 'main',
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      entries: [],
    });
  });
});
