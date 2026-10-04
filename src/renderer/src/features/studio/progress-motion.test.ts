import { describe, expect, it } from "vitest";
import { advancePodcastPercent, mindMapStepProgress, textStepProgress } from "./progress-motion";

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
  it("maps text milestones to steps without inventing a fraction", () => {
    expect(textStepProgress("preparing", 0)).toMatchObject({ index: 0, fraction: null });
    expect(textStepProgress("generating", 200)).toMatchObject({ index: 1, fraction: null });
    expect(textStepProgress("generating", 400)).toMatchObject({ index: 2, fraction: null });
    expect(textStepProgress("saving", 800)).toMatchObject({ index: 3, fraction: null });
    expect(textStepProgress("generating", 400).steps).toEqual(["preparing", "connecting", "generating", "saving"]);
  });

  it("follows the actual map stage and only measures input preparation", () => {
    expect(mindMapStepProgress("preparing", 0)).toMatchObject({ index: 0, fraction: null });
    expect(mindMapStepProgress("preparing", 100)).toMatchObject({ index: 0, fraction: 0 });
    expect(mindMapStepProgress("preparing", 225)).toMatchObject({ index: 0, fraction: 0.5 });
    expect(mindMapStepProgress("preparing", 350)).toMatchObject({ index: 0, fraction: 1 });
    expect(mindMapStepProgress("generating", 550)).toMatchObject({ index: 1, fraction: null });
    expect(mindMapStepProgress("verifying", 900)).toMatchObject({ index: 2, fraction: null });
    expect(mindMapStepProgress("saving", 980)).toMatchObject({ index: 3, fraction: null });
  });
});
