/**
 * Where the runtime comes from.
 *
 * Split out of composition-probe so the probe's late injection and the srcdoc's
 * parse-time injection cannot drift onto different URLs.
 *
 * ---------------------------------------------------------------------------
 * Tabario fork (TAB-746, carried forward into v0.8.1 by TAB-783)
 *
 * Upstream's fallback here was `runtimeCdnUrlForVersion("0.0.0-dev")`, i.e.
 * `https://cdn.jsdelivr.net/npm/@hyperframes/core@0.0.0-dev/...`. Two things
 * were wrong with it, and the second is why that function is deleted rather
 * than merely unused:
 *
 *   1. It is third-party egress from a customer's browser, which TAB-697
 *      removed everywhere else in the Studio surface. It is unpinned code with
 *      no `integrity` attribute, injected into the page the customer watches.
 *   2. It could never have worked. The `__HYPERFRAMES_RUNTIME_CDN_URL__`
 *      define is set by `packages/player/tsup.config.ts` only. Studio does not
 *      define it — `packages/studio/vite.config.ts` aliases this package to its
 *      SOURCE — so in the Studio bundle the `typeof` check is false and the
 *      fallback resolved to the literal `0.0.0-dev`, a dev sentinel and not a
 *      published version. The injected script 404'd every time.
 *
 * `/api/runtime.js` is studio-server's existing route for exactly these bytes
 * (`packages/cli/src/server/studioServer.ts`); it already serves every preview
 * and sub-composition document, and it serves the packed runtime the renderer
 * itself uses. Same version by construction, which a CDN URL cannot promise.
 *
 * **Why the patch now lives here rather than in composition-probe.ts.** At
 * v0.7.109 there was one injection site and the patch sat next to it. v0.8.1
 * (#3316) added a second — `prepareSrcdocForElement` in `shader-options.ts`
 * injects the runtime into a srcdoc at parse time — and routed it through this
 * constant. Patching only the probe would have left that new path pointing at
 * jsdelivr: an egress regression introduced by an upstream refactor, in a file
 * our patch never touched. Fixing the shared constant covers both sites, which
 * is the whole reason upstream extracted it.
 *
 * The `typeof` branch is kept so the standalone `hyperframes-player.global.js`
 * build (served by `play` / `present`, local developer tools outside this
 * fork's egress scope) keeps upstream's behaviour unchanged.
 *
 * `packages/studio-server/src/helpers/forkEgressGuard.test.ts` fails if a
 * third-party host reappears anywhere under `player/src`. That guard is what
 * caught this on the v0.8.1 merge.
 * ---------------------------------------------------------------------------
 */
declare const __HYPERFRAMES_RUNTIME_CDN_URL__: string;

const SAME_ORIGIN_RUNTIME_URL = "/api/runtime.js";

/**
 * Kept under upstream's name so consumers (`composition-probe.ts`,
 * `shader-options.ts`) merge cleanly, but it is no longer a CDN URL in this
 * fork unless a build explicitly defines one.
 */
export const RUNTIME_CDN_URL =
  typeof __HYPERFRAMES_RUNTIME_CDN_URL__ === "string"
    ? __HYPERFRAMES_RUNTIME_CDN_URL__
    : SAME_ORIGIN_RUNTIME_URL;
