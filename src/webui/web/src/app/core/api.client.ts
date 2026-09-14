import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  BranchListResult,
  CommitResult,
  DiffResponse,
  DiffSummaryEntry,
  FileResponse,
  GitLogEntry,
  GitShowResult,
  GitStatusResult,
  MeResponse,
  MintedTicket,
  OkResponse,
  RemoteInfo,
  RepoSummary,
  StashEntry,
  TerminalMode,
  TerminalSummary,
  TreeResponse,
  UserListEntry,
  UserRole,
} from './api.types';

type QueryValue = string | number | boolean | undefined;
type QueryParams = Record<string, QueryValue>;

function toHttpParams(params?: QueryParams): HttpParams | undefined {
  if (!params) {
    return undefined;
  }
  let httpParams = new HttpParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      httpParams = httpParams.set(key, String(value));
    }
  }
  return httpParams;
}

/**
 * Single typed client for every `/api/*` endpoint. Paths are all relative
 * (`/api/...`), so the same code works behind the Angular dev-server proxy
 * (`proxy.conf.js`) and when served by the Nest app itself in the
 * container.
 *
 * Two private helpers carry the CSRF contract (see
 * `same-origin.guard.ts` in the API package, F22):
 *  - `get<T>` — GET is a "safe method" and is exempt from the same-origin
 *    check, so it sends no extra header.
 *  - `mutate<T>` — every non-GET request MUST carry `X-Webui-Request: 1`,
 *    unconditionally, or the server's SameOriginGuard rejects it with a
 *    403. This is the client half of that defence.
 */
