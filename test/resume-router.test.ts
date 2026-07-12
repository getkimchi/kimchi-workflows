import { describe, expect, it } from "vitest";
import { resumeAction } from "../src/host/resume-router.ts";

describe("resumeAction routing (pure, spec §5.2)", () => {
  it("routes a parked run to the answer path", () => {
    expect(resumeAction("parked")).toEqual({ kind: "answer" });
  });

  it("routes crashed and cancelled runs to the node-atomic re-run path", () => {
    expect(resumeAction("crashed")).toEqual({ kind: "rerun" });
    expect(resumeAction("cancelled")).toEqual({ kind: "rerun" });
  });

  it("routes completed and running runs to an error", () => {
    expect(resumeAction("completed").kind).toBe("error");
    expect(resumeAction("running").kind).toBe("error");
  });
});
