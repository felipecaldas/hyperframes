import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StudioApiAdapter } from "../types.js";
import { isInHiddenOrVendorDir, walkDir } from "./safePath.js";

export async function lintProject(adapter: StudioApiAdapter, projectDir: string) {
  const htmlFiles = walkDir(projectDir).filter(
    (file) => file.endsWith(".html") && !isInHiddenOrVendorDir(file),
  );
  const findings: Array<{
    severity: string;
    message: string;
    file?: string;
    fixHint?: string;
  }> = [];
  for (const file of htmlFiles) {
    const content = readFileSync(join(projectDir, file), "utf-8");
    const result = await adapter.lint(content, { filePath: file });
    for (const finding of result?.findings ?? []) findings.push({ ...finding, file });
  }
  return findings;
}
