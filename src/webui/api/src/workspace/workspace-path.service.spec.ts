import {
  BadRequestException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { WebuiConfigService } from '../config/webui-config.service';
import { WorkspacePathService } from './workspace-path.service';

function createConfig(workspaceRoot: string): WebuiConfigService {
  return {
    config: {
      port: 8088,
      workspaceRoot,
      adminLogins: new Set<string>(),
      stateDir: mkdtempSync(join(tmpdir(), 'wsp-state-')),
      tmuxSocket: 'webui',
    },
  } as unknown as WebuiConfigService;
}

describe('WorkspacePathService', () => {
  let root: string;
  let realRoot: string;
  let service: WorkspacePathService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wsp-root-'));
    realRoot = realpathSync(root);
    service = new WorkspacePathService(createConfig(root));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects a symlink inside the workspace pointing outside it, and logs the resolved target', () => {
    symlinkSync('/', join(root, 'evil'));
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      expect(() => service.resolve('evil')).toThrow(ForbiddenException);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Rejected path outside workspace'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('rejects ../.. traversal that escapes the root', () => {
    expect(() => service.resolve('../..')).toThrow(ForbiddenException);
  });

  it('rejects an absolute input outside the workspace', () => {
    expect(() => service.resolve('/etc')).toThrow(ForbiddenException);
  });

  it('rejects a NUL byte with VALIDATION_ERROR, not PATH_OUTSIDE_WORKSPACE', () => {
    expect(() => service.resolve('foo\0bar')).toThrow(BadRequestException);
    try {
      service.resolve('foo\0bar');
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    }
  });

  it('resolves a non-existent leaf to a synthesized path still inside root', () => {
    const resolved = service.resolve('newfile.txt');
    expect(resolved).toBe(join(realRoot, 'newfile.txt'));
  });

  it('resolves a non-existent multi-level path (a/b/c, none of which exist)', () => {
    const resolved = service.resolve('a/b/c');
    expect(resolved).toBe(join(realRoot, 'a', 'b', 'c'));
  });

  it('accepts the root itself (real === root boundary)', () => {
    expect(service.resolve('.')).toBe(realRoot);
  });

  it('throws NotFoundException when mustExist is true and the path is absent', () => {
    expect(() => service.resolve('missing.txt', { mustExist: true })).toThrow(
      NotFoundException,
    );
  });

  it('toRelative round-trips a resolved path back to its input form', () => {
    const resolved = service.resolve('sub/dir/file.txt');
    expect(service.toRelative(resolved)).toBe(join('sub', 'dir', 'file.txt'));
  });

  it('rejects a sibling directory that merely shares the root as a string prefix', () => {
    const parent = mkdtempSync(join(tmpdir(), 'wsp-sibling-'));
    try {
      const wsRoot = join(parent, 'ws');
      const evilDir = join(parent, 'ws-evil');
      mkdirSync(wsRoot);
      mkdirSync(evilDir);
      const siblingService = new WorkspacePathService(createConfig(wsRoot));
      expect(() => siblingService.resolve(evilDir)).toThrow(ForbiddenException);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
