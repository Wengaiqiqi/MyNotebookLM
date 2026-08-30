import type { DesktopApi } from "../../../shared/ipc";

/**
 * The preload boundary exposes most IPC groups, but a handful (sources, tasks,
 * notes, transformations) only appear once the desktop service is ready. This
 * accessor is the single point that asserts availability so feature code does
 * not sprinkle optional chaining over every call.
 */
type RequiredApi = { [K in keyof DesktopApi]-?: NonNullable<DesktopApi[K]> };

export function api(): RequiredApi {
  if (typeof window === "undefined" || !window.myNotebook) {
    throw new Error("desktop-api-unavailable");
  }
  return window.myNotebook as RequiredApi;
}
