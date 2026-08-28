import type { DesktopApi } from "../../shared/ipc";

declare global {
  /** Includes the notes, transformations and model-routing groups exposed by the preload boundary. */
  interface Window {
    myNotebook: DesktopApi;
  }
}

export {};
