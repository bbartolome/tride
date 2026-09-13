import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { execFileSync } from 'child_process';
import { mkdirSync } from 'fs';
import { join } from 'path';
import type { WebuiConfigService } from '../config/webui-config.service';
import { WorkspacePathService } from '../workspace/workspace-path.service';
import {
  createMultiRepoWorkspace,
  removeMultiRepoWorkspace,
  type MultiRepoWorkspace,
} from './__fixtures__/git-repo-fixture';
import { GitRepoService } from './git-repo.service';
import { GitRunner } from './git-runner.service';

function createConfig(workspaceRoot: string): WebuiConfigService {
  return {
    config: {
      port: 8088,
      workspaceRoot,
      adminLogins: new Set<string>(),
      stateDir: '/tmp/unused-git-repo-service-spec',
      tmuxSocket: 'webui',
    },
  } as unknown as WebuiConfigService;
}

describe('GitRepoService', () => {
  let workspace: MultiRepoWorkspace;
  let workspacePathService: WorkspacePathService;
  let service: GitRepoService;

  beforeEach(() => {
    workspace = createMultiRepoWorkspace();
    const config = createConfig(workspace.root);
    workspacePathService = new WorkspacePathService(config);
    service = new GitRepoService(config, workspacePathService, new GitRunner());
  });

  afterEach(() => {
    removeMultiRepoWorkspace(workspace.root);
  });

  describe('listRepos', () => {
    it('discovers the plain repo and both sides of the worktree pair, classifying isWorktree correctly', async () => {
      const repos = await service.listRepos();
      const byName = new Map(repos.map((r) => [r.name, r]));

      expect(byName.get('plain-repo')).toMatchObject({ isWorktree: false });
      expect(byName.get('wt-primary')).toMatchObject({ isWorktree: false });
      expect(byName.get('wt-sibling')).toMatchObject({ isWorktree: true });
    });

    it('returns path values relative to the workspace root', async () => {
      const repos = await service.listRepos();
      const plain = repos.find((r) => r.name === 'plain-repo');
      expect(plain?.path).toBe('plain-repo');
    });

    it('never includes the node_modules candidate, the dotdir-nested repo, or the depth-3 repo', async () => {
      const repos = await service.listRepos();
      const names = repos.map((r) => r.name);
      const paths = repos.map((r) => r.path);

      expect(names).not.toContain('fake-pkg');
      expect(names).not.toContain('some-repo');
      expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
      expect(paths.some((p) => p.includes('.hidden'))).toBe(false);
      expect(paths.some((p) => p.includes(join('a', 'b', 'repo')))).toBe(false);
      // 'a' and 'b' are plain non-repo directories along the way to the
      // depth-3 repo — a plain non-repo dir must never show up either.
      expect(names).not.toContain('plain-dir');
    });

    it('skips a broken worktree (stale gitdir pointer) with a warning instead of throwing', async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        const repos = await service.listRepos();
        expect(repos.some((r) => r.name === 'wt-broken')).toBe(false);
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('caches results across calls when nothing on disk changes', async () => {
      const runSpy = jest.spyOn(GitRunner.prototype, 'run');
      try {
        await service.listRepos();
        const callsAfterFirst = runSpy.mock.calls.length;
        await service.listRepos();
        expect(runSpy.mock.calls.length).toBe(callsAfterFirst);
      } finally {
        runSpy.mockRestore();
      }
    });

    it('?refresh forces a full rescan even when the cache is still fresh', async () => {
      const runSpy = jest.spyOn(GitRunner.prototype, 'run');
      try {
        await service.listRepos();
        const callsAfterFirst = runSpy.mock.calls.length;
        await service.listRepos({ refresh: true });
        expect(runSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
      } finally {
        runSpy.mockRestore();
      }
    });

    it('picks up a newly created top-level repo without ?refresh, since adding it bumps the workspace root mtime', async () => {
      const before = await service.listRepos();
      expect(before.some((r) => r.name === 'new-toplevel-repo')).toBe(false);

      const newRepo = join(workspace.root, 'new-toplevel-repo');
      mkdirSync(newRepo);
      execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
        cwd: newRepo,
      });

      const after = await service.listRepos();
      expect(after.some((r) => r.name === 'new-toplevel-repo')).toBe(true);
    });
  });

  describe('resolveRepoRoot', () => {
    it('resolves a valid repo-relative path to its absolute realpath', async () => {
      const resolved = await service.resolveRepoRoot('plain-repo');
      expect(resolved).toBe(workspacePathService.resolve('plain-repo'));
    });

    it('resolves the worktree sibling (a `.git` FILE, not a directory)', async () => {
      const resolved = await service.resolveRepoRoot('wt-sibling');
      expect(resolved).toBe(workspacePathService.resolve('wt-sibling'));
    });

    it('rejects a directory with no .git as REPO_NOT_FOUND', async () => {
      await expect(service.resolveRepoRoot('plain-dir')).rejects.toMatchObject({
        response: { code: 'REPO_NOT_FOUND' },
      });
    });

    it('rejects a nonexistent path as REPO_NOT_FOUND, not the generic NotFoundException from WorkspacePathService', async () => {
      const err = await service
        .resolveRepoRoot('nope')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      expect((err as NotFoundException).getResponse()).toMatchObject({
        code: 'REPO_NOT_FOUND',
      });
    });

    it('propagates PATH_OUTSIDE_WORKSPACE unchanged for an escape attempt', async () => {
      await expect(service.resolveRepoRoot('../../etc')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(service.resolveRepoRoot('../../etc')).rejects.toMatchObject({
        response: { code: 'PATH_OUTSIDE_WORKSPACE' },
      });
    });
  });
});
