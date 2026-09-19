import { describe, expect, it } from "vitest";
import { advancePercent, progressCeiling, progressPhase } from "./progress-motion";

describe("progress motion", () => {
  it("caps the displayed number at the reported milestone", () => {
    expect(progressCeiling(0)).toBe(20);
    expect(progressCeiling(20)).toBe(20);
    expect(progressCeiling(40)).toBe(80);
    expect(progressCeiling(80)).toBe(99);
    expect(progressCeiling(100)).toBe(100);
  });

  it("reaches 20% in exactly four seconds from zero", () => {
    let value = 0;
    for (let step = 0; step < 40; step += 1) value = advancePercent(value, 20, 100);
    expect(value).toBe(20);
    expect(value).toBeLessThan(20.01);
  });

  it("crosses 20 -> 80 in ten seconds and never regresses", () => {
    let value = 20;
    for (let step = 0; step < 100; step += 1) value = advancePercent(value, 80, 100);
    expect(value).toBeCloseTo(80, 6);
    // Nine seconds is not enough, so the span really takes ten.
    expect(advancePercent(20, 80, 9_000)).toBeLessThan(80);
    expect(advancePercent(20, 80, 5_000)).toBeCloseTo(50, 5);
    expect(advancePercent(40, 99, 5_000)).toBeCloseTo(70, 5);
    expect(advancePercent(99, 40, 1_000)).toBe(99);
    expect(advancePercent(50, 60, 10_000)).toBe(60);
  });

  it("keeps preparing readable for the climb, then follows the milestone", () => {
    expect(progressPhase(0, 0)).toBe("preparing");
    expect(progressPhase(12, 20)).toBe("preparing");
    expect(progressPhase(20, 20)).toBe("connecting");
    expect(progressPhase(30, 40)).toBe("generating");
    expect(progressPhase(30, 80)).toBe("saving");
  });
});
