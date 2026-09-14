/**
 * Pure, DOM-free unified-diff parser. Deliberately dependency-free (no
 * `diff2html` — plan.md rules it out explicitly: its side-by-side default
 * is wrong for a phone) so it is fully unit-testable without `TestBed`,
 * and so `diff-viewer` can render single-column, collapsible hunks from
 * plain data.
 *
 * Only parses the *hunk* content of a `git diff`/`GET /git/diff` text
 * body — the `text` half of `DiffResponse` (`api.types.ts`). Everything
 * before the first `@@` line (`diff --git ...`, `index ...`, `---`/`+++`,
 * `rename from/to`, `similarity index`, `new file mode`, ...) is file-level
 * preamble, not hunk content, and is intentionally skipped: the caller
 * already knows the file path and staged flag from the route/request, and
 * a pure rename with no content change legitimately parses to `[]`.
 */

export type DiffLineType = 'context' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

export interface Hunk {
  /** The full `@@ -a,b +c,d @@ optional section heading` line, verbatim. */
  header: string;
  lines: DiffLine[];
}

export function parseUnifiedDiff(diffText: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;

  for (const line of diffText.split('\n')) {
    if (line.startsWith('@@')) {
      current = { header: line, lines: [] };
      hunks.push(current);
      continue;
    }

    if (current === null) {
      // Preamble before the first hunk — not hunk content.
      continue;
    }

    // `\ No newline at end of file` is metadata about the immediately
    // preceding line, not a line of its own — dropped rather than
    // misclassified (it has no `type` that fits the union).
    if (line.startsWith('\\')) {
      continue;
    }

    // The marker is ALWAYS exactly the first character; the rest of the
    // line (from index 1) is the raw content, preserving any leading `+`
    // or `-` that is part of the file's actual content (e.g. an added
    // line whose text itself starts with `+`, which git renders as `++...`
    // — slicing at a fixed index 1 gets this right where a naive
    // "strip all leading +/-" pass would not).
    const marker = line.charAt(0);
    if (marker === '+') {
      current.lines.push({ type: 'add', text: line.slice(1) });
    } else if (marker === '-') {
      current.lines.push({ type: 'del', text: line.slice(1) });
    } else if (marker === ' ') {
      current.lines.push({ type: 'context', text: line.slice(1) });
    }
    // Anything else (e.g. the empty string from a trailing newline's
    // split artifact) is not hunk content — ignored.
  }

  return hunks;
}
