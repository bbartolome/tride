import { Injectable } from '@nestjs/common';
import { GitRunner } from './git-runner.service';
import {
  GitStatusEntry,
  parseGitStatusEntries,
  parseGitStatusHeader,
} from './git-status-parser';

export interface GitStatusResult {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
}

/**
 * Thin: runs `git status --porcelain=v2 --branch -z` against an already
 * resolved, realpath'd repo root (callers go through
 * `GitRepoService.resolveRepoRoot` first — this service never resolves
 * `repo` itself, per F62) and feeds the raw output to both halves of the
 * porcelain v2 parser.
 *
 * `--ignored` is deliberately never passed — nothing in this phase needs
 * `!` records, and omitting it keeps the parser to four record types.
 */
@Injectable()
export class GitStatusService {
  constructor(private readonly gitRunner: GitRunner) {}

  async getStatus(repoAbsPath: string): Promise<GitStatusResult> {
    const { stdout } = await this.gitRunner.run(repoAbsPath, [
      'status',
      '--porcelain=v2',
      '--branch',
      '-z',
    ]);

    const header = parseGitStatusHeader(stdout);
    const entries = parseGitStatusEntries(stdout);

    return {
      branch: header.branch,
      detached: header.detached,
      upstream: header.upstream,
      ahead: header.ahead,
      behind: header.behind,
      entries,
    };
  }
}
