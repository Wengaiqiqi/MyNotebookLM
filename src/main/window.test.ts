import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const window = {
    once: vi.fn(),
    show: vi.fn(),
    setIcon: vi.fn(),
    setTitleBarOverlay: vi.fn(),
    webContents: {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn()
    },
    loadFile: vi.fn(),
    loadURL: vi.fn()
  };

  return {
    window,
    BrowserWindow: Object.assign(vi.fn(function () { return window; }), {
      fromWebContents: vi.fn(() => window)
    })
  };
});

vi.mock("electron", () => ({ app: { isPackaged: false }, BrowserWindow: mocks.BrowserWindow, shell: { openExternal: vi.fn(async () => undefined) } }));

describe("createMainWindow", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.ELECTRON_RENDERER_URL;
  });

  it("embeds native title controls while retaining secure renderer preferences", async () => {
    const { createMainWindow } = await import("./window");

    createMainWindow();

    expect(mocks.BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({
      titleBarStyle: "hidden",
      titleBarOverlay: expect.objectContaining({ color: "#f7f5f0", symbolColor: "#24231f" }),
      icon: expect.stringMatching(/[\\/]build[\\/]icon\.ico$/),
      webPreferences: expect.objectContaining({
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      })
    }));
    expect(mocks.window.setIcon).toHaveBeenCalledWith(expect.stringMatching(/[\\/]build[\\/]icon\.ico$/));
  });

  it("denies new windows and opens only safe web links in the system browser", async () => {
    const { createMainWindow, openExternalLink } = await import("./window");
    createMainWindow();
    const handler = mocks.window.webContents.setWindowOpenHandler.mock.calls[0]![0] as (details: { url: string }) => unknown;
    expect(handler({ url: "https://example.com/a" })).toEqual({ action: "deny" });

    const open = vi.fn(async () => undefined);
    openExternalLink("https://example.com/a?b=1", open);
    openExternalLink("javascript:alert(1)", open);
    openExternalLink("file:///C:/Windows/System32/calc.exe", open);
    openExternalLink("http://127.0.0.1:8080/", open);
    expect(open).toHaveBeenCalledExactlyOnceWith("https://example.com/a?b=1");
  });

  it("validates and cleans up the versioned title-overlay IPC operation", async () => {
    const ipc = { handle: vi.fn(), removeHandler: vi.fn() };
    const module = await import("./window") as unknown as {
      registerTitleOverlayHandler?: (ipcMain: typeof ipc) => () => void;
    };

    const cleanup = module.registerTitleOverlayHandler?.(ipc);

    expect(ipc.handle).toHaveBeenCalledExactlyOnceWith("window:v1:set-title-overlay", expect.any(Function));
    const handler = ipc.handle.mock.calls[0]?.[1] as ((event: { sender: unknown }, input: unknown) => unknown);
    await expect(handler({ sender: {} }, { theme: "dark" })).resolves.toEqual({ ok: true, value: undefined });
    await expect(handler({ sender: {} }, { theme: "neon" })).resolves.toEqual({
      ok: false,
      error: { code: "VALIDATION", messageKey: "errors.validation", recoverable: false }
    });
    expect(mocks.window.setTitleBarOverlay).toHaveBeenCalledWith({ color: "#191a1d", symbolColor: "#f3f0e9" });

    cleanup?.();
    expect(ipc.removeHandler).toHaveBeenCalledExactlyOnceWith("window:v1:set-title-overlay");
  });
});
