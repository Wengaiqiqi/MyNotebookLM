import { describe, expect, it } from "vitest";
import { throttleProgress } from "./ingestion-service";

describe("ingestion progress", () => {
  it("emits at most ten progress events per task per second", () => {
    const emitted: number[] = [];
    const send = throttleProgress("task", (value) => emitted.push(value), () => 1000);
    for (let i = 0; i < 20; i++) send(i);
    expect(emitted).toHaveLength(10);
  });
});
