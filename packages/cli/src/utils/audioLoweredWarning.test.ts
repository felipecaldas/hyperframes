import { describe, expect, it } from "vitest";
import { audioLoweredWarning } from "./audioLoweredWarning";

describe("audioLoweredWarning", () => {
  it("reports the fork's peak reduction without claiming a whole-mix cut", () => {
    const warning = audioLoweredWarning(7.3);
    expect(warning?.code).toBe("audio_lowered");
    expect(warning?.message).toContain("true peak reduced 7.3 dB");
    expect(warning?.message).toContain("Quiet passages retain their level");
  });

  it("says nothing when no peak correction was needed", () => {
    expect(audioLoweredWarning(undefined)).toBeNull();
  });
});
