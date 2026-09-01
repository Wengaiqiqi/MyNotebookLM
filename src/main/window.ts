import { app, BrowserWindow, type IpcMain } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { internalFailure, validationFailure } from "../shared/app-errors";
import { TITLE_OVERLAY_CHANNELS } from "../shared/ipc";
import { appThemeSchema, type AppTheme } from "../shared/settings";

const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
const rendererFile = path.join(__dirname, "../renderer/index.html");
const packagedRendererUrl = pathToFileURL(rendererFile).toString();
const windowIcon = app.isPackaged
  ? path.join(process.resourcesPath, "icon.ico")
  : path.resolve(__dirname, "../../build/icon.ico");
const titleOverlayInputSchema = z.object({ theme: appThemeSchema }).strict();
const lightTitleOverlay = { color: "#f7f5f0", symbolColor: "#24231f" } as const;
const darkTitleOverlay = { color: "#191a1d", symbolColor: "#f3f0e9" } as const;

type IpcMainLike = Pick<IpcMain, "handle" | "removeHandler">;

function titleOverlayFor(theme: AppTheme) {
  return theme === "dark" ? darkTitleOverlay : lightTitleOverlay;
}

function isAllowedNavigation(url: string): boolean {
  if (rendererUrl) {
    return new URL(url).origin === new URL(rendererUrl).origin;
  }

  return url === packagedRendererUrl;
}

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    titleBarStyle: "hidden",
    titleBarOverlay: lightTitleOverlay,
    icon: windowIcon,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  window.setIcon(windowIcon);
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });

  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(rendererFile);
  }

  return window;
}

export function registerTitleOverlayHandler(ipc: IpcMainLike): () => void {
  ipc.handle(TITLE_OVERLAY_CHANNELS.setTheme, async (event, input) => {
    const parsed = titleOverlayInputSchema.safeParse(input);
    if (!parsed.success) return validationFailure();
    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) return internalFailure();
      window.setTitleBarOverlay(titleOverlayFor(parsed.data.theme));
      return { ok: true as const, value: undefined };
    } catch {
      return internalFailure();
    }
  });

  return () => ipc.removeHandler(TITLE_OVERLAY_CHANNELS.setTheme);
}
