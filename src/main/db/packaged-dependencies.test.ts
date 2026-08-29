import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Regression contract for the packaged desktop build:
// electron-builder only walks regular "dependencies" into app.asar.
// @lancedb/lancedb declares apache-arrow as a peerDependency, so the app
// itself must list it, otherwise the packaged main process crashes with
// "Cannot find module 'apache-arrow'" before any window is created.
describe("packaged dependency closure", () => {
  it("declares lancedb runtime peer dependencies in app dependencies", () => {
    const pkgRoot = path.resolve(__dirname, "../../..");
    const appPkg = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
    const lancedbPkg = JSON.parse(
      readFileSync(path.join(pkgRoot, "node_modules", "@lancedb", "lancedb", "package.json"), "utf8")
    );
    const appDeps: Record<string, string> = appPkg.dependencies ?? {};
    const peers = Object.keys(lancedbPkg.peerDependencies ?? {}).filter(
      (name) => !name.startsWith("@types/")
    );
    expect(peers).toContain("apache-arrow");
    for (const peer of peers) {
      expect(appDeps, `peer dependency '${peer}' must be declared by the app`).toHaveProperty(peer);
    }
  });
});

