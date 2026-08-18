/**
 * Unified diffs, for `baa fmt --diff`.
 *
 * `--check` answers yes or no, which is the right answer for CI and a useless
 * one in a review: it says a file would change without saying how. This turns
 * the same comparison into the format every reviewer already reads.
 *
 * The algorithm is a longest-common-subsequence table over *lines*, after the
 * common prefix and suffix have been trimmed away. That trimming is what makes
 * the quadratic middle cheap in practice: reformatting changes a handful of
 * lines in a file whose other thousand are identical, so the table is built
 * over the handful.
 *
 * ponytail: O(n*m) in the differing region. A file whose every line changed
 * would build a full table; switch to Myers if that ever shows up in a
 * profile, which for source files it has not.
 */

export type DiffOptions = {
  /** Lines of unchanged context kept around each change. */
  readonly context?: number;
  /** Path written on the `---` line. */
  readonly fromLabel?: string;
  /** Path written on the `+++` line. */
  readonly toLabel?: string;
};

type Op = { readonly kind: " " | "-" | "+"; readonly text: string };

/**
 * Split into lines for diffing.
 *
 * A trailing newline does not become an extra empty line: a file ending in
 * `}\n` has the same last line as one ending in `}`, and only the marker
 * differs. Losing the distinction would report "no difference" between two
 * files that differ, so it is carried separately by `noNewlineAt`.
 */
function lines(text: string): string[] {
  if (text === "") return [];
  const split = text.split("\n");
  if (split[split.length - 1] === "") split.pop();
  return split;
}

function diffOps(before: readonly string[], after: readonly string[]): Op[] {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }

  const a = before.slice(head, before.length - tail);
  const b = after.slice(head, after.length - tail);

  // Classic LCS table. `table[i][j]` is the length of the longest common
  // subsequence of `a[i..]` and `b[j..]`, filled from the end so that the
  // walk below can move forward and produce operations in file order.
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const ops: Op[] = [];
  for (let index = 0; index < head; index++) ops.push({ kind: " ", text: before[index]! });

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ kind: "-", text: a[i]! });
      i++;
    } else {
      ops.push({ kind: "+", text: b[j]! });
      j++;
    }
  }
  for (; i < a.length; i++) ops.push({ kind: "-", text: a[i]! });
  for (; j < b.length; j++) ops.push({ kind: "+", text: b[j]! });

  for (let index = before.length - tail; index < before.length; index++) {
    ops.push({ kind: " ", text: before[index]! });
  }
  return ops;
}

/**
 * A unified diff of two texts, or the empty string when they are identical.
 *
 * Identical input produces nothing at all rather than an empty header, so a
 * caller can treat any output as "this file would change".
 */
export function unifiedDiff(before: string, after: string, options: DiffOptions = {}): string {
  if (before === after) return "";

  const contextLines = options.context ?? 3;
  const fromLabel = options.fromLabel ?? "a";
  const toLabel = options.toLabel ?? "b";
  const beforeLines = lines(before);
  const afterLines = lines(after);
  const ops = diffOps(beforeLines, afterLines);

  const beforeEndsWithNewline = before === "" || before.endsWith("\n");
  const afterEndsWithNewline = after === "" || after.endsWith("\n");

  // A file that only gained or lost its final newline has identical lines, so
  // the diff is all context and would print nothing. The last line *did*
  // change — by a character nobody can see — so it is rewritten as a removal
  // and an addition, which is what git shows and what makes the `\ No newline`
  // marker land on the right side.
  if (beforeEndsWithNewline !== afterEndsWithNewline) {
    const last = ops.length - 1;
    if (last >= 0 && ops[last]!.kind === " ") {
      const text = ops[last]!.text;
      ops.splice(last, 1, { kind: "-", text }, { kind: "+", text });
    }
  }

  const changed = ops
    .map((op, index) => (op.kind === " " ? -1 : index))
    .filter((index) => index >= 0);
  if (changed.length === 0) return "";

  const interesting = changed;

  // Group changes whose context windows touch into one hunk.
  const groups: Array<{ start: number; end: number }> = [];
  for (const index of interesting) {
    const start = Math.max(0, index - contextLines);
    const end = Math.min(ops.length - 1, index + contextLines);
    const last = groups[groups.length - 1];
    if (last !== undefined && start <= last.end + 1) last.end = Math.max(last.end, end);
    else groups.push({ start, end });
  }

  // Where each side's final line sits, so `\ No newline at end of file` is
  // written against the line that actually lacks one.
  let lastBefore = -1;
  let lastAfter = -1;
  ops.forEach((op, index) => {
    if (op.kind !== "+") lastBefore = index;
    if (op.kind !== "-") lastAfter = index;
  });

  const out = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  for (const group of groups) {
    let fromStart = 1;
    let toStart = 1;
    for (let index = 0; index < group.start; index++) {
      if (ops[index]!.kind !== "+") fromStart++;
      if (ops[index]!.kind !== "-") toStart++;
    }
    let fromCount = 0;
    let toCount = 0;
    const body: string[] = [];
    for (let index = group.start; index <= group.end; index++) {
      const op = ops[index]!;
      if (op.kind !== "+") fromCount++;
      if (op.kind !== "-") toCount++;
      body.push(`${op.kind}${op.text}`);
      const missing =
        (op.kind !== "+" && index === lastBefore && !beforeEndsWithNewline) ||
        (op.kind !== "-" && index === lastAfter && !afterEndsWithNewline);
      if (missing) body.push("\\ No newline at end of file");
    }
    out.push(`@@ -${fromStart},${fromCount} +${toStart},${toCount} @@`);
    out.push(...body);
  }
  return `${out.join("\n")}\n`;
}
