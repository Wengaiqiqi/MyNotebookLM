import { contextBridge, ipcRenderer } from "electron";
import { createDesktopApi } from "./create-desktop-api";

contextBridge.exposeInMainWorld("myNotebook", Object.freeze(createDesktopApi(ipcRenderer)));
