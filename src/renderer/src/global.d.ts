import type { DesktopApi } from "../../shared/ipc";

declare global {
  interface Window {
    myNotebook: DesktopApi;
  }
}

export {};
