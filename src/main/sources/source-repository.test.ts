import { describe, expect, it } from "vitest";
import { SourceRepository } from "./source-repository";

describe("source repository", () => {
  it("exposes safe unique storage names", () => {
    const repository = new SourceRepository();
    expect(repository.storageName("source", "revision")).toBe("source/revision/source-revision");
  });
});
