import { describe, expect, it } from "vitest";
import { stepRenderMode } from "../src/host/render-mode.ts";

describe("stepRenderMode (spec §12.2): pure function of (background, othersExecuting)", () => {
  it("streams inline when a foreground step runs alone", () => {
    expect(stepRenderMode(false, false)).toBe("inline");
  });

  it("renders compactly when a foreground step overlaps another step", () => {
    expect(stepRenderMode(false, true)).toBe("compact");
  });

  it("renders a background step compactly even when it runs alone", () => {
    expect(stepRenderMode(true, false)).toBe("compact");
  });

  it("renders a background step compactly when it also overlaps another step", () => {
    expect(stepRenderMode(true, true)).toBe("compact");
  });
});
