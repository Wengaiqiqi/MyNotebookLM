import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

async function launchWithUserData(
  userDataDir: string
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.resolve("out/main/index.js")],
    env: {
      ...process.env,
      NODE_ENV: "test",
      MYNOTEBOOKLM_USER_DATA_DIR: userDataDir
    }
  });
  return { app, page: await app.firstWindow() };
}

test("persists a project across desktop restarts", async ({}, testInfo) => {
  const userDataDir = testInfo.outputPath("user-data");
  await fs.mkdir(userDataDir, { recursive: true });

  const first = await launchWithUserData(userDataDir);
  try {
    expect(await first.app.evaluate(({ app }) => app.getPath("userData"))).toBe(userDataDir);
    expect(
      await first.app.evaluate(({ BrowserWindow, Menu }) => ({
        applicationMenu: Menu.getApplicationMenu(),
        menuBarVisible: BrowserWindow.getAllWindows()[0]?.isMenuBarVisible()
      }))
    ).toEqual({ applicationMenu: null, menuBarVisible: false });
    await first.page.getByRole("button", { name: "新建项目" }).first().click();
    await first.page.getByLabel("项目名称").fill("持久化测试");
    await first.page.getByRole("button", { name: "确认" }).click();
    await expect(first.page.getByText("持久化测试").first()).toBeVisible();
  } finally {
    await first.app.close();
  }

  const second = await launchWithUserData(userDataDir);
  try {
    await expect(second.page.getByText("持久化测试").first()).toBeVisible();
    await second.page.screenshot({ path: testInfo.outputPath("restart-persistence.png") });
  } finally {
    await second.app.close();
  }
});

test("centers dialogs in the full viewport before and after resizing", async ({}, testInfo) => {
  const userDataDir = testInfo.outputPath("user-data");
  await fs.mkdir(userDataDir, { recursive: true });
  const { app, page } = await launchWithUserData(userDataDir);
  try {
    await page.locator(".create-button").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const expectViewportCenter = async (): Promise<void> => {
      const bounds = await dialog.boundingBox();
      const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      if (!bounds) throw new Error("Missing dialog bounds");
      expect(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2);
      expect(Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(2);
    };

    await expectViewportCenter();
    const originalViewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 780));
    await page.waitForFunction((previous) => (
      window.innerWidth !== previous.width || window.innerHeight !== previous.height
    ), originalViewport);
    await expectViewportCenter();
  } finally {
    await app.close();
  }
});
