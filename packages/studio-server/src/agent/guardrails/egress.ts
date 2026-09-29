/**
 * TAB-1195. Refuse egress the agent introduces into a project file.
 *
 * A project file is not inert. `index.html` is opened by the preview iframe in
 * the customer's browser, and by the headless Chromium that `run_check` and
 * `frame_screenshot` launch inside a session sandbox that shares the host's
 * network. So a remote `<img src>` written into it is a request, made twice,
 * carrying whatever the URL was built from. Until this existed the only check
 * on a `src` was whether a *local* path resolved. A remote one was waved through
 * by name.
 *
 * Three rules, and the first is the one that matters most:
 *
 * 1. **Introduced-only.** What the file already contained is never refused. A
 *    gate phrased "refuse if the result is bad" is wrong when the input was
 *    already bad, and that exact mistake once held the lint gate shut on every
 *    project with scenes. Occurrences are matched one for one, so an edit that
 *    removes one remote URL and adds a different one is still refused.
 * 2. **Only what is egress.** `isNonLocalSrc` used to lump three things
 *    together. A remote URL is egress. A `data:` URI is not, and a template
 *    placeholder is not either, because the compiler fills it in later.
 *    Refusing a placeholder would break every template-driven project.
 * 3. **Text on screen is not a request.** A caption may say a web address. Only
 *    markup, styles and script are read for URLs, never the words between tags.
 *
 * What this is not: a sandbox. It reads the plain form of a URL and the plain
 * name of a network call. Script that assembles either one at run time from
 * pieces is outside what any reading of source can see, and is the business of
 * the network boundary, not of this file.
 */
import type { AgentRefusal } from "../types.js";
import { GuardrailRefusal } from "./refusal.js";

export type SrcKind = "local" | "remote" | "data" | "template" | "other";

