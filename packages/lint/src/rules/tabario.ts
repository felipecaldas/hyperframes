/**
 * Tabario motion register rules.
 *
 * A compiled Tabario project carries one decision per template in a
 * `<meta name="tabario-project">` tag: which transition is the film's primary,
 * which two may accent it, how many accents the whole film gets, and which
 * eases exist. These four rules hold a project to that decision.
 *
 * Three things about the shape of this file are deliberate.
 *
 * It imports `@hyperframes/parsers/gsap-parser-acorn` itself rather than
 * borrowing anything from `rules/gsap.ts`. Upstream rewrites `gsap.ts` often,
 * and a Tabario patch inside it buys a merge conflict on every sync. This file
 * is ours alone, so it never conflicts.
 *
 * It reads the tag from `ctx.rawSource`, never `ctx.source`. `context.ts`
 * replaces `source` with a scene file's `<template>` inner HTML, which drops the
 * `<head>` the tag lives in. A scene file read through `source` looks untagged.
 *
 * Every code is a warning. `shouldBlockRender` and the CLI's check pipeline both
 * let a warning through, so these rules never stop a render on their own. The
 * compositor's export gate is what refuses on them.
 */
import type { LintContext, HyperframeLintFinding } from "../context";
import { readDecodedAttr, stripHtmlComments } from "../utils";

const META_TAG_PATTERN = /<meta\b[^>]*>/gi;

/** `soft_cut` is the absence of a transition, so no register has to name it. */
const ALWAYS_ALLOWED_TRANSITION = "soft_cut";

type MotionRegister = {
  primary: string;
  accents: string[];
  allowedEases: string[];
  accentLimit: number | null;
};

type TagRead =
  | { kind: "absent" }
  | { kind: "malformed"; reason: string }
  | { kind: "register"; register: MotionRegister };

type RegisterRead = { ok: true; register: MotionRegister } | { ok: false; reason: string };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** The tag's `content`, entity-decoded the way `getAttribute()` would decode it. */
function findTagContent(rawSource: string): string | null {
  // Comments are stripped first. A commented-out tag is not a register, and
  // scanning rawSource without this would arm the whole gate from a comment.
  const source = stripHtmlComments(rawSource);
  for (const match of source.matchAll(META_TAG_PATTERN)) {
    const raw = match[0];
    if (readDecodedAttr(raw, "name") !== "tabario-project") continue;
    return readDecodedAttr(raw, "content");
  }
  return null;
}

/** The tag's top-level object, or the reason it is not one. */
function parseTagRoot(content: string): Record<string, unknown> | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown parse error";
    return `content is not JSON (${detail})`;
  }
  const root = readRecord(parsed);
  if (!root) return "content is not a JSON object";
  if (root.schema !== 1) return `schema is ${JSON.stringify(root.schema)}, expected 1`;
  return root;
}

/** The two transition fields, or the name of the one that is wrong. */
function readTransitionPolicy(
  motion: Record<string, unknown>,
): { primary: string; accents: string[] } | string {
  const transitions = readRecord(motion.transitions);
  if (!transitions) return "policies.motion.transitions is missing";
  const { primary, accents } = transitions;
  if (typeof primary !== "string" || !primary) {
    return "policies.motion.transitions.primary is not a string";
  }
  if (!isStringArray(accents)) return "policies.motion.transitions.accents is not a string array";
  return { primary, accents };
}

/**
 * The accent ceiling. The two halves of this feature have written it in two
 * places, so both are read and the shorter path wins. Returning null is not an
 * opinion about whether the field was required; `readMotionPolicy` decides that.
 */
function readAccentLimit(policies: Record<string, unknown>): number | null {
  const candidate =
    policies.strong_transition_limit ?? readRecord(policies.transitions)?.strong_transition_limit;
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) return null;
  return candidate;
}

/**
 * Every field the rules go on to read is validated here, and a missing one is
 * malformed rather than skipped. A register that parses but carries no
 * `allowed_eases` would leave the ease check reading an empty policy and
 * reporting nothing, which is indistinguishable from a project that obeys its
 * register. A gate that cannot go red is worse than no gate.
 */
function readMotionPolicy(policies: Record<string, unknown>): RegisterRead {
  const motion = readRecord(policies.motion);
  if (!motion) return { ok: false, reason: "policies.motion is missing" };
  const transitions = readTransitionPolicy(motion);
  if (typeof transitions === "string") return { ok: false, reason: transitions };
  if (!isStringArray(motion.allowed_eases)) {
    return { ok: false, reason: "policies.motion.allowed_eases is not a string array" };
  }

  // The limit is only required when there are accents to count. With none, every
  // accent mount is already an out-of-register transition and the count adds
  // nothing, so a register that omits the field is still complete.
  const accentLimit = readAccentLimit(policies);
  if (transitions.accents.length > 0 && accentLimit === null) {
    return { ok: false, reason: "policies.strong_transition_limit is not a number" };
  }

  return {
    ok: true,
    register: { ...transitions, allowedEases: motion.allowed_eases, accentLimit },
  };
}