@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);

  // ---- me / users (auth/users.controller.ts) ----

  me(): Observable<MeResponse> {
    return this.get<MeResponse>('/api/me');
  }

  listUsers(): Observable<UserListEntry[]> {
    return this.get<UserListEntry[]>('/api/users');
  }

  addUser(login: string, role: UserRole): Observable<UserListEntry> {
    return this.mutate<UserListEntry>('post', '/api/users', { login, role });
  }

  updateUserRole(login: string, role: UserRole): Observable<UserListEntry> {
    return this.mutate<UserListEntry>(
      'patch',
      `/api/users/${encodeURIComponent(login)}`,
      { role },
    );
  }

  removeUser(login: string): Observable<OkResponse> {
    return this.mutate<OkResponse>(
      'delete',
      `/api/users/${encodeURIComponent(login)}`,
    );
  }

  // ---- workspace (workspace/workspace.controller.ts) ----

  fsTree(path: string): Observable<TreeResponse> {
    return this.get<TreeResponse>('/api/fs/tree', { path });
  }

  fsFile(path: string, max?: number): Observable<FileResponse> {
    return this.get<FileResponse>('/api/fs/file', { path, max });
  }

  // ---- repos / git (git/git.controller.ts) ----

  listRepos(refresh?: boolean): Observable<RepoSummary[]> {
    return this.get<RepoSummary[]>('/api/repos', { refresh });
  }

  gitStatus(repo: string): Observable<GitStatusResult> {
    return this.get<GitStatusResult>('/api/git/status', { repo });
  }

  gitDiff(
    repo: string,
    opts?: { path?: string; staged?: boolean; context?: number },
  ): Observable<DiffResponse> {
    return this.get<DiffResponse>('/api/git/diff', { repo, ...opts });
  }

  gitDiffSummary(
    repo: string,
    staged?: boolean,
  ): Observable<DiffSummaryEntry[]> {
    return this.get<DiffSummaryEntry[]>('/api/git/diff/summary', {
      repo,
      staged,
    });
  }

  gitShow(repo: string, rev: string, path?: string): Observable<GitShowResult> {
    return this.get<GitShowResult>('/api/git/show', { repo, rev, path });
  }

  gitLog(
    repo: string,
    opts?: { limit?: number; skip?: number; path?: string },
  ): Observable<GitLogEntry[]> {
    return this.get<GitLogEntry[]>('/api/git/log', { repo, ...opts });
  }

  gitStage(repo: string, opts: { paths: string[] } | { all: true }): Observable<OkResponse> {
    return this.mutate<OkResponse>('post', '/api/git/stage', { repo, ...opts });
  }

  gitUnstage(
    repo: string,
    opts: { paths: string[] } | { all: true },
  ): Observable<OkResponse> {
    return this.mutate<OkResponse>('post', '/api/git/unstage', {
      repo,
      ...opts,
    });
  }

  gitDiscard(repo: string, paths: string[]): Observable<OkResponse> {
    return this.mutate<OkResponse>('post', '/api/git/discard', {
      repo,
      paths,
      confirm: 'discard',
    });
  }

  gitCommit(
    repo: string,
    opts: { message: string; amend?: boolean; signoff?: boolean },
  ): Observable<CommitResult> {
    return this.mutate<CommitResult>('post', '/api/git/commit', {
      repo,
      ...opts,
    });
  }

  gitBranches(repo: string): Observable<BranchListResult> {
    return this.get<BranchListResult>('/api/git/branches', { repo });
  }

  gitCheckout(
    repo: string,
    opts: { branch: string; create?: boolean; startPoint?: string },
  ): Observable<OkResponse> {
    return this.mutate<OkResponse>('post', '/api/git/checkout', {
      repo,
      ...opts,
    });
  }

  gitCreateBranch(
    repo: string,
    opts: { name: string; startPoint?: string },
  ): Observable<OkResponse> {
    return this.mutate<OkResponse>('post', '/api/git/branch', {
      repo,
      ...opts,
    });
  }

  gitDeleteBranch(
    repo: string,
    opts: { name: string; force?: boolean },
  ): Observable<OkResponse> {
    return this.mutate<OkResponse>('delete', '/api/git/branch', {
      repo,
      ...opts,
    });
  }

  gitRemotes(repo: string): Observable<RemoteInfo[]> {
    return this.get<RemoteInfo[]>('/api/git/remotes', { repo });
  }

  gitFetch(
    repo: string,
    opts?: { remote?: string; prune?: boolean },
  ): Observable<OkResponse> {
    return this.mutate<OkResponse>('post', '/api/git/fetch', {
      repo,
      ...opts,
    });
  }

  gitPull(
    repo: string,
    opts?: { remote?: string; branch?: string },
  ): Observable<OkResponse> {
    return this.mutate<OkResponse>('post', '/api/git/pull', {
      repo,
      ...opts,
    });
  }

  gitPush(
    repo: string,
    opts?: {
      remote?: string;
      branch?: string;
      setUpstream?: boolean;
      force?: boolean;
      confirm?: string;
    },
  ): Observable<OkResponse> {
    return this.mutate<OkResponse>('post', '/api/git/push', {
      repo,
      ...opts,
    });
  }

  gitStashList(repo: string): Observable<StashEntry[]> {
    return this.get<StashEntry[]>('/api/git/stash', { repo });
  }

  gitStashPush(
    repo: string,
    opts?: { message?: string; includeUntracked?: boolean },
  ): Observable<OkResponse> {
    return this.mutate<OkResponse>('post', '/api/git/stash', {
      repo,
      ...opts,
    });
  }

  gitStashApply(repo: string, ref: string): Observable<OkResponse> {
    return this.mutate<OkResponse>('post', '/api/git/stash/apply', {
      repo,
      ref,
    });
  }

  gitStashPop(repo: string, ref: string): Observable<OkResponse> {
    return this.mutate<OkResponse>('post', '/api/git/stash/pop', {
      repo,
      ref,
    });
  }

  gitStashDrop(repo: string, ref: string): Observable<OkResponse> {
    return this.mutate<OkResponse>('post', '/api/git/stash/drop', {
      repo,
      ref,
    });
  }

  // ---- terminals (terminal/terminal.controller.ts) ----

  listTerminals(): Observable<TerminalSummary[]> {
    return this.get<TerminalSummary[]>('/api/terminals');
  }

  createTerminal(
    cwd: string,
    opts?: { mode?: TerminalMode; label?: string },
  ): Observable<TerminalSummary> {
    return this.mutate<TerminalSummary>('post', '/api/terminals', {
      cwd,
      ...opts,
    });
  }

  removeTerminal(id: string): Observable<void> {
    return this.mutate<void>(
      'delete',
      `/api/terminals/${encodeURIComponent(id)}`,
    );
  }

  mintTerminalTicket(id: string): Observable<MintedTicket> {
    return this.mutate<MintedTicket>(
      'post',
      `/api/terminals/${encodeURIComponent(id)}/ticket`,
    );
  }

  // ---- helpers ----

  private get<T>(path: string, params?: QueryParams): Observable<T> {
    // GET is a "safe method" under the server's same-origin CSRF check —
    // no X-Webui-Request header required or sent.
    return this.http.get<T>(path, { params: toHttpParams(params) });
  }

  private mutate<T>(
    method: 'post' | 'patch' | 'delete',
    path: string,
    body?: unknown,
  ): Observable<T> {
    // Every non-GET request must carry this header, unconditionally — the
    // server's SameOriginGuard rejects any mutation without it (F22).
    const headers = { 'X-Webui-Request': '1' };
    switch (method) {
      case 'post':
        return this.http.post<T>(path, body ?? {}, { headers });
      case 'patch':
        return this.http.patch<T>(path, body ?? {}, { headers });
      case 'delete':
        return this.http.delete<T>(path, { headers, body });
    }
  }
}
