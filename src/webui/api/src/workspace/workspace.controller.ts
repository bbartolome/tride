import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { lstat, open, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { ERROR_CODES } from '../common/error-codes';
import { parseIntParam } from '../git/git-query.util';
import { WorkspacePathService } from './workspace-path.service';

interface TreeEntry {
  name: string;
  type: 'dir' | 'file';
  size?: number;
  /** Cheap `.git` lstat only — never a git subprocess, to keep this
   * endpoint fast for a general filesystem browser. */
  isRepo?: boolean;
}

interface TreeResponse {
  path: string;
  entries: TreeEntry[];
}

interface FileResponse {
  binary: boolean;
  size: number;
  content?: string;
  truncated?: boolean;
}

const DEFAULT_MAX_BYTES = 65536;
const MAX_MAX_BYTES = 1_048_576;
// "first ~8000 bytes" per plan.md; sniffed within whatever was actually
// read (bounded by `max`), never beyond it — `max` is the hard cap on how
// much of the file this endpoint ever touches.
const BINARY_SNIFF_BYTES = 8000;

function validationError(message: string): BadRequestException {
  return new BadRequestException({
    code: ERROR_CODES.VALIDATION_ERROR,
    message,
  });
}

function requirePathParam(rawPath: unknown): string {
  // '' is a legitimate value, not a missing one - it's how the workspace
  // root itself is addressed (see BrowsePage.path and
  // WorkspacePathService.resolve, both of which treat '' as root). Only
  // an absent query param (undefined) counts as missing.
  if (typeof rawPath !== 'string') {
    throw validationError('path query parameter is required');
  }
  return rawPath;
}

@Controller('api')
export class WorkspaceController {
  constructor(private readonly workspacePathService: WorkspacePathService) {}

  @Get('fs/tree')
  async tree(@Query('path') rawPath?: string): Promise<TreeResponse> {
    const input = requirePathParam(rawPath);
    const abs = this.workspacePathService.resolve(input, {
      mustExist: true,
    });

    // Single-level, non-recursive listing. Dotfiles are included here
    // (unlike repo discovery, which skips them) — this is a general
    // filesystem browser, not the repo scanner.
    const dirEntries = await readdir(abs, { withFileTypes: true });
    const entries: TreeEntry[] = [];
    for (const entry of dirEntries) {
      const entryPath = join(abs, entry.name);
      if (entry.isDirectory()) {
        entries.push({
          name: entry.name,
          type: 'dir',
          isRepo: await this.hasDotGit(entryPath),
        });
      } else if (entry.isFile()) {
        const fileStat = await stat(entryPath);
        entries.push({ name: entry.name, type: 'file', size: fileStat.size });
      }
      // Symlinks and other special files are omitted for now.
    }

    return { path: this.workspacePathService.toRelative(abs), entries };
  }

  @Get('fs/file')
  async file(
    @Query('path') rawPath?: string,
    @Query('max') rawMax?: string,
  ): Promise<FileResponse> {
    const input = requirePathParam(rawPath);
    const abs = this.workspacePathService.resolve(input, {
      mustExist: true,
    });

    const fileStat = await stat(abs);
    if (!fileStat.isFile()) {
      throw validationError('path does not refer to a regular file');
    }

    const max = parseIntParam(rawMax, DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
    const readLength = Math.min(max, fileStat.size);
    const buffer = Buffer.alloc(readLength);

    // Bounded read via fs.open + read — never loads the whole file, no
    // matter how large it is on disk.
    const handle = await open(abs, 'r');
    try {
      const { bytesRead } = await handle.read(buffer, 0, readLength, 0);
      const slice = buffer.subarray(0, bytesRead);

      const sniffLength = Math.min(slice.length, BINARY_SNIFF_BYTES);
      const isBinary = slice.subarray(0, sniffLength).includes(0);
      if (isBinary) {
        return { binary: true, size: fileStat.size };
      }

      return {
        binary: false,
        content: slice.toString('utf8'),
        size: fileStat.size,
        truncated: bytesRead < fileStat.size,
      };
    } finally {
      await handle.close();
    }
  }

  private async hasDotGit(dir: string): Promise<boolean> {
    try {
      await lstat(join(dir, '.git'));
      return true;
    } catch {
      return false;
    }
  }
}