/** Read the register, or say precisely why it could not be read. */
function readTabarioProject(rawSource: string): TagRead {
  const content = findTagContent(rawSource);
  if (content === null) return { kind: "absent" };
  const root = parseTagRoot(content);
  if (typeof root === "string") return { kind: "malformed", reason: root };
  const policies = readRecord(root.policies);
  if (!policies) return { kind: "malformed", reason: "policies is missing" };
  const read = readMotionPolicy(policies);
  if (!read.ok) return { kind: "malformed", reason: read.reason };
  return { kind: "register", register: read.register };
}

// ── eases ──────────────────────────────────────────────────────────────────

type EaseUse = { ease: string; field: string; target: string; line: number | null };

type LintParsedGsap = {
  animations: Array<{
    targetSelector: string;
    ease?: string;
    extras?: Record<string, unknown>;
    keyframes?: {
      ease?: string;
      easeEach?: string;
      keyframes: Array<{ percentage: number; ease?: string }>;
    };
  }>;
};

// Same dynamic import `rules/gsap.ts` uses: the acorn parser resolves computed
// timelines and stays browser-safe, and importing it lazily keeps it out of the
// cost of every lint run that has no GSAP in it.
async function loadParseGsapScript(): Promise<(script: string) => LintParsedGsap> {
  const mod = await import("@hyperframes/parsers/gsap-parser-acorn");
  return mod.parseGsapScriptAcorn as unknown as (script: string) => LintParsedGsap;
}

// Keyed on the script text itself, matching `gsapWindowsCache` in `rules/gsap.ts`.
// A project lints its root and every scene file in one process and the same
// inline script recurs across them, so re-parsing is the cost this avoids.
const easeUseCache = new Map<string, EaseUse[]>();

/** 1-based line of an ease literal inside its own script block, when findable. */
function lineOfEase(script: string, ease: string): number | null {
  const at = script.indexOf(ease);
  if (at < 0) return null;
  return script.slice(0, at).split("\n").length;
}

/** The ease inside a `stagger: { each, ease }` config, which the parser keeps raw. */
function staggerEase(stagger: unknown): string | undefined {
  if (typeof stagger !== "string") return undefined;
  return /\bease\s*:\s*["']([^"']+)["']/.exec(stagger)?.[1];
}

/**
 * Every ease one animation declares, from all four places one can hide.
 *
 * `ease` alone is not enough. The parser puts a keyframe's own ease on the
 * keyframe, a keyframes block's shared ease on the block, and a stagger's ease
 * inside the raw `stagger` config it preserves for round-trips. Reading only the
 * top-level field lets a staggered or keyframed `back.out` walk past the gate,
 * which is the single thing these rules exist to stop.
 */
function easeFieldsOf(
  anim: LintParsedGsap["animations"][number],
): Array<{ ease: string; field: string }> {
  const keyframes = anim.keyframes;
  const candidates: Array<{ ease: string | undefined; field: string }> = [
    { ease: anim.ease, field: "ease" },
    { ease: keyframes?.ease, field: "keyframes.ease" },
    { ease: keyframes?.easeEach, field: "easeEach" },
    ...(keyframes?.keyframes ?? []).map((keyframe) => ({
      ease: keyframe.ease,
      field: `keyframes ${keyframe.percentage}%`,
    })),
    { ease: staggerEase(anim.extras?.stagger), field: "stagger.ease" },
  ];
  return candidates.filter((c): c is { ease: string; field: string } => Boolean(c.ease));
}

function collectEaseUses(script: string, parsed: LintParsedGsap): EaseUse[] {
  const uses: EaseUse[] = [];
  for (const anim of parsed.animations) {
    const target = anim.targetSelector || "an unresolved target";
    for (const { ease, field } of easeFieldsOf(anim)) {
      uses.push({ ease, field, target, line: lineOfEase(script, ease) });
    }
  }
  return uses;
}

async function cachedEaseUses(script: string): Promise<EaseUse[]> {
  const cached = easeUseCache.get(script);
  if (cached) return cached;
  let uses: EaseUse[] = [];
  try {
    const parse = await loadParseGsapScript();
    uses = collectEaseUses(script, parse(script));
  } catch {
    // A script the parser chokes on is the GSAP rules' problem to report. These
    // rules stay quiet about it: throwing here would drop every other finding in
    // the file, including the three checks that need no parser at all.
    uses = [];
  }
  easeUseCache.set(script, uses);
  return uses;
}

/**
 * An ease is inside the register when its full text is listed, or when its base
 * name is. `back.out(1.7)` and `back.out` are the same ease configured two ways,
 * so a register that lists the configurable form accepts both.
 */
function easeIsAllowed(ease: string, allowed: readonly string[]): boolean {
  if (allowed.includes(ease)) return true;
  const base = ease.split("(")[0]?.trim();
  return Boolean(base) && allowed.includes(base!);
}

