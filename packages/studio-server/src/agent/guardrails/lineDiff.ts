/**
 * A line diff, for showing a change to the check that reads it (TAB-1222).
 *
 * The apply stage knew which files a run changed and never what changed in
 * them: a hash before and a hash after. The check at apply has to be shown the
 * change itself, and shown it in pieces small enough to rule on one at a time,
 * so this turns two versions of a file into hunks.
 *
 * Written here rather than taken from a package because the fork carries none,
 * and one more dependency is one more thing every upstream merge has to agree
 * with. It is Myers' algorithm with the common head and tail taken off first,
 * which is what makes an `edit_file` on a four-thousand-line composition cost
 * what the edit cost and not what the file cost.
 *
 * Line endings are not compared. A file written back with `\n` where it had
 * `\r\n` differs on every line and changes nothing anyone can see, and a diff
 * of the whole file would bury the one line that matters.
 */

/** How many unchanged lines are shown on each side of a change. */
const CONTEXT_LINES = 2;
/**
 * How many edits the search will look for before it stops looking.
 *
 * The search keeps one row per edit distance, so its memory grows with the
 * square of this. Past it the two versions are treated as having nothing in
 * common between their shared head and tail, which is always a correct diff
 * and only a longer one.
 */
const MAX_EDIT_DISTANCE = 2_000;

export interface DiffLine {
  kind: "context" | "removed" | "added";
  text: string;
}

export interface DiffHunk {
  /** Where the hunk starts in the new version, counted from 1. */
  startLine: number;
  /** The last line of the new version the hunk covers. */
  endLine: number;
  lines: DiffLine[];
}

type Op = "keep" | "remove" | "add";

/** The text as lines, without the line endings. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  // A file that ends with a newline has no empty last line, it has an ending.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function sharedHead(before: readonly string[], after: readonly string[]): number {
  const limit = Math.min(before.length, after.length);
  let count = 0;
  while (count < limit && before[count] === after[count]) count += 1;
  return count;
}

function sharedTail(before: readonly string[], after: readonly string[], head: number): number {
  const limit = Math.min(before.length, after.length) - head;
  let count = 0;
  while (count < limit && before[before.length - 1 - count] === after[after.length - 1 - count])
    count += 1;
  return count;
}

/** One row of the search: how far each diagonal had reached at that distance. */
interface Row {
  /** The furthest `x` reached on diagonal `k`, stored at `k + reach`. */
  furthest: Int32Array;
  reach: number;
}

function furthestOn(row: Row, diagonal: number): number {
  return row.furthest[diagonal + row.reach] ?? 0;
}

/** Whether the step onto `diagonal` at `distance` came down from the one above. */
function cameDown(row: Row, diagonal: number, distance: number): boolean {
  if (diagonal === -distance) return true;
  if (diagonal === distance) return false;
  return furthestOn(row, diagonal - 1) < furthestOn(row, diagonal + 1);
}

function slide(
  before: readonly string[],
  after: readonly string[],
  x: number,
  diagonal: number,
): number {
  let at = x;
  while (at < before.length && at - diagonal < after.length && before[at] === after[at - diagonal])
    at += 1;
  return at;
}

/**
 * Every row of the search up to the one that reached the end, or null when the
 * two are further apart than the search is willing to go.
 */
function search(before: readonly string[], after: readonly string[]): Row[] | null {
  const limit = Math.min(before.length + after.length, MAX_EDIT_DISTANCE);
  const rows: Row[] = [];
  let previous: Row = { furthest: new Int32Array(3), reach: 1 };
  for (let distance = 0; distance <= limit; distance += 1) {
    const row: Row = { furthest: new Int32Array(2 * distance + 3), reach: distance + 1 };
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const start = cameDown(previous, diagonal, distance)
        ? furthestOn(previous, diagonal + 1)
        : furthestOn(previous, diagonal - 1) + 1;
      const x = slide(before, after, start, diagonal);
      row.furthest[diagonal + row.reach] = x;
      if (x >= before.length && x - diagonal >= after.length) return [...rows, row];
    }
    rows.push(row);
    previous = row;
  }
  return null;
}

/** The edits, read back from the last row of the search to the first. */
function walkBack(rows: readonly Row[], before: number, after: number): Op[] {
  const ops: Op[] = [];
  let x = before;
  let y = after;
  for (let distance = rows.length - 1; distance > 0; distance -= 1) {
    const previous = rows[distance - 1];
    if (!previous) break;
    const diagonal = x - y;
    const down = cameDown(previous, diagonal, distance);
    const from = down ? diagonal + 1 : diagonal - 1;
    const fromX = furthestOn(previous, from);
    const fromY = fromX - from;
    const landedX = down ? fromX : fromX + 1;
    for (let kept = x - landedX; kept > 0; kept -= 1) ops.push("keep");
    ops.push(down ? "add" : "remove");
    x = fromX;
    y = fromY;
  }
  for (let kept = x; kept > 0; kept -= 1) ops.push("keep");
  return ops.reverse();
}

/** The edits between two lists of lines that share no head and no tail. */
function middleOps(before: readonly string[], after: readonly string[]): Op[] {
  const rows = search(before, after);
  if (rows) return walkBack(rows, before.length, after.length);
  return [...before.map((): Op => "remove"), ...after.map((): Op => "add")];
}

interface Step {
  line: DiffLine;
  /** The line of the new version this step sits at, or sits before when removed. */
  newLine: number;
}

function steps(before: readonly string[], after: readonly string[]): Step[] {
  const head = sharedHead(before, after);
  const tail = sharedTail(before, after, head);
  const ops: Op[] = [
    ...Array.from({ length: head }, (): Op => "keep"),
    ...middleOps(before.slice(head, before.length - tail), after.slice(head, after.length - tail)),
    ...Array.from({ length: tail }, (): Op => "keep"),
  ];
  const out: Step[] = [];
  let oldAt = 0;
  let newAt = 0;
  for (const op of ops) {
    if (op === "remove") {
      out.push({ line: { kind: "removed", text: before[oldAt] ?? "" }, newLine: newAt + 1 });
      oldAt += 1;
      continue;
    }
    out.push({
      line: { kind: op === "add" ? "added" : "context", text: after[newAt] ?? "" },
      newLine: newAt + 1,
    });
    newAt += 1;
    if (op === "keep") oldAt += 1;
  }
  return out;
}

/** The index ranges of `all` that a hunk covers: each change and the lines around it. */
function ranges(all: readonly Step[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  all.forEach((step, index) => {
    if (step.line.kind === "context") return;
    const from = Math.max(0, index - CONTEXT_LINES);
    const to = Math.min(all.length - 1, index + CONTEXT_LINES);
    const last = out[out.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  });
  return out;
}

function toHunk(covered: readonly Step[]): DiffHunk {
  const first = covered[0];
  const last = covered[covered.length - 1];
  return {
    startLine: first?.newLine ?? 1,
    endLine: last?.newLine ?? 1,
    lines: covered.map((step) => step.line),
  };
}

/** What changed between two versions of a file, as hunks in the order they occur. */
export function diffHunks(before: string, after: string): DiffHunk[] {
  const all = steps(splitLines(before), splitLines(after));
  return ranges(all).map(([from, to]) => toHunk(all.slice(from, to + 1)));
}
