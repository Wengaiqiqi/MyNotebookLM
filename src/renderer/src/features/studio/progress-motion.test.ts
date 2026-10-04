import { describe, expect, it } from "vitest";
import { advanceMindMapPercent, advancePodcastPercent, mindMapStepProgress, textStepProgress } from "./progress-motion";
import type { CatchUp } from "./progress-motion";

describe("progress motion", () => {
  it("animates only the first three seconds of podcast preparation even when the provider responds quickly", () => {
    expect(advancePodcastPercent(0, 20, 0)).toBe(0);
    expect(advancePodcastPercent(0, 20, 1500)).toBe(10);
    expect(advancePodcastPercent(10, 45, 2900)).toBeCloseTo(19.333333);
    expect(advancePodcastPercent(19, 45, 3000)).toBe(20);
    expect(advancePodcastPercent(20, 45, 3100)).toBe(45);
    expect(advancePodcastPercent(45, 45, 60_000)).toBe(45);
    expect(advancePodcastPercent(70, 45, 60_000)).toBe(70);
  });
  it("maps text milestones to steps", () => {
    expect(textStepProgress("preparing", 0).index).toBe(0);
    expect(textStepProgress("generating", 200).index).toBe(1);
    expect(textStepProgress("generating", 400).index).toBe(2);
    expect(textStepProgress("saving", 800).index).toBe(3);
    expect(textStepProgress("generating", 400).steps).toEqual(["preparing", "connecting", "generating", "saving"]);
  });

  it("maps each map stage to its step", () => {
    expect(mindMapStepProgress("preparing").index).toBe(0);
    expect(mindMapStepProgress("generating").index).toBe(1);
    expect(mindMapStepProgress("verifying").index).toBe(2);
    expect(mindMapStepProgress("saving").index).toBe(3);
  });

  const run = (start: number, stageIndex: number, ms: number, catchUp: CatchUp = null) => {
    let state = { percent: start, catchUp };
    for (let t = 0; t < ms; t += 100) state = advanceMindMapPercent(state.percent, stageIndex, 100, state.catchUp);
    return state;
  };

  it("creeps 1% per second and waits at the stage limit", () => {
    expect(run(0, 0, 10_000).percent).toBeCloseTo(10);
    expect(run(0, 0, 60_000).percent).toBe(25);
    expect(run(30, 1, 60_000).percent).toBe(50);
    expect(run(80, 3, 60_000).percent).toBe(99);
  });

  it("rises to a finished stage's limit within two seconds, then creeps again", () => {
    expect(run(5, 1, 1_000).percent).toBeCloseTo(15);
    expect(run(5, 1, 2_000).percent).toBe(25);
    expect(run(5, 1, 3_000).percent).toBeCloseTo(26);
    // Several stages at once still take two seconds.
    expect(run(5, 3, 2_000).percent).toBe(75);
    // A stage reported during catch-up restarts the two seconds toward the new limit.
    const half = run(0, 1, 1_000);
    expect(half.percent).toBeCloseTo(12.5);
    expect(run(half.percent, 2, 2_000, half.catchUp).percent).toBe(50);
  });
});
