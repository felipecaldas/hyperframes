import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StudioApiAdapter } from "../types.js";
import { isInHiddenOrVendorDir, walkDir } from "./safePath.js";

export interface LintFinding {
  severity: string;
  message: string;
  file?: string;
}

const isError = (finding: LintFinding): boolean => finding.severity.toLowerCase() === "error";

/** A finding's identity for baseline comparison — file, severity and message. */
function findingKey(finding: LintFinding): string {
  return `${finding.file ?? ""}::${finding.severity.toLowerCase()}::${finding.message}`;
}

/**
 * The findings present after the run that were not present before it.
 *
 * Counted by identity rather than by tally: an edit that fixes one inherited
 * finding and introduces a different one nets to zero, and a count would wave
 * it through. Duplicates of the same message in one file are matched
 * one-for-one, so going from one occurrence to three still reports two.
 *
 * `baseline` is what the lint said about the tree the model started in. On a
 * catalog run that tree holds the staged item, whose own findings are then
 * inherited and not introduced (TAB-1223). The apply gate and the
 * `validate_project` tool read the same baseline: told of the item's own
 * findings mid-run, the model set out to repair them and wrote a file of its
 * own for the item, which the placing then refused.
 */
export function introducedFindings(baseline: LintFinding[], staged: LintFinding[]): LintFinding[] {
  if (staged.length === 0) return [];
  const remaining = new Map<string, number>();
  for (const finding of baseline) {
    const key = findingKey(finding);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const introduced: LintFinding[] = [];
  for (const finding of staged) {
    const key = findingKey(finding);
    const left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1);
    else introduced.push(finding);
  }
  return introduced;
}

/** The `error` findings present after the run that were not present before it. */
export function introducedErrors(baseline: LintFinding[], staged: LintFinding[]): LintFinding[] {
  return introducedFindings(baseline, staged).filter(isError);
}

export async function lintProject(
  adapter: StudioApiAdapter,
  projectDir: string,
): Promise<LintFinding[]> {
  const htmlFiles = walkDir(projectDir).filter(
    (file) => file.endsWith(".html") && !isInHiddenOrVendorDir(file),
  );
  const findings: Array<LintFinding & { fixHint?: string }> = [];
  for (const file of htmlFiles) {
    const content = readFileSync(join(projectDir, file), "utf-8");
    const result = await adapter.lint(content, { filePath: file });
    for (const finding of result?.findings ?? []) findings.push({ ...finding, file });
  }
  return findings;
}
