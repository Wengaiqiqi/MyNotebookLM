import { SOURCE_CHANNELS } from "../shared/ipc";
import { taskDtoSchema, type TaskDto } from "../shared/tasks";

type WindowLike = { webContents: { isDestroyed(): boolean; send(channel: string, value: TaskDto): void } };

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
