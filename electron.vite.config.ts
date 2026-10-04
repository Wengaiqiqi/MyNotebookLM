import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

// Packaged builds load from file://, where response headers cannot carry a
// policy, so the CSP ships as a meta tag. Dev keeps Vite's inline HMR preamble.
const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ");

function rendererCsp(): Plugin {
  return {
    name: "renderer-csp",
    apply: "build",
    transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: RENDERER_CSP }, injectTo: "head-prepend" }]
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts", ingestionWorker: "src/workers/ingestion/worker-entry.ts" }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["zod"] })],
    build: {
      rollupOptions: {
        input: "src/preload/index.ts"
      }
    }
  },
  renderer: {
    root: "src/renderer",
    plugins: [react(), rendererCsp()]
  }
});
