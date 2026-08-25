import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const window = {
    once: vi.fn(),
    show: vi.fn(),
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

vi.mock("electron", () => ({ BrowserWindow: mocks.BrowserWindow }));

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
      webPreferences: expect.objectContaining({
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      })
    }));
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
