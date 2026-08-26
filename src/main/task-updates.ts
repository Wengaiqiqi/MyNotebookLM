import { SOURCE_CHANNELS } from "../shared/ipc";
import { taskDtoSchema, type TaskDto } from "../shared/tasks";

type WindowLike = { webContents: { isDestroyed(): boolean; send(channel: string, value: TaskDto): void; on(event: string, listener: (...args: unknown[]) => void): void; removeListener(event: string, listener: (...args: unknown[]) => void): void } };

export function createTaskUpdateFanout(windows: Iterable<WindowLike> | (() => Iterable<WindowLike>), filter?: { projectId: string }): ((task: TaskDto) => void) & { close(): void } {
  let closed = false;
  const fanout = (task: TaskDto) => {
    if (closed) return;
    if (filter && task.projectId !== filter.projectId) return;
    for (const window of typeof windows === "function" ? windows() : windows) {
      if (window.webContents.isDestroyed()) continue;
      window.webContents.send(SOURCE_CHANNELS.update + ":" + task.projectId, taskDtoSchema.parse(task));
    }
  };
  return Object.assign(fanout, { close: () => { closed = true; } });
}

export function subscribeWindowToTaskUpdates(window: WindowLike, onTask: (task: TaskDto) => void): () => void {
  const listener = (_event: unknown, raw: unknown) => {
    const task = taskDtoSchema.safeParse(raw);
    if (task.success) onTask(task.data);
  };
  window.webContents.on("destroyed", listener);
  return () => window.webContents.removeListener("destroyed", listener);
}
