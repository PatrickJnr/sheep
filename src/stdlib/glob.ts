/**
 * The glob subset Baa understands.
 *
 * Deliberately small, and written down here rather than left to whatever a
 * regular expression happened to do:
 *
 *   `?`   one character, never a separator
 *   `*`   any run of characters, never crossing a separator
 *   `**`  any run of characters, separators included
 *
 * Nothing else is special. No braces, no character classes, no negation: a
 * pattern that means something in one shell and something else in another is
 * worse than a pattern that is refused, and the small set covers what a build
 * script actually asks for. `[`, `{` and the rest match themselves.
 *
 * Separators are normalised, so `src/**\/*.baa` matches a Windows path with
 * backslashes in it. A pattern is matched against the whole path, not a
 * suffix: `*.baa` does not match `src/main.baa`, and `**\/*.baa` does.
 *
 * The matcher is shared by `pasture.glob` and `pasture.matches`, and mirrored
 * in the native runtime, which is why the rules are written out here rather
 * than being whatever this implementation happens to do.
 */

/** Split a pattern or path on either separator. */
function segments(text: string): string[] {
  return text.split(/[\\/]+/).filter((part, index, all) => part !== "" || index === all.length - 1);
}

/** Match one path segment against one pattern segment, with `?` and `*`. */
function matchSegment(pattern: string, text: string): boolean {
  // Iterative backtracking rather than recursion: a pathological pattern like
  // `a*a*a*a*b` against a long name should not be able to exhaust the stack.
  let patternAt = 0;
  let textAt = 0;
  let starAt = -1;
  let matchAt = 0;
  while (textAt < text.length) {
    const glyph = pattern[patternAt];
    if (glyph === "?" || (glyph !== undefined && glyph !== "*" && glyph === text[textAt])) {
      patternAt++;
      textAt++;
    } else if (glyph === "*") {
      starAt = patternAt;
      matchAt = textAt;
      patternAt++;
    } else if (starAt !== -1) {
      patternAt = starAt + 1;
      matchAt++;
      textAt = matchAt;
    } else {
      return false;
    }
  }
  while (pattern[patternAt] === "*") patternAt++;
  return patternAt === pattern.length;
}

/**
 * True when `path` matches `pattern`.
 *
 * Matching is over segments, so `**` is a segment of its own and means "any
 * number of segments, including none".
 */
export function matchesGlob(path: string, pattern: string): boolean {
  const parts = segments(path);
  const globs = segments(pattern);

  // table[i][j]: pattern segments from i match path segments from j. Filled
  // from the end, which turns `**` from a recursive search that can blow up on
  // a pattern like `**/**/**/x` into a table lookup.
  const table: boolean[][] = Array.from({ length: globs.length + 1 }, () =>
    new Array<boolean>(parts.length + 1).fill(false),
  );
  table[globs.length]![parts.length] = true;

  for (let i = globs.length - 1; i >= 0; i--) {
    const glob = globs[i]!;
    for (let j = parts.length; j >= 0; j--) {
      if (glob === "**") {
        // Match no segments here, or one more and stay.
        table[i]![j] =
          table[i + 1]![j] === true || (j < parts.length && table[i]![j + 1] === true);
      } else {
        table[i]![j] =
          j < parts.length && matchSegment(glob, parts[j]!) && table[i + 1]![j + 1] === true;
      }
    }
  }
  return table[0]![0] === true;
}
