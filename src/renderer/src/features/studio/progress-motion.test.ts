import { describe, expect, it } from "vitest";
import { advancePercent, progressCeiling, progressPhase } from "./progress-motion";

describe("progress motion", () => {
  it("caps the displayed number at the reported milestone", () => {
    expect(progressCeiling(0)).toBe(50);
    expect(progressCeiling(20)).toBe(50);
    expect(progressCeiling(40)).toBe(80);
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

  it("catches up to 50% within two seconds, then keeps the existing rates and caps", () => {
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
    for (let step = 0; step < 50; step += 1) value = advancePercent(value, 80, 100);
    expect(value).toBeCloseTo(80, 6);
    expect(advancePercent(50, 80, 1_000)).toBe(56);
    expect(advancePercent(80, 99, 1_000)).toBe(99);
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
