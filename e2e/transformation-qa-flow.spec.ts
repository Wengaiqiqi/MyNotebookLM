import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { closeElectron, createProject, launchWithUserData, seedTextSource, skipOnboarding, startFakeOpenAi } from "./helpers/task9";

type Task = { id: string; kind: string; state: string; error?: { code?: string } | null };

async function waitForTask(page: import("playwright").Page, projectId: string, taskId: string): Promise<void> {
  await expect.poll(async () => page.evaluate(async ({ projectId, taskId }) => {
    const tasks = await (window as any).myNotebook.tasks.list({ projectId }) as Task[];
    const task = tasks.find((item) => item.id === taskId);
    if (task?.state === "failed") throw new Error(`transformation failed: ${task.error?.code ?? "unknown"}`);
    return task?.state;
  }, { projectId, taskId }), { timeout: 60_000 }).toBe("completed");
}

test("runs Q&A transformation from the UI and reloads the saved insight", async () => {
  test.setTimeout(120_000);
  const userDataDir = await fs.mkdtemp(path.join(tmpdir(), "mynotebooklm-qa-flow-"));
  const provider = await startFakeOpenAi();
  let app: import("playwright").ElectronApplication | undefined;
  try {
    const first = await launchWithUserData(userDataDir);
    app = first.app;
    await skipOnboarding(first.page);
    const projectId = await createProject(first.page, "Q&A flow");
    await closeElectron(first.app);
    app = undefined;

    const seeded = await seedTextSource(userDataDir, projectId, "qa-source.txt", "alpha source evidence");
    const second = await launchWithUserData(userDataDir);
    app = second.app;
    const setup = await second.page.evaluate(async ({ projectId, baseUrl }) => {
      const api = (window as any).myNotebook;
      const profileId = crypto.randomUUID();
      const profile = await api.models.saveProfile({ profile: { id: profileId, name: "Q&A test", provider: "openai-compatible", capability: "generation", baseUrl, modelId: "gpt-e2e", enabled: true }, apiKey: "qa-key" });
      if (!profile.ok) throw new Error(`profile: ${profile.error.code}`);
      const route = await api.models.saveRoutes({ taskKind: "chat", profileIds: [profileId] });
      if (!route.ok) throw new Error(`route: ${route.error.code}`);
      return { qaRoute: await api.models.getRoutes({ taskKind: "qa" }) };
    }, { projectId, baseUrl: provider.baseUrl });
    expect(setup.qaRoute).toMatchObject({ ok: true, value: [] });

    await second.page.getByRole("tab", { name: "转换", exact: true }).click();
    await expect(second.page.getByRole("heading", { name: "运行转换" })).toBeVisible();
    await second.page.getByRole("button", { name: "规则", exact: true }).click();
    await second.page.getByRole("option", { name: "问答" }).click();
    await second.page.getByRole("button", { name: "来源" }).click();
    await second.page.getByRole("option", { name: "qa-source.txt" }).click();
    const run = second.page.getByRole("button", { name: "运行转换" });
    await expect(run).toBeEnabled();
    await run.click();

    const taskId = await second.page.evaluate(async ({ projectId }) => {
      const tasks = await (window as any).myNotebook.tasks.list({ projectId }) as Task[];
      const task = tasks.find((item) => item.kind === "transformation");
      if (!task) throw new Error("transformation task missing");
      return task.id;
    }, { projectId });
    await waitForTask(second.page, projectId, taskId);
    const saved = await second.page.evaluate(async ({ projectId }) => {
      const result = await (window as any).myNotebook.transformations.listInsights({ projectId });
      if (!result.ok) throw new Error(`insights: ${result.error.code}`);
      return result.value;
    }, { projectId });
    expect(saved).toEqual(expect.arrayContaining([expect.objectContaining({ taskId, inputKind: "source", content: "Grounded alpha answer [S1]" })]));
    await closeElectron(second.app);
    app = undefined;

    const restarted = await launchWithUserData(userDataDir);
    app = restarted.app;
    await restarted.page.getByRole("tab", { name: "转换", exact: true }).click();
    await expect(restarted.page.getByText("Grounded alpha answer [S1]")).toBeVisible();
    const persisted = await restarted.page.evaluate(async ({ projectId, taskId }) => {
      const result = await (window as any).myNotebook.transformations.listInsights({ projectId });
      if (!result.ok) throw new Error(`reloaded insights: ${result.error.code}`);
      return result.value.some((item: { taskId: string; content: string }) => item.taskId === taskId && item.content === "Grounded alpha answer [S1]");
    }, { projectId, taskId });
    expect(persisted).toBe(true);
    void seeded;
  } finally {
    if (app) await closeElectron(app);
    await provider.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
