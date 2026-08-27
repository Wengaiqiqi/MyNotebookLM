import { parentPort } from "node:worker_threads";
import { parseCsv } from "./parsers/csv-parser";
import { parseDocx } from "./parsers/docx-parser";
import { parseMarkdown } from "./parsers/markdown-parser";
import { parsePdf } from "./parsers/pdf-parser";
import { parsePptx } from "./parsers/pptx-parser";
import { parseText } from "./parsers/text-parser";
import { parseXlsx } from "./parsers/xlsx-parser";
import { chunkBlocks } from "./chunker";
import { parseWorkerMessage } from "../../main/tasks/worker-pool";
if (!parentPort) throw new Error("Worker requires parentPort");
const cancelled = new Set<string>();
async function parseBlocks(kind: string, data: Uint8Array) {
  switch (kind) {
    case "csv": return parseCsv(data);
    case "markdown": return parseMarkdown(data);
    case "pdf": return parsePdf(data);
    case "docx": return parseDocx(data);
    case "pptx": return parsePptx(data);
    case "xlsx": return parseXlsx(data);
    default: return parseText(data);
  }
}
parentPort.on("message", (raw: unknown) => { void (async () => { try { const message = parseWorkerMessage(raw); if (message.type === "cancel") { cancelled.add(message.taskId); parentPort!.postMessage({ version: 1, type: "error", taskId: message.taskId, error: { code: "TASK_CANCELLED", message: "Task cancelled" } }); return; } if (cancelled.has(message.taskId)) return; parentPort!.postMessage({ version: 1, type: "progress", taskId: message.taskId, value: 100 }); const blocks = await parseBlocks(message.kind, message.data); if (cancelled.has(message.taskId)) return; parentPort!.postMessage({ version: 1, type: "progress", taskId: message.taskId, value: 700 }); const chunks = chunkBlocks(blocks); if (cancelled.has(message.taskId)) return; parentPort!.postMessage({ version: 1, type: "progress", taskId: message.taskId, value: 1000 }); parentPort!.postMessage({ version: 1, type: "result", taskId: message.taskId, chunks }); } catch (error) { const taskId = typeof raw === "object" && raw ? (raw as { taskId?: string }).taskId : "unknown"; parentPort!.postMessage({ version: 1, type: "error", taskId, error: { code: "WORKER_FAILED", message: error instanceof Error ? error.message : String(error) } }); } })(); });
