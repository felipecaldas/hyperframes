import type { LintContext, HyperframeLintFinding, OpenTag } from "../context";
import { readDecodedAttr, truncateSnippet } from "../utils";
import {
  isSubCompositionHost,
  topLevelElements,
  trackKindOf,
  type StructureNode,
} from "@hyperframes/parsers/top-level-elements";
import { readClipTiming } from "@hyperframes/parsers/composition-contract";
import { readDataDurationSeconds } from "@hyperframes/parsers/media-duration";
import { TIMING_TOLERANCE_SECONDS } from "@hyperframes/parsers/composition-duration";

interface TagNode extends StructureNode<TagNode> {
  children: TagNode[];
  open: OpenTag;
}

// Text-level tags may sit inside a timed element without being "nested structure".
const INLINE_TEXT_TAGS = new Set([
  "br",
  "wbr",
  "b",
  "i",
  "u",
  "s",
  "em",
  "strong",
  "small",
  "sub",
  "sup",
  "mark",
  "span",
  "a",
  "code",
  "abbr",
]);
// Their content is one drawn object, so their children are not layout.
const OPAQUE_TAGS = new Set([
  "svg",
  "canvas",
  "picture",
  "video",
  "audio",
  "select",
  "textarea",
  "iframe",
  "object",
]);
// Never layout: their content is code or inert markup.
const NON_LAYOUT_TAGS = new Set(["style", "script", "template", "noscript"]);
// Media has a default length (the file's, or the dropped-image default), so data-start alone is enough.
const MEDIA_TAGS = new Set(["video", "audio", "img"]);
const NODE_ATTRS = [
  "id",
  "class",
  "data-start",
  "data-duration",
  "data-end",
  "data-track",
  "data-track-index",
  "data-track-kind",
  "data-composition-id",
  "data-composition-src",
];

function toNode(open: OpenTag): TagNode {
  const attrs: Record<string, string | undefined> = {};
  for (const name of NODE_ATTRS) attrs[name] = readDecodedAttr(open.raw, name) ?? undefined;
  return { tag: open.name, attrs, children: [], open };
}

type OpenNode = { node: TagNode; end: number };

/** The innermost still-open node at `index`; closes nodes the index has passed. */
function enclosing(stack: OpenNode[], root: TagNode, index: number): TagNode {
  let top = stack.at(-1);
  while (top && stack.length > 1 && index >= top.end) {
    stack.pop();
    top = stack.at(-1);
  }
  return top?.node ?? root;
}

/** Rebuilds nesting from the flat tag list using each tag's close index. */
function buildTree(ctx: LintContext): TagNode | null {
  const { rootTag } = ctx;
  const rootEnd = rootTag?.closeIndex;
  if (!rootTag || rootEnd == null) return null;
  const root = toNode(rootTag);
  const stack: OpenNode[] = [{ node: root, end: rootEnd }];
  for (const tag of ctx.tags.filter((t) => t.index > rootTag.index && t.index < rootEnd)) {
    const node = toNode(tag);
    enclosing(stack, root, tag.index).children.push(node);
    if (tag.closeIndex != null) stack.push({ node, end: tag.closeIndex });
  }
  return root;
}

/**
 * TAB-1202. A caption row break, in either of the two forms that exist.
 *
 * It is a `div` and not a `span` on purpose — both runtimes select
 * `:scope > span` for karaoke words, so a span break would be counted as a word
 * (TAB-826/827) — and it holds nothing: `flex-basis: 100%; height: 0` ends a
 * flex line and does nothing else. Counting it as nested structure made two
 * separate things impossible, because under the studio host this rule is an
 * error and the agent's apply gate refuses on introduced errors:
 *
 * - the compositor's own wrapped output (`class="hf-caption-break"`, emitted by
 *   `video-compositor/src/hyperframes/captions.ts`) was an error in its own
 *   right; and
 * - the inline form (`style="flex-basis:100%;height:0"`) that the Studio agent's
 *   system prompt instructs it to write was refused on every attempt — which is
 *   the whole of TAB-1202. The agent was following its instructions correctly
 *   and the lint stopped it, so a user asking for a two-line caption could not
 *   be given one by any route.
 *
 * Both forms are recognised because they are not interchangeable: the class form
 * only draws in a project the compositor already compiled for wrapping, so an
 * edit adding a break to a single-line project must use the inline one.
 */
const isCaptionBreak = (node: TagNode) => {
  if (node.tag !== "div") return false;
  if ((node.attrs.class ?? "").split(/\s+/).includes("hf-caption-break")) return true;
  const style = readDecodedAttr(node.open.raw, "style") ?? "";
  return /flex-basis\s*:\s*100%/i.test(style);
};

