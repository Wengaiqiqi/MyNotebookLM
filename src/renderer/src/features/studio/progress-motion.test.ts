import { describe, expect, it } from "vitest";
import { advancePercent, advancePodcastPercent, progressCeiling, progressPhase } from "./progress-motion";

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
  it("caps the displayed number at the reported milestone", () => {
    expect(progressCeiling(0)).toBe(50);
    expect(progressCeiling(20)).toBe(50);
    expect(progressCeiling(40)).toBe(99);
    expect(progressCeiling(80)).toBe(99);
    expect(progressCeiling(100)).toBe(100);
  });

  it("reaches 20% in exactly four seconds from zero", () => {
    let value = 0;
    for (let step = 0; step < 40; step += 1) value = advancePercent(value, progressCeiling(20), 100);
    expect(value).toBe(20);
    expect(value).toBeLessThan(20.01);
  });

  it("adds 4% per second while the model responds and holds at 50%", () => {
    let value = 20;
    for (let step = 0; step < 50; step += 1) value = advancePercent(value, progressCeiling(20), 100);
    expect(value).toBeCloseTo(40, 6);
    expect(advancePercent(value, progressCeiling(20), 60_000)).toBe(50);
    expect(advancePercent(50, progressCeiling(20), 60_000)).toBe(50);
  });

  it("catches up to 50%, keeps the generation rate, then finalizes at 1% per second", () => {
    for (const start of [0, 20, 48]) {
      let value = start;
      let elapsed = 0;
      while (value < 50 && elapsed < 2_000) {
        value = advancePercent(value, progressCeiling(40), 100);
        elapsed += 100;
      }
      expect(value).toBe(50);
      expect(elapsed).toBeLessThanOrEqual(2_000);
    }
    let value = 50;
    for (let step = 0; step < 50; step += 1) value = advancePercent(value, progressCeiling(40), 100);
    expect(value).toBeCloseTo(80, 6);
    expect(advancePercent(50, 80, 1_000)).toBe(56);
    expect(advancePercent(80, 99, 1_000)).toBe(81);
    expect(advancePercent(79.6, 99, 1_000)).toBeCloseTo(80.6);
    expect(advancePercent(80, 99, 19_000)).toBe(99);
    expect(advancePercent(99, 99, 60_000)).toBe(99);
    expect(advancePercent(99, 40, 1_000)).toBe(99);
    expect(advancePercent(50, 60, 10_000)).toBe(60);
  });

  it("starts generating on a response and finalizing at the visible 80%", () => {
    expect(progressPhase(0, 0)).toBe("preparing");
    expect(progressPhase(12, 20)).toBe("preparing");
    expect(progressPhase(20, 20)).toBe("connecting");
    expect(progressPhase(30, 40)).toBe("generating");
    expect(progressPhase(30, 80)).toBe("generating");
    expect(progressPhase(79, 80)).toBe("generating");
    expect(progressPhase(79.6, 40)).toBe("saving");
    expect(progressPhase(80, 40)).toBe("saving");
  });
});
