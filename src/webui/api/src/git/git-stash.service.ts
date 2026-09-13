import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ERROR_CODES } from '../common/error-codes';
import { GitRunner } from './git-runner.service';

export interface StashEntry {
  ref: string;
  sha: string;
  date: string;
  message: string;
}

export interface StashPushOptions {
  message?: string;
  includeUntracked?: boolean;
}

// Not NUL-terminated (no `-z`) — stash reflog subjects can never contain a
// raw newline (git's own `%s` "subject" derivation already flattens any
// embedded newline in a `-m` message into a space before this ever reaches
// us, confirmed against real git 2.43), so plain `\n`-per-line splitting is
// safe here, unlike the entry parsers elsewhere in this module that need
// `-z`.
const STASH_LIST_FORMAT = '%gd%x1f%H%x1f%cI%x1f%s';

// Whitelist, not `checkRefFormat`: `stash@{N}` is reflog shorthand, not an
// ordinary ref name — `check-ref-format --branch` would reject its
// `{`/`}`/`@` shape outright, so this is a positive match against the exact
// shape stash refs take rather than a rejection-based guard.
const STASH_REF_RE = /^stash@\{\d+\}$/;

// Confirmed against real git 2.43, all three land on stderr in this
// version, but per F87 both streams are checked regardless: a completely
// empty stash list says "No stash entries found."; an out-of-range index
// against a non-empty list says "log for 'stash' only has N entries"; and a
// stale/already-dropped ref says "is not a valid reference".
const STASH_NOT_FOUND_RE =
  /no stash entries found|only has \d+ entries?|is not a valid reference/i;

function combinedOutput(err: unknown): string {
  const shape = err as { stdout?: unknown; stderr?: unknown } | null;
  return [shape?.stdout, shape?.stderr]
    .filter((s): s is string => typeof s === 'string')
    .join('\n');
}

/**
 * Thin: every method here runs against an already resolved, realpath'd repo
 * root (callers go through `GitRepoService.resolveRepoRoot` first, per F62 —
 * this service never resolves `repo` itself). All git invocation goes
 * through `GitRunner.run` — the single chokepoint (F61).
 */
@Injectable()
export class GitStashService {
  constructor(private readonly gitRunner: GitRunner) {}

  async list(repoAbsPath: string): Promise<StashEntry[]> {
    const { stdout } = await this.gitRunner.run(repoAbsPath, [
      'stash',
      'list',
      `--format=${STASH_LIST_FORMAT}`,
    ]);
    return stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        // Only the first THREE `\x1f` delimiters are structural (ref, sha,
        // date). Everything after the third is the message, taken
        // positionally and never split further: rejoining the remaining
        // parts with the same delimiter reconstructs a message that itself
        // contains a literal `\x1f` byte exactly, instead of misreading it
        // as an extra field boundary.
        const parts = line.split('\x1f');
        const [ref = '', sha = '', date = ''] = parts;
        const message = parts.slice(3).join('\x1f');
        return { ref, sha, date, message };
      });
  }

  async push(repoAbsPath: string, opts: StashPushOptions): Promise<void> {
    await this.gitRunner.run(repoAbsPath, [
      'stash',
      'push',
      ...(opts.includeUntracked ? ['-u'] : []),
      // `message` occupies `-m`'s option-value slot, exactly like commit's
      // `-m` (F88) — deliberately NOT `assertNotOptionLike`, which would
      // wrongly reject a legitimate message starting with "-". Only
      // positional tokens (pathspecs, refs, revs) need that guard.
      ...(opts.message ? ['-m', opts.message] : []),
    ]);
  }

  async apply(repoAbsPath: string, ref: string): Promise<void> {
    await this.runStashRefCommand(repoAbsPath, 'apply', ref);
  }

  async pop(repoAbsPath: string, ref: string): Promise<void> {
    await this.runStashRefCommand(repoAbsPath, 'pop', ref);
  }

  async drop(repoAbsPath: string, ref: string): Promise<void> {
    await this.runStashRefCommand(repoAbsPath, 'drop', ref);
  }

  private async runStashRefCommand(
    repoAbsPath: string,
    op: 'apply' | 'pop' | 'drop',
    ref: string,
  ): Promise<void> {
    // Validated, and rejected, BEFORE any git call — see `validateStashRef`.
    this.validateStashRef(ref);
    try {
      await this.gitRunner.run(repoAbsPath, ['stash', op, ref]);
    } catch (err) {
      if (STASH_NOT_FOUND_RE.test(combinedOutput(err))) {
        throw new NotFoundException({
          code: ERROR_CODES.STASH_NOT_FOUND,
          message: `Stash not found: ${ref}`,
        });
      }
      // A real conflict during apply/pop (exit 1, working tree left with
      // conflict markers) gets NO special code — it falls through to the
      // controller's `toHttpException` -> 422 GIT_COMMAND_FAILED, the same
      // treatment as any other conflict. The answer is "open a terminal",
      // not a bespoke code for this one case.
      throw err;
    }
  }

  /**
   * Whitelist match against exactly `stash@{N}` — NOT `checkRefFormat`.
   * Runs, and rejects with 400 `VALIDATION_ERROR`, BEFORE any git call for
   * apply/pop/drop.
   */
  private validateStashRef(ref: string): void {
    if (!STASH_REF_RE.test(ref)) {
      throw new BadRequestException({
        code: ERROR_CODES.VALIDATION_ERROR,
        message: `Invalid stash ref: ${JSON.stringify(ref)}`,
      });
    }
  }
}