function hasNestedStructure(node: TagNode): TagNode | null {
  if (OPAQUE_TAGS.has(node.tag)) return null;
  for (const child of node.children) {
    if (NON_LAYOUT_TAGS.has(child.tag)) continue;
    if (isCaptionBreak(child)) continue;
    if (!INLINE_TEXT_TAGS.has(child.tag)) return child;
    const deeper = hasNestedStructure(child);
    if (deeper) return deeper;
  }
  return null;
}

const describe = (node: TagNode) => `<${node.tag}${node.attrs.id ? ` id="${node.attrs.id}"` : ""}>`;

type Severity = HyperframeLintFinding["severity"];

function nestedStructureFindings(rows: TagNode[], severity: Severity): HyperframeLintFinding[] {
  return rows.flatMap((row) => {
    const nested = isSubCompositionHost(row) ? null : hasNestedStructure(row);
    if (!nested) return [];
    return [
      {
        code: "nested_structure_needs_subcomposition",
        severity,
        message: `${describe(row)} is a timeline element that contains nested ${describe(nested)}. The timeline shows one row per top-level element, and the root composition is built only from sub-compositions.`,
        elementId: row.attrs.id,
        fixHint: `Move ${describe(row)} and its contents into a sub-composition file and mount it with data-composition-src.`,
      },
    ];
  });
}

function missingDurationFindings(rows: TagNode[], severity: Severity): HyperframeLintFinding[] {
  return rows
    .filter(
      (row) =>
        !MEDIA_TAGS.has(row.tag) &&
        row.attrs["data-duration"] === undefined &&
        row.attrs["data-end"] === undefined &&
        !isSubCompositionHost(row),
    )
    .map((row) => ({
      code: "timeline_element_missing_timing",
      severity,
      message: `${describe(row)} is a timeline element without data-duration, so the timeline cannot draw where it ends.`,
      elementId: row.attrs.id,
      fixHint: `Add data-duration (in seconds) to ${describe(row)}.`,
    }));
}

function captionFindings(rows: TagNode[], severity: Severity): HyperframeLintFinding[] {
  const captionRows = rows.filter((row) => trackKindOf(row).kind === "captions");
  const findings: HyperframeLintFinding[] = captionRows
    .filter((row) => trackKindOf(row).source === "legacy-captions")
    .map((row) => ({
      code: "caption_track_kind_missing",
      severity,
      message: `${describe(row)} looks like captions but is not marked as such, so the timeline cannot group it on the caption track.`,
      elementId: row.attrs.id,
      fixHint: `Add data-track-kind="captions" to ${describe(row)}.`,
    }));
  const lanes = new Set(
    captionRows.flatMap((row) => row.attrs["data-track-index"] ?? row.attrs["data-track"] ?? []),
  );
  if (lanes.size > 1) {
    findings.push({
      code: "multiple_caption_tracks",
      severity,
      message: `Captions are spread across ${lanes.size} timeline tracks. Keep all captions on one track.`,
      fixHint: "Give every caption element the same data-track-index.",
    });
  }
  return findings;
}

const hundredths = (seconds: number) => Math.round(seconds * 100) / 100;

function clipsPastRootFindings(root: TagNode, rows: TagNode[]): HyperframeLintFinding[] {
  if (root.attrs["data-composition-id"] === undefined) return [];
  const rootDuration = readDataDurationSeconds((name) => root.attrs[name]);
  if (rootDuration === null) return [];
  const limit = hundredths(rootDuration);
  return rows.flatMap((row) => {
    const { start, end } = readClipTiming({ getAttribute: (name) => row.attrs[name] ?? null });
    if (start === null || end === null || end <= rootDuration + TIMING_TOLERANCE_SECONDS) return [];
    return [
      {
        code: "clip_ends_past_root_duration",
        severity: "warning",
        message: `${describe(row)} runs from ${hundredths(start)}s to ${hundredths(end)}s, past the root composition's data-duration of ${limit}s, so it is cut off in previews, posters and renders.`,
        elementId: row.attrs.id,
        fixHint: `Extend the root data-duration to ${hundredths(end)}, or make ${describe(row)} end at or before ${limit}s.`,
        snippet: truncateSnippet(row.open.raw),
      },
    ];
  });
}

export const structureRules: Array<(ctx: LintContext) => HyperframeLintFinding[]> = [
  (ctx) => {
    // The timeline shows the root composition's rows; a sub-composition file is the leaf where layout lives.
    if (ctx.options.isSubComposition) return [];
    const root = buildTree(ctx);
    if (!root) return [];
    const severity = ctx.options.host === "studio" ? "error" : "warning";
    const rows = topLevelElements(root);
    return [
      ...nestedStructureFindings(rows, severity),
      ...missingDurationFindings(rows, severity),
      ...captionFindings(rows, severity),
      ...clipsPastRootFindings(root, rows),
    ];
  },
];
