import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const window = {
    once: vi.fn(),
    show: vi.fn(),
    webContents: {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn()
    },
    loadFile: vi.fn(),
    loadURL: vi.fn()
  };

  return {
    window,
    BrowserWindow: vi.fn(function () { return window; })
  };
});

vi.mock("electron", () => ({ BrowserWindow: mocks.BrowserWindow }));

describe("createMainWindow", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.ELECTRON_RENDERER_URL;
  });

  it("keeps the native framed Windows title bar", async () => {
    const { createMainWindow } = await import("./window");

    createMainWindow();

    expect(mocks.BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({ frame: true }));
  });
});
