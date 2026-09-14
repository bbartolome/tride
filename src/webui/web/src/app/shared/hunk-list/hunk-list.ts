import { ChangeDetectionStrategy, Component, effect, input, signal } from '@angular/core';
import { Hunk } from '../../core/diff-parser';

/**
 * The single collapsible unified-diff renderer for the whole app (F167,
 * F168) — extracted out of `diff-viewer` (T22) so T23's log/show commit
 * detail can render `GitShowResult.diffText` through the exact same
 * markup/behavior instead of a second, drifting copy. Both call sites
 * parse with the shared `parseUnifiedDiff` (`core/diff-parser.ts`) and
 * hand the resulting `Hunk[]` straight to this component — neither owns
 * its own hunk-rendering logic anymore.
 *
 * Collapse state is internal and keyed by hunk index, expanded by
 * default, and reset whenever the `hunks` input changes identity (a new
 * diff/file/commit) rather than persisting stale collapse state across
 * navigations.
 */
@Component({
  selector: 'app-hunk-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [],
  templateUrl: './hunk-list.html',
  styleUrl: './hunk-list.scss',
})
export class HunkList {
  readonly hunks = input.required<Hunk[]>();

  /** Indices of collapsed hunks; absent = expanded. */
  protected readonly collapsedHunks = signal<ReadonlySet<number>>(new Set());

  constructor() {
    effect(() => {
      // Track `hunks()` so a new diff resets every hunk back to expanded,
      // rather than inheriting collapse state from whatever was shown
      // before.
      this.hunks();
      this.collapsedHunks.set(new Set());
    });
  }

  protected isCollapsed(index: number): boolean {
    return this.collapsedHunks().has(index);
  }

  protected toggleHunk(index: number): void {
    const next = new Set(this.collapsedHunks());
    if (next.has(index)) {
      next.delete(index);
    } else {
      next.add(index);
    }
    this.collapsedHunks.set(next);
  }
}
