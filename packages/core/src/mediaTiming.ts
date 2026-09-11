export const MEDIA_START_BASIS_ATTR = "data-hf-media-start-basis";

export type MediaStartBasis = "local" | "global";

export function readMediaStartBasis(value: string | null | undefined): MediaStartBasis {
  return value?.trim().toLowerCase() === "global" ? "global" : "local";
}

/** Resolve authored media time onto the root timeline. Nested media is local
 * by default; only an explicit compatibility marker preserves a legacy
 * root-global value. */
export function resolveAbsoluteMediaStartSeconds(input: {
  authoredStart: number;
  hostStart: number;
  basis?: string | null;
}): number {
  return readMediaStartBasis(input.basis) === "global"
    ? input.authoredStart
    : input.hostStart + input.authoredStart;
}
