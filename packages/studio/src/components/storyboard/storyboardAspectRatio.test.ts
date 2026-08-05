import { describe, expect, it } from "vitest";
import { storyboardAspectRatio } from "./storyboardAspectRatio";

describe("storyboardAspectRatio", () => {
  it("preserves a portrait storyboard canvas", () => {
    expect(storyboardAspectRatio("1080x1920")).toBe("1080 / 1920");
  });

  it("accepts whitespace and a multiplication sign", () => {
    expect(storyboardAspectRatio(" 1080 × 1350 ")).toBe("1080 / 1350");
  });

  it.each([undefined, "", "portrait", "0x1920", "1080x0"])(
    "falls back to 16:9 for %s",
    (format) => {
      expect(storyboardAspectRatio(format)).toBe("16 / 9");
    },
  );
});
