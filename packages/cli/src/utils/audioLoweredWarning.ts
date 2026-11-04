/** In the Tabario fork, audioLoweredDb measures the true-peak reduction from limiting. */
export function audioLoweredWarning(
  audioLoweredDb: number | undefined,
): { code: string; message: string } | null {
  if (audioLoweredDb === undefined) return null;
  return {
    code: "audio_lowered",
    message:
      `Audio true peak reduced ${audioLoweredDb.toFixed(1)} dB by the delivery limiter. ` +
      "Quiet passages retain their level; no flat gain reduction was applied to the whole mix.",
  };
}
