import { parentPort } from "node:worker_threads";
import { parseCsv } from "./parsers/csv-parser";
import { parseMarkdown } from "./parsers/markdown-parser";
import { parseText } from "./parsers/text-parser";
import { chunkBlocks } from "./chunker";
import { parseWorkerMessage } from "../../main/tasks/worker-pool";
if (!parentPort) throw new Error("Worker requires parentPort");
parentPort.on("message", (raw: unknown) => { try { const message = parseWorkerMessage(raw); if (message.type === "cancel") return; const blocks = message.kind === "csv" ? parseCsv(message.data) : message.kind === "markdown" ? parseMarkdown(message.data) : parseText(message.data); parentPort!.postMessage({ version: 1, type: "result", taskId: message.taskId, chunks: chunkBlocks(blocks) }); } catch (error) { parentPort!.postMessage({ version: 1, type: "error", taskId: typeof raw === "object" && raw ? (raw as { taskId?: string }).taskId : "unknown", error: String(error) }); } });
