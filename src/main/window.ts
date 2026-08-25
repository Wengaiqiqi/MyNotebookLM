import { BrowserWindow } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
const rendererFile = path.join(__dirname, "../renderer/index.html");
const packagedRendererUrl = pathToFileURL(rendererFile).toString();

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
    frame: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

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
