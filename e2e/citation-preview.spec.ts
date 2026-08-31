import { expect, test } from "@playwright/test";
import path from "node:path";
import { _electron as electron } from "playwright";

test("current profile opens a cited PDF without blanking the renderer", async ({}, testInfo) => {
  const userDataDir = process.env.MYNOTEBOOKLM_E2E_PROFILE;
  test.skip(!userDataDir, "set MYNOTEBOOKLM_E2E_PROFILE to an isolated profile copy");
  if (!userDataDir) return;
  const app = await electron.launch({
    args: [path.resolve("out/main/index.js")],
    env: { ...process.env, NODE_ENV: "test", ELECTRON_ENABLE_LOGGING: "1", MYNOTEBOOKLM_USER_DATA_DIR: userDataDir }
  });
  const errors: string[] = [];
  app.on("window", (window) => {
    window.on("pageerror", (error) => errors.push(error.stack ?? error.message));
    window.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  });
  const page = await app.firstWindow();
  console.log("electron-user-data", await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData")));

  try {
    await expect(page.locator(".app")).toBeVisible();
    await page.waitForTimeout(1_000);
    const state = await page.evaluate(() => ({ text: document.body.innerText, html: document.body.innerHTML.slice(0, 1_000) }));
    console.log("renderer-state", JSON.stringify(state));
    expect(state.text.trim()).not.toBe("");
    expect(errors).toEqual([]);
    expect(state.html).not.toContain('data-view="onboarding"');
    const project = page.locator(".project-item", { hasText: "213" });
    const projectButton = project.locator(".project-item-btn");
    if (await projectButton.getAttribute("aria-current") !== "page") {
      await projectButton.evaluate((button: HTMLButtonElement) => button.click());
      await expect(projectButton).toHaveAttribute("aria-current", "page");
    }
    const details = page.getByRole("button", { name: /查看原文|View source/ }).first();
    await expect(details).toBeVisible();
    await details.click();
    await expect(page.getByRole("dialog", { name: /引用原文|Source excerpt/ })).toBeVisible();
    const canvas = page.locator(".citation-pdf-page canvas");
    await expect(canvas).toBeVisible();
    await expect(canvas).toHaveAttribute("aria-busy", "false");
    await expect.poll(() => canvas.evaluate((element) => {
      const target = element as HTMLCanvasElement;
      return target.width > 0 && target.height > 0;
    })).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("citation-pdf-rendered.png") });
  } finally {
    await app.close();
  }
});
