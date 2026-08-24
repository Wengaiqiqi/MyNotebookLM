import { app, BrowserWindow } from "electron";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { type AppDatabase, openAppDatabase } from "./db/database";
import { getAppPaths } from "./platform/paths";
import { createMainWindow } from "./window";

let appDatabase: AppDatabase | undefined;

app.whenReady().then(async () => {
  const appPaths = getAppPaths(app.getPath("userData"));
  await Promise.all([
    mkdir(appPaths.root, { recursive: true }),
    mkdir(path.dirname(appPaths.database), { recursive: true }),
    mkdir(appPaths.files, { recursive: true }),
    mkdir(appPaths.logs, { recursive: true })
  ]);
  const migrationsDir = app.isPackaged
    ? path.join(process.resourcesPath, "migrations")
    : path.join(app.getAppPath(), "src", "main", "db", "migrations");
  appDatabase = openAppDatabase(appPaths.database, migrationsDir);

  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("before-quit", () => {
  appDatabase?.close();
  appDatabase = undefined;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
