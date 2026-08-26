import { parentPort } from "node:worker_threads";
import { parseCsv } from "./parsers/csv-parser";
import { parseMarkdown } from "./parsers/markdown-parser";
import { parseText } from "./parsers/text-parser";
import { chunkBlocks } from "./chunker";
import { parseWorkerMessage } from "../../main/tasks/worker-pool";
if (!parentPort) throw new Error("Worker requires parentPort");
const cancelled = new Set<string>();
parentPort.on("message", (raw: unknown) => { try { const message = parseWorkerMessage(raw); if (message.type === "cancel") { cancelled.add(message.taskId); parentPort!.postMessage({ version: 1, type: "error", taskId: message.taskId, error: { code: "TASK_CANCELLED", message: "Task cancelled" } }); return; } if (cancelled.has(message.taskId)) return; parentPort!.postMessage({ version: 1, type: "progress", taskId: message.taskId, value: 100 }); const blocks = message.kind === "csv" ? parseCsv(message.data) : message.kind === "markdown" ? parseMarkdown(message.data) : parseText(message.data); if (cancelled.has(message.taskId)) return; parentPort!.postMessage({ version: 1, type: "progress", taskId: message.taskId, value: 700 }); const chunks = chunkBlocks(blocks); if (cancelled.has(message.taskId)) return; parentPort!.postMessage({ version: 1, type: "progress", taskId: message.taskId, value: 1000 }); parentPort!.postMessage({ version: 1, type: "result", taskId: message.taskId, chunks }); } catch (error) { const taskId = typeof raw === "object" && raw ? (raw as { taskId?: string }).taskId : "unknown"; parentPort!.postMessage({ version: 1, type: "error", taskId, error: { code: "WORKER_FAILED", message: error instanceof Error ? error.message : String(error) } }); } });
