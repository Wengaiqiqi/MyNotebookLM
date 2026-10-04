import { describe, expect, it } from "vitest";
import path from "node:path";
import { getAppPaths } from "./paths";

describe("getAppPaths", () => {
  it("keeps mutable data beneath Electron userData", () => {
    const root = path.join(path.sep, "Users", "Ada", "AppData", "Roaming", "MyNotebookLM");
    expect(getAppPaths(root)).toEqual({
      root,
      database: path.join(root, "data", "app.db"),
      files: path.join(root, "files"),
      models: path.join(root, "models", "huggingface"),
      logs: path.join(root, "logs")
    });
  });
});
