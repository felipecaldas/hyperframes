/**
 * TAB-1223. What a catalog run may change, said by code.
 *
 * On a catalog run Studio stages the item's own files before the model starts,
 * and the install builds the one element that mounts a block. So what is asked
 * for is known before the model says a word: that element, added to a
 * composition that was already in the project, and the item's own files
 * fitted to the project. Everything else is not asked for.
 *
 * The check at apply (`review.ts`) reads the change against the user's words
 * and rules, and it is a model. Measured on the catalog case it let a planted
 * attribute through when that attribute sat in the same hunk as the mount, one
 * trial in five and then one in one. A rule that is known before the run does
 * not need a reading; it is held here, before the check, and the check reads
 * only what this could not settle: the fit inside the item's own files, and
 * the paste of a component, which has no mount.
 *
 * What this is: a comparison of each pre-existing composition the run changed
 * with the same file before the run, once the elements that mount the item are
 * taken out. What it is not: a judgement of the fit, which stays the check's.
 */
import type { AgentFileSnapshot } from "../files.js";
import type { AgentChangedFile, AgentRefusal } from "../types.js";

/**
 * What Studio staged for a catalog run, as the install said it.
 *
 * Handed to the model so it mounts the item with the element the install
 * built rather than working one out (it pasted the block's markup into
 * `index.html`, which the checker refuses, or wrote a file of its own for it),
 * and held against the change here.
 */
export interface CatalogMount {
  /** The registry item's name, as the user picked it. */
  item: string;
  type: "hyperframes:block" | "hyperframes:component" | "hyperframes:example";
  /** Project-relative path of the item's own file. */
  file: string;
  /** Every file the install wrote, the item's own first, then its dependencies'. */
  files: readonly string[];
  /** The mount element as `hyperframes add` prints it; a comment for a component. */
  snippet: string;
}

/** An element that mounts a composition and holds nothing of its own. */
const MOUNT_ELEMENT = /<div\b[^>]*\bdata-composition-src="([^"]*)"[^>]*>\s*<\/div>/g;

function decode(content: string | undefined): string {
  return content === undefined ? "" : Buffer.from(content, "base64").toString("utf-8");
}

/** Whitespace is layout in an editor and nothing on a timeline. */
function normalize(html: string): string {
  return html.replace(/\s+/g, " ").trim();
}

/** `html` with every element that mounts `file` taken out. */
function withoutMounts(html: string, file: string): string {
  return html.replace(MOUNT_ELEMENT, (match, src: string) => (src === file ? "" : match));
}

function refusal(file: string, what: string): AgentRefusal {
  return {
    gate: "unasked-change",
    stage: "apply",
    message:
      "The change included something your message did not ask for, so none of it was " +
      `applied: ${what}. If you did want that, ask for it in your own words and it will go ` +
      "through.",
    file,
  };
}

/**
 * Why a catalog run's change may not be applied, or null when every changed
 * file is either the item's own, or a composition that was in the project and
 * now holds exactly what it held plus the element that mounts the item.
 *
 * A component has no mount and is pasted, so a pre-existing composition it
 * was pasted into is left to the check to read. A file the run made, removed,
 * or changed that is not a composition is not the placing of the item, whatever
 * the item is.
 */
export function placementRefusal(
  mount: CatalogMount,
  changedFiles: readonly AgentChangedFile[],
  baseline: AgentFileSnapshot,
  staged: AgentFileSnapshot,
): AgentRefusal | null {
  const installed = new Set(mount.files);
  for (const file of changedFiles) {
    if (installed.has(file.path)) continue;
    if (file.change !== "modified" || !file.path.endsWith(".html")) {
      return refusal(file.path, `${file.path} is not the item and is not where it is placed`);
    }
    if (mount.type !== "hyperframes:block") continue;
    const before = decode(baseline.sourceContents[file.path]);
    const after = withoutMounts(decode(staged.sourceContents[file.path]), mount.file);
    if (normalize(after) !== normalize(before)) {
      return refusal(
        file.path,
        `${file.path} holds more than the element that mounts ${mount.item}`,
      );
    }
  }
  return null;
}
