import { describe, expect, it } from "vitest";
import { localShareEnabled } from "./shareBoundary.js";

// Tabario fork (TAB-1337): sharing publishes to hyperframes.dev, so it stays off unless opted in.
describe("localShareEnabled", () => {
  it("is off when the variable is unset", () => {
    expect(localShareEnabled({})).toBe(false);
  });

  it("is off for any value other than 1", () => {
    for (const value of ["", "0", "true", "yes", "on"]) {
      expect(localShareEnabled({ HYPERFRAMES_LOCAL_SHARE: value })).toBe(false);
    }
  });

  it("is on only for 1", () => {
    expect(localShareEnabled({ HYPERFRAMES_LOCAL_SHARE: "1" })).toBe(true);
    expect(localShareEnabled({ HYPERFRAMES_LOCAL_SHARE: " 1 " })).toBe(true);
  });
});
