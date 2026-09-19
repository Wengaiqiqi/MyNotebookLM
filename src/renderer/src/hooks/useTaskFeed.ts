import { useEffect, useState } from "react";
import type { TaskDto } from "../../../shared/tasks";

type SubscribeFn = (projectId: string, listener: (task: TaskDto) => void) => () => void;

/**
 * Live task feed for one project: initial list plus incremental updates.
 * The most recent update per task id wins; the list stays sorted newest-first.
 */
export function useTaskFeed(projectId: string | undefined, subscribe: SubscribeFn | undefined, list: ((input: { projectId: string }) => Promise<TaskDto[]>) | undefined): TaskDto[] {
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  useEffect(() => {
    setTasks([]);
    if (!projectId) return;
    let alive = true;
    const unsubscribe = subscribe?.(projectId, (task) => {
      if (!alive) return;
      setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    });
    void list?.({ projectId }).then((items) => {
      if (alive) setTasks((current) => [...current, ...items.filter((item) => !current.some((task) => task.id === item.id))]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    }).catch(() => undefined);
    return () => { alive = false; unsubscribe?.(); };
  }, [projectId, list, subscribe]);
  return tasks;
}