const REMOTE_SCHEME_RE = /^(?:https?|wss?|ftps?):/i;
const ANY_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const TEMPLATE_RE = /\$\{|\{\{|<%/;

/**
 * The start of a URL as a browser reads it: tabs and newlines dropped from
 * anywhere, surrounding space trimmed, and a backslash taken as a slash.
 */
function asBrowserReads(src: string): string {
  return src
    .replace(/[\t\n\r]/g, "")
    .trim()
    .replace(/\\/g, "/");
}

/**
 * What a `src` points at.
 *
 * Remote is decided first, so a remote URL with a placeholder in its path is
 * still remote: the host is already fixed and the request is already made.
 */
export function classifySrc(src: string): SrcKind {
  const value = asBrowserReads(src);
  if (value.startsWith("//") || REMOTE_SCHEME_RE.test(value)) return "remote";
  if (/^data:/i.test(value)) return "data";
  if (TEMPLATE_RE.test(value)) return "template";
  if (ANY_SCHEME_RE.test(value)) return "other";
  return "local";
}

/** One thing in a file that reaches the network. `key` is its identity. */
interface Finding {
  key: string;
  what: string;
}

const MAX_URL_CHARS = 200;
const MAX_NAMED = 5;

function urlFinding(url: string): Finding {
  const shown = url.length > MAX_URL_CHARS ? `${url.slice(0, MAX_URL_CHARS)}…` : url;
  return { key: `url:${url}`, what: `remote URL ${shown}` };
}

const ABSOLUTE_URL_RE = /\b(?:https?|wss?|ftps?):\/\/[^\s"'<>`)\\]+/gi;
/**
 * `//host.tld/…` directly inside a quote or a CSS `url(`. Anchored to those two
 * positions because a bare `//` in script is a comment far more often than it
 * is a URL.
 */
const PROTOCOL_RELATIVE_RE =
  /(?:["'`]|\burl\(\s*)(\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}[^\s"'<>`)\\]*)/gi;

function scanLiterals(text: string): Finding[] {
  const absolute = [...text.matchAll(ABSOLUTE_URL_RE)].map((match) => urlFinding(match[0]));
  const relative = [...text.matchAll(PROTOCOL_RELATIVE_RE)].map((match) =>
    urlFinding(match[1] ?? ""),
  );
  return [...absolute, ...relative];
}

const NETWORK_CALLS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "fetch(", re: /\bfetch\s*\(/g },
  { name: "XMLHttpRequest", re: /\bXMLHttpRequest\b/g },
  { name: "import(", re: /\bimport\s*\(/g },
  { name: "new Worker", re: /\bnew\s+(?:Shared)?Worker\b/g },
  { name: "sendBeacon", re: /\bsendBeacon\b/g },
  { name: "new WebSocket", re: /\bnew\s+WebSocket\b/g },
  { name: "new EventSource", re: /\bnew\s+EventSource\b/g },
  { name: "importScripts(", re: /\bimportScripts\s*\(/g },
];

function scanCalls(text: string): Finding[] {
  return NETWORK_CALLS.flatMap(({ name, re }) =>
    [...text.matchAll(re)].map(() => ({ key: `call:${name}`, what: `network call ${name}` })),
  );
}

const scanScript = (text: string): Finding[] => [...scanLiterals(text), ...scanCalls(text)];

/** A `$schema` names a vocabulary. Nothing fetches it. */
const scanData = (text: string): Finding[] =>
  scanLiterals(text.replace(/(["']?)\$schema\1\s*:\s*\S+/g, ""));

// ── Markup ─────────────────────────────────────────────────────────────────
//
// The tag reader follows the HTML tokenizer's own rules for where a tag ends,
// and that is deliberate. A reader that ends a tag at the first `>` disagrees
// with the browser whenever an attribute value contains one, and everything
// after the point of disagreement is read as text, which is the one thing this
// gate does not look at. Where the two could still disagree, this reader errs
// toward calling something markup, since markup is what gets read.

interface Attribute {
  name: string;
  value: string;
  /** The attribute as written, name and value, so nothing is lost to parsing. */
  raw: string;
  end: number;
}

interface Tag {
  name: string;
  closing: boolean;
  attributes: Attribute[];
  end: number;
}

const TAG_OPEN_RE = /<(\/?)([a-zA-Z][^\s/>]*)/y;
const SEPARATOR_RE = /[\s/]*/y;
const ATTRIBUTE_NAME_RE = /=?[^\s/>=]*/y;
const SPACE_RE = /\s*/y;
const UNQUOTED_VALUE_RE = /[^\s>]*/y;

function matchAt(re: RegExp, text: string, at: number): string {
  re.lastIndex = at;
  return re.exec(text)?.[0] ?? "";
}

function readValue(html: string, at: number): { value: string; end: number } {
  const quote = html[at];
  if (quote !== '"' && quote !== "'") {
    const value = matchAt(UNQUOTED_VALUE_RE, html, at);
    return { value, end: at + value.length };
  }
  const close = html.indexOf(quote, at + 1);
  // An unclosed quote runs to the end of the file, as it does in a browser.
  if (close < 0) return { value: html.slice(at + 1), end: html.length };
  return { value: html.slice(at + 1, close), end: close + 1 };
}

function readAttribute(html: string, at: number): Attribute {
  const name = matchAt(ATTRIBUTE_NAME_RE, html, at);
  const nameEnd = at + name.length;
  const equals = nameEnd + matchAt(SPACE_RE, html, nameEnd).length;
  if (html[equals] !== "=") return { name: name.toLowerCase(), value: "", raw: name, end: nameEnd };
  const valueAt = equals + 1 + matchAt(SPACE_RE, html, equals + 1).length;
  const { value, end } = readValue(html, valueAt);
  return { name: name.toLowerCase(), value, raw: html.slice(at, end), end };
}

function readTag(html: string, at: number): Tag | null {
  TAG_OPEN_RE.lastIndex = at;
  const open = TAG_OPEN_RE.exec(html);
  if (!open) return null;
  const attributes: Attribute[] = [];
  let cursor = at + open[0].length;
  while (cursor < html.length) {
    cursor += matchAt(SEPARATOR_RE, html, cursor).length;
    if (cursor >= html.length) break;
    if (html[cursor] === ">") {
      cursor += 1;
      break;
    }
    const attribute = readAttribute(html, cursor);
    attributes.push(attribute);
    cursor = attribute.end;
  }
  return {
    name: (open[2] ?? "").toLowerCase(),
    closing: open[1] === "/",
    attributes,
    end: cursor,
  };
}

/** An XML namespace is an identifier that happens to look like a URL. */
const isNamespace = (name: string): boolean => name === "xmlns" || name.startsWith("xmlns:");

const SRCSET_ATTRIBUTES = new Set(["srcset", "imagesrcset"]);

/** The URLs an attribute's value starts with, one per `srcset` candidate. */
function leadingUrls(attribute: Attribute): string[] {
  const candidates = SRCSET_ATTRIBUTES.has(attribute.name)
    ? attribute.value.split(",")
    : [attribute.value];
  return candidates.map((candidate) => asBrowserReads(candidate).split(/\s+/)[0] ?? "");
}

function carriesScript(attribute: Attribute): boolean {
  if (attribute.name.startsWith("on") || attribute.name === "srcdoc") return true;
  return /^javascript:/i.test(asBrowserReads(attribute.value));
}

function uniqueByKey(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    if (seen.has(finding.key)) return false;
    seen.add(finding.key);
    return true;
  });
}

function scanAttribute(attribute: Attribute): Finding[] {
  if (isNamespace(attribute.name)) return [];
  // Read twice on purpose. The literal scan finds a URL anywhere in the
  // attribute as written. The leading-URL read finds the forms a literal scan
  // cannot: an unquoted `//host`, a backslash, a scheme split by a newline.
  const leading = leadingUrls(attribute)
    .filter((url) => classifySrc(url) === "remote")
    .map(urlFinding);
  const urls = uniqueByKey([...scanLiterals(attribute.raw), ...leading]);
  return carriesScript(attribute) ? [...urls, ...scanCalls(attribute.value)] : urls;
}

const RAW_TEXT_SCANNERS: Record<string, (body: string) => Finding[]> = {
  script: scanScript,
  style: scanLiterals,
  // The browser reads these as text. Reading them for URLs anyway costs a
  // false refusal on a page title that spells out a web address, and removes a
  // place where this reader and the browser could disagree about what is a tag.
  textarea: scanLiterals,
  title: scanLiterals,
  xmp: scanLiterals,
  iframe: scanLiterals,
  noembed: scanLiterals,
  noframes: scanLiterals,
  noscript: scanLiterals,
};

function rawTextEnd(html: string, tag: Tag): number {
  const close = new RegExp(`</${tag.name}(?=[\\s/>])`, "gi");
  close.lastIndex = tag.end;
  const found = close.exec(html);
  if (!found) return html.length;
  // A script body holding `<!--` can, by the tokenizer's escape rules, run past
  // its first closing tag. Rather than reproduce those rules, read the rest of
  // the file as script.
  if (tag.name === "script" && html.slice(tag.end, found.index).includes("<!--"))
    return html.length;
  return found.index;
}

interface Step {
  findings: Finding[];
  end: number;
}

function readComment(html: string, open: number): Step {
  const ends = ["-->", "--!>"]
    .map((marker) => ({ at: html.indexOf(marker, open + 2), length: marker.length }))
    .filter((candidate) => candidate.at >= 0)
    .sort((a, b) => a.at - b.at);
  const first = ends[0];
  const end = first ? first.at + first.length : html.length;
  return { findings: scanLiterals(html.slice(open, end)), end };
}

function readNode(html: string, open: number): Step {
  if (html.startsWith("<!--", open)) return readComment(html, open);
  const tag = readTag(html, open);
  if (!tag) return { findings: [], end: open + 1 };
  // A closing tag's attributes are parsed and then thrown away by the browser.
  if (tag.closing) return { findings: [], end: tag.end };
  const findings = tag.attributes.flatMap(scanAttribute);
  const scanBody = RAW_TEXT_SCANNERS[tag.name];
  if (!scanBody) return { findings, end: tag.end };
  const end = rawTextEnd(html, tag);
  return { findings: [...findings, ...scanBody(html.slice(tag.end, end))], end };
}

function scanMarkup(html: string): Finding[] {
  const findings: Finding[] = [];
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    if (open < 0) break;
    const step = readNode(html, open);
    findings.push(...step.findings);
    at = step.end;
  }
  return findings;
}

/**
 * How each kind of project file is read. A kind that is absent is not read:
 * `.md` and `.txt` are prose, which nothing loads.
 */
const SCANNERS: Record<string, (content: string) => Finding[]> = {
  ".html": scanMarkup,
  ".svg": scanMarkup,
  ".css": scanLiterals,
  ".js": scanScript,
  ".mjs": scanScript,
  ".cjs": scanScript,
  ".jsx": scanScript,
  ".ts": scanScript,
  ".tsx": scanScript,
  ".json": scanData,
  ".yaml": scanData,
  ".yml": scanData,
};

function findEgress(file: string, content: string): Finding[] {
  const dot = file.lastIndexOf(".");
  const scan = dot >= 0 ? SCANNERS[file.slice(dot).toLowerCase()] : undefined;
  return scan ? scan(content) : [];
}

/**
 * The entries of `after` that `before` cannot account for.
 *
 * Counted by identity and matched one for one, the way `introducedErrors`
 * matches lint findings: going from one occurrence to three reports two, and
 * swapping one entry for a different one reports the new one.
 */
export function introducedOnly<T>(before: T[], after: T[], keyOf: (item: T) => string): T[] {
  const remaining = new Map<string, number>();
  for (const item of before) remaining.set(keyOf(item), (remaining.get(keyOf(item)) ?? 0) + 1);
  return after.filter((item) => {
    const left = remaining.get(keyOf(item)) ?? 0;
    if (left > 0) remaining.set(keyOf(item), left - 1);
    return left === 0;
  });
}

/** The refusal for a list of things a change introduced, in words. */
export function egressRefusal(
  file: string,
  introduced: string[],
  stage: AgentRefusal["stage"],
  advice: string,
): AgentRefusal {
  const named = [...new Set(introduced)];
  const shown = named.slice(0, MAX_NAMED).join("; ");
  const more = named.length > MAX_NAMED ? `; and ${named.length - MAX_NAMED} more` : "";
  return {
    gate: "egress",
    stage,
    file,
    message:
      `${file} would reach outside the project: ${shown}${more}. ` +
      "The preview and the renderer both open this file, so anything it loads from another " +
      `host is a request they make. ${advice} ` +
      "What the file already contained before this change is left alone.",
  };
}

const ADVICE =
  "Reference a file the project already contains, and leave network calls out of project code.";

/**
 * Refuse a change that makes `file` reach the network in a way it did not
 * before. `before` is the empty string for a file the change creates.
 */
export function assertNoIntroducedEgress(
  before: string,
  after: string,
  file: string,
  stage: AgentRefusal["stage"],
): void {
  const introduced = introducedOnly(
    findEgress(file, before),
    findEgress(file, after),
    (finding) => finding.key,
  );
  if (introduced.length === 0) return;
  throw new GuardrailRefusal(
    egressRefusal(
      file,
      introduced.map((finding) => finding.what),
      stage,
      ADVICE,
    ),
  );
}