// ── the rule ───────────────────────────────────────────────────────────────

function basenameOf(filePath: string | undefined): string | null {
  if (!filePath) return null;
  return filePath.split(/[\\/]/).pop() || null;
}

function transitionMounts(ctx: LintContext): Array<{ type: string; compositionId: string | null }> {
  const mounts: Array<{ type: string; compositionId: string | null }> = [];
  for (const tag of ctx.tags) {
    const type = readDecodedAttr(tag.raw, "data-transition-type");
    if (!type) continue;
    mounts.push({ type, compositionId: readDecodedAttr(tag.raw, "data-composition-id") });
  }
  return mounts;
}

function easeFindings(uses: readonly EaseUse[], register: MotionRegister): HyperframeLintFinding[] {
  const allowedList = register.allowedEases.join(", ");
  const findings: HyperframeLintFinding[] = [];
  for (const use of uses) {
    if (easeIsAllowed(use.ease, register.allowedEases)) continue;
    const where = use.line === null ? "an inline script" : `inline script line ${use.line}`;
    findings.push({
      code: "tabario_motion_ease_outside_register",
      severity: "warning",
      message:
        `Ease "${use.ease}" on ${use.target} (${use.field}, ${where}) is outside this template's ` +
        `motion register. Allowed: ${allowedList}.`,
      selector: use.target,
      fixHint:
        `Use one of ${allowedList}, or change the template's motion.allowed_eases if the film ` +
        `genuinely needs this ease.`,
    });
  }
  return findings;
}

function transitionFindings(
  mounts: ReadonlyArray<{ type: string; compositionId: string | null }>,
  register: MotionRegister,
): HyperframeLintFinding[] {
  const allowed = new Set([register.primary, ...register.accents, ALWAYS_ALLOWED_TRANSITION]);
  const findings: HyperframeLintFinding[] = [];
  for (const mount of mounts) {
    if (allowed.has(mount.type)) continue;
    const scene = mount.compositionId ? ` on "${mount.compositionId}"` : "";
    findings.push({
      code: "tabario_motion_transition_outside_register",
      severity: "warning",
      message:
        `Transition "${mount.type}"${scene} is outside this template's motion register. ` +
        `Primary: ${register.primary}. Accents: ${register.accents.join(", ") || "none"}.`,
      elementId: mount.compositionId || undefined,
      fixHint:
        `Use ${register.primary}, an accent the register names, or a cut. A cut carries no ` +
        `data-transition-type at all.`,
    });
  }
  return findings;
}

function accentFindings(
  mounts: ReadonlyArray<{ type: string; compositionId: string | null }>,
  register: MotionRegister,
): HyperframeLintFinding[] {
  if (register.accentLimit === null) return [];
  const accents = new Set(register.accents);
  const used = mounts.filter((mount) => accents.has(mount.type)).length;
  if (used <= register.accentLimit) return [];
  return [
    {
      code: "tabario_motion_accent_limit",
      severity: "warning",
      message:
        `This film uses ${used} accent transitions; its register allows ${register.accentLimit}. ` +
        `Accents: ${register.accents.join(", ")}.`,
      fixHint: `Turn ${used - register.accentLimit} of them into the primary transition or a cut.`,
    },
  ];
}

/**
 * One rule, four codes. The four checks share a single read of the tag, and a
 * malformed tag returns on its own: with no register there is nothing to hold
 * the project to, and repeating the same finding per check would report one
 * broken tag three times.
 */
export const tabarioRules: Array<(ctx: LintContext) => Promise<HyperframeLintFinding[]>> = [
  async (ctx) => {
    const read = readTabarioProject(ctx.rawSource);
    if (read.kind === "absent") return [];
    if (read.kind === "malformed") {
      return [
        {
          code: "tabario_project_meta_malformed",
          severity: "warning",
          message:
            `The <meta name="tabario-project"> tag could not be read: ${read.reason}. ` +
            `No motion register was applied to this file.`,
          fixHint:
            "Recompile the project. The compositor writes this tag; a hand-edited one is not " +
            "authoritative and will be overwritten on export.",
        },
      ];
    }

    const { register } = read;
    const findings: HyperframeLintFinding[] = [];

    for (const script of ctx.scripts) {
      if (!/gsap\s*\./.test(script.content)) continue;
      findings.push(...easeFindings(await cachedEaseUses(script.content), register));
    }

    const mounts = transitionMounts(ctx);
    findings.push(...transitionFindings(mounts, register));

    // Scene files carry their own mounts. Counting them per file would charge
    // each scene the whole film's accent budget, so the count runs once, on the
    // root. `isSubComposition` cannot be the test: the Studio project-lint
    // helper never sets it, so keying on it would mean never counting at all.
    if (basenameOf(ctx.options.filePath) === "index.html") {
      findings.push(...accentFindings(mounts, register));
    }

    return findings;
  },
];
