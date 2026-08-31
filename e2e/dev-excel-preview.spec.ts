import { expect, test } from "@playwright/test";
import { chromium } from "playwright";

const EXCEL_PROJECT_ID = "d222d5a9-f36a-4213-80e6-ebb103b07af5";

test("development window renders the cited Excel rows", async ({}, testInfo) => {
  const endpoint = process.env.MYNOTEBOOKLM_E2E_DEV_CDP;
  test.skip(!endpoint, "set MYNOTEBOOKLM_E2E_DEV_CDP to the Electron remote debugging endpoint");
  if (!endpoint) return;
  const browser = await chromium.connectOverCDP(endpoint);
  const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith("http://localhost:5173"));
  expect(page).toBeTruthy();
  if (!page) return;
  const previousProject = await page.evaluate(() => localStorage.getItem("mynotebooklm.selectedProject"));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

  try {
    await page.evaluate((projectId) => localStorage.setItem("mynotebooklm.selectedProject", projectId), EXCEL_PROJECT_ID);
    await page.reload();
    const detailResult = await page.evaluate(async ({ projectId, citationId }) => {
      const api = (window as unknown as { myNotebook: { citations: { detail(input: { projectId: string; citationId: string }): Promise<any> } } }).myNotebook;
      const result = await api.citations.detail({ projectId, citationId });
      return result.ok ? {
        ok: true,
        kind: result.value.kind,
        byteLength: result.value.data?.byteLength ?? null,
        sheet: result.value.sheet ? { name: result.value.sheet.name, rows: result.value.sheet.rows.length, columns: result.value.sheet.columns.length } : null
      } : result;
    }, { projectId: EXCEL_PROJECT_ID, citationId: "d05abd91-00bd-4f23-8940-434346b97248:S1:210" });
    console.log("excel-detail", detailResult);
    const details = page.getByRole("button", { name: /查看原文|View source/ }).first();
    await expect(details).toBeVisible();
    await details.click();
    await page.waitForTimeout(500);
    console.log("excel-after-click", { dialogs: await page.locator("[role='dialog']").count(), errors });
    const dialog = page.getByRole("dialog", { name: /引用原文|Source excerpt/ });
    await expect(dialog).toBeVisible();
    console.log("excel-dialog", await dialog.innerText(), "errors", errors);
    const workbook = page.locator(".citation-workbook");
    await expect(workbook).toBeVisible({ timeout: 30_000 });
    console.log("excel-workbook", await workbook.evaluate((element) => element.innerHTML.slice(0, 2_000)));
    await expect(page.locator(".citation-sheet td").first()).toBeVisible({ timeout: 30_000 });
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("dev-citation-excel-rendered.png") });
  } finally {
    await page.evaluate((projectId) => {
      if (projectId) localStorage.setItem("mynotebooklm.selectedProject", projectId);
      else localStorage.removeItem("mynotebooklm.selectedProject");
    }, previousProject);
    await page.reload();
  }
});
