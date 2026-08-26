import { describe, expect, it } from "vitest";
import { getAppPaths } from "./paths";

describe("getAppPaths", () => {
  it("keeps mutable data beneath Electron userData", () => {
    expect(getAppPaths("C:\\Users\\Ada\\AppData\\Roaming\\MyNotebookLM")).toEqual({
      root: "C:\\Users\\Ada\\AppData\\Roaming\\MyNotebookLM",
      database: "C:\\Users\\Ada\\AppData\\Roaming\\MyNotebookLM\\data\\app.db",
      files: "C:\\Users\\Ada\\AppData\\Roaming\\MyNotebookLM\\files",
      models: "C:\\Users\\Ada\\AppData\\Roaming\\MyNotebookLM\\models\\huggingface",
      logs: "C:\\Users\\Ada\\AppData\\Roaming\\MyNotebookLM\\logs"
    });
  });
});
