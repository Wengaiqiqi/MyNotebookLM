import { useSyncExternalStore } from "react";
import type { TaskDto } from "../../../../shared/tasks";

type Selections = Record<"source" | "message" | "answer", string[]>;
type StudioSession = {
  ruleKey: string;
  targetSelections: Selections;
  // null adopts an existing task on first visit; [] explicitly starts a new run.
  taskIds: string[] | null;
  submittedTasks: TaskDto[];
  running: boolean;
  retrying: boolean;
};
type Entry = { raw: string | null; state: StudioSession; listeners: Set<() => void> };
const sessions = new Map<string, Entry>();
const storageKey = (projectId: string) => `mynotebooklm.studio.${projectId}`;

function read(projectId: string): Entry {
  let raw: string | null = null;
  try { raw = localStorage.getItem(storageKey(projectId)); } catch { return sessions.get(projectId) ?? create(projectId, null); }
  const entry = sessions.get(projectId);
  return entry?.raw === raw ? entry : create(projectId, raw, entry?.listeners);
}

function create(projectId: string, raw: string | null, listeners = new Set<() => void>()): Entry {
  const state: StudioSession = { ruleKey: "summary", targetSelections: { source: [], message: [], answer: [] }, taskIds: null,
    submittedTasks: [], running: false, retrying: false };
  try {
    const saved = JSON.parse(raw ?? "null");
    const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === "string");
    if (saved && typeof saved.ruleKey === "string" && ["source", "message", "answer"].every((kind) => ids(saved.targetSelections?.[kind]))
      && (saved.taskIds === null || ids(saved.taskIds))) {
      state.ruleKey = saved.ruleKey;
      state.targetSelections = saved.targetSelections;
      state.taskIds = saved.taskIds;
    }
  } catch { /* A corrupt or unavailable preference must not prevent conversion. */ }
  const entry = { raw, state, listeners };
  sessions.set(projectId, entry);
  return entry;
}

/** Also used by in-flight IPC replies after navigation unmounts the pane. */
export function updateStudioSession(projectId: string, update: (current: StudioSession) => StudioSession): void {
  const entry = read(projectId);
  entry.state = update(entry.state);
  const { ruleKey, targetSelections, taskIds } = entry.state;
  try {
    const raw = JSON.stringify({ ruleKey, targetSelections, taskIds });
    localStorage.setItem(storageKey(projectId), raw);
    entry.raw = raw;
  } catch { /* Keep the session in memory when browser storage is unavailable. */ }
  entry.listeners.forEach((listener) => listener());
}

export function useStudioSession(projectId: string): StudioSession {
  return useSyncExternalStore((listener) => {
    const listeners = read(projectId).listeners;
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => read(projectId).state);
}
