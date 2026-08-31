import { expect, test } from "@playwright/test";
import { chromium } from "playwright";

test("development window renders the cited PDF without a white screen", async ({}, testInfo) => {
  const endpoint = process.env.MYNOTEBOOKLM_E2E_DEV_CDP;
  test.skip(!endpoint, "set MYNOTEBOOKLM_E2E_DEV_CDP to the Electron remote debugging endpoint");
  if (!endpoint) return;
  const browser = await chromium.connectOverCDP(endpoint);
  const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith("http://localhost:5173"));
  expect(page).toBeTruthy();
  if (!page) return;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

  await expect(page.locator(".app[data-view='app']")).toBeVisible();
  await expect(page.locator("body")).not.toHaveText("");
  const project = page.locator(".project-item", { hasText: "213" });
  const projectButton = project.locator(".project-item-btn");
  if (await projectButton.getAttribute("aria-current") !== "page") {
    await projectButton.evaluate((button: HTMLButtonElement) => button.click());
    await expect(projectButton).toHaveAttribute("aria-current", "page");
  }
  const details = page.getByRole("button", { name: /查看原文|View source/ }).first();
  await expect(details).toBeVisible();
  await details.click();
  const canvas = page.locator(".citation-pdf-page canvas");
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute("aria-busy", "false");
  await expect(canvas).toHaveCount(1);
  await expect(page.locator(".citation-pdf button")).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("dev-citation-pdf-rendered.png") });
});
