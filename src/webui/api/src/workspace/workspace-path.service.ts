import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { existsSync, realpathSync } from 'fs';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import { ERROR_CODES } from '../common/error-codes';
import { WebuiConfigService } from '../config/webui-config.service';

/**
 * Resolves caller-supplied paths against the workspace root and guarantees
 * containment. **This is the security core of the whole application** —
 * every filesystem or git operation resolves the caller's path through
 * `resolve()` before touching disk.
 *
 * `root` is realpath'd once here, in the constructor, rather than per call:
 * a path like `/Users/...` (or the container's home directory) can itself
 * sit behind a symlink, so comparing a realpath'd target against a
 * non-realpath'd root would be comparing apples to oranges on every single
 * call. The root directory must already exist — `realpathSync` throws
 * synchronously (ENOENT) otherwise, which is intentional: failing fast at
 * construction beats silently treating every path as "outside the
 * workspace" for the life of the process.
 */
@Injectable()
export class WorkspacePathService {
  private readonly logger = new Logger(WorkspacePathService.name);
  private readonly root: string;

  constructor(webuiConfig: WebuiConfigService) {
    this.root = realpathSync(webuiConfig.config.workspaceRoot);
  }

  /**
   * Resolves `input` (relative or absolute) to a realpath'd, workspace-
   * contained absolute path.
   *
   * `path.resolve(root, input)` *discards* `root` when `input` is itself
   * absolute (e.g. `/etc`) — that is intentional, and is exactly what makes
   * an absolute-path escape attempt (`?path=/etc`) reachable in the first
   * place. It is the realpath + containment check below that rejects it,
   * not `path.resolve` itself.
   *
   * `opts.mustExist`: when true and the resolved path is absent on disk,
   * throws a generic `NotFoundException`. Callers that need a more specific
   * code (e.g. `REPO_NOT_FOUND`) should catch and rethrow their own.
   */
  resolve(input: string, opts?: { mustExist?: boolean }): string {
    if (input.includes('\0')) {
      // Malformed input, not an escape attempt — the existing
      // VALIDATION_ERROR code applies, not PATH_OUTSIDE_WORKSPACE.
      throw new BadRequestException({
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'path must not contain a NUL byte',
      });
    }

    const abs = resolve(this.root, input);
    const { real, existed } = this.realpathTolerant(abs);

    // Containment must be `startsWith(root + sep)`, never bare
    // `startsWith(root)`: a sibling directory that merely shares the root's
    // name as a prefix (root `/tmp/ws`, target `/tmp/ws-evil`) would
    // otherwise pass. `real === root` is the boundary case for the root
    // itself, which must be accepted.
    if (real !== this.root && !real.startsWith(this.root + sep)) {
      // Diagnostic log so a rejection is traceable rather than mysterious.
      // Real consequence of this check: a legitimate symlink that happens
      // to point out of the workspace is refused too.
      this.logger.warn(
        `Rejected path outside workspace: input=${JSON.stringify(input)} resolved=${real} root=${this.root}`,
      );
      throw new ForbiddenException({
        code: ERROR_CODES.PATH_OUTSIDE_WORKSPACE,
        message: 'Path escapes the workspace root',
      });
    }

    if (opts?.mustExist && !existed) {
      throw new NotFoundException(`Path does not exist: ${input}`);
    }

    return real;
  }

  /** `path.relative(root, abs)` — renders an absolute path back to callers. */
  toRelative(abs: string): string {
    return relative(this.root, abs);
  }

  /**
   * Realpaths `abs` if it exists. If it (or some prefix of it) does not
   * exist yet, this generalizes beyond a missing leaf: it walks `dirname`
   * upward until it finds an existing ancestor, realpaths *that* ancestor,
   * and rejoins the stripped suffix. This handles `a/b/c` where none of the
   * three path components exist, not just a single missing leaf.
   */
  private realpathTolerant(abs: string): { real: string; existed: boolean } {
    if (existsSync(abs)) {
      return { real: realpathSync(abs), existed: true };
    }

    let current = dirname(abs);
    const suffix: string[] = [basename(abs)];
    while (!existsSync(current)) {
      const parent = dirname(current);
      if (parent === current) {
        // Walked all the way to the filesystem root without finding an
        // existing ancestor. Unreachable in practice — the workspace root
        // is guaranteed to exist as of the constructor, and it lies on
        // this same chain — but fail closed defensively rather than throw
        // an unrelated filesystem error.
        throw new ForbiddenException({
          code: ERROR_CODES.PATH_OUTSIDE_WORKSPACE,
          message: 'Path escapes the workspace root',
        });
      }
      suffix.unshift(basename(current));
      current = parent;
    }

    const realAncestor = realpathSync(current);
    return { real: join(realAncestor, ...suffix), existed: false };
  }
}
