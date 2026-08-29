import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  closeElectron,
  createProject,
  launchWithUserData,
  skipOnboarding,
  startFakeOpenAi
} from "./helpers/task9";

test("renderer sandbox blocks node access, window-open and cross-origin navigation", async () => {
  test.setTimeout(90_000);
  const userDataDir = await fs.mkdtemp(path.join(tmpdir(), "mynotebooklm-sec-"));
  await fs.mkdir(userDataDir, { recursive: true });
  let app: import("playwright").ElectronApplication | undefined;
  try {
    const { app: launched, page } = await launchWithUserData(userDataDir);
    app = launched;
    await skipOnboarding(page);

    // Preload rejection: no require, no process, no node integration.
    const sandbox = await page.evaluate(() => ({
      typeofRequire: typeof (window as any).require,
      typeofProcess: typeof (window as any).process,
      typeofMyNotebook: typeof (window as any).myNotebook
    }));
    expect(sandbox.typeofRequire).toBe("undefined");
    expect(sandbox.typeofProcess).toBe("undefined");
    expect(sandbox.typeofMyNotebook).toBe("object");

    // Window-open denial: no new Electron window appears.
    const before = await app.windows().length;
    await page.evaluate(() => { window.open("https://example.com/", "_blank"); });
    await page.waitForTimeout(500);
    expect(app.windows().length).toBe(before);

    // Navigation denial: will-navigate preventDefault keeps the app on the renderer origin.
    const navigated = await page.evaluate(async () => {
      const before = location.href;
      location.href = "https://example.com/";
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { before, after: location.href };
    });
    expect(navigated.after).toBe(navigated.before);
    await closeElectron(app);
    app = undefined;
  } finally {
    if (app) await closeElectron(app);
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("stored credentials stay masked and never reach the renderer", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const userDataDir = await fs.mkdtemp(path.join(tmpdir(), "mynotebooklm-sec-"));
  await fs.mkdir(userDataDir, { recursive: true });
  const provider = await startFakeOpenAi();
  let app: import("playwright").ElectronApplication | undefined;
  try {
    const { app: launched, page } = await launchWithUserData(userDataDir);
    app = launched;
    await skipOnboarding(page);
    const secret = "e2e-super-secret-key-42";
    const saved = await page.evaluate(async ({ baseUrl, secret }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      const result = await api.models.saveProfile({
        profile: { id: crypto.randomUUID(), name: "Secret probe", provider: "openai-compatible", capability: "generation", baseUrl, modelId: "gpt-e2e", enabled: true },
        apiKey: secret
      });
      if (!result.ok) return result;
      const profiles = await api.models.listProfiles();
      return { ok: true, profiles: profiles.value ?? profiles };
    }, { baseUrl: provider.baseUrl, secret });
    expect(saved.ok).toBe(true);
    const serialized = JSON.stringify(saved);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("apiKey");
    await closeElectron(app);
    app = undefined;
  } finally {
    if (app) await closeElectron(app);
    await provider.close().catch(() => undefined);
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("URL import rejects loopback SSRF targets", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const userDataDir = await fs.mkdtemp(path.join(tmpdir(), "mynotebooklm-sec-"));
  await fs.mkdir(userDataDir, { recursive: true });
  let app: import("playwright").ElectronApplication | undefined;
  try {
    const { app: launched, page } = await launchWithUserData(userDataDir);
    app = launched;
    await skipOnboarding(page);
    const projectId = await createProject(page, "SSRF Guard");
    const rejected = await page.evaluate(async ({ projectId }) => {
      const api = (window as unknown as { myNotebook: any }).myNotebook;
      return api.sources.importUrl({ projectId, url: "http://127.0.0.1:9/secret" });
    }, { projectId });
    expect(rejected.ok).toBe(false);
    expect(rejected.error.code).toBe("UNSAFE_INPUT");
    await closeElectron(app);
    app = undefined;
  } finally {
    if (app) await closeElectron(app);
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
