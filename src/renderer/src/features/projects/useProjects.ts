import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectDto } from "../../../../shared/projects";
import { toast } from "../../ui/Toast";

export type ProjectAction = "create" | "rename" | "remove" | undefined;

export interface ProjectsState {
  projects: ProjectDto[];
  archived: ProjectDto[];
  loaded: boolean;
  selectedId: string | undefined;
  select: (id: string | undefined) => void;
  selected: ProjectDto | undefined;
  reload: () => Promise<void>;
  create: (name: string) => Promise<boolean>;
  rename: (id: string, name: string) => Promise<boolean>;
  archive: (id: string) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  restore: (id: string) => Promise<void>;
  retryDelete: (id: string) => Promise<void>;
}

const selectedKey = "mynotebooklm.selectedProject";

export function useProjects(t: (key: string) => string): ProjectsState {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [archived, setArchived] = useState<ProjectDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(() => localStorage.getItem(selectedKey) ?? undefined);
  const epoch = useRef(0);

  useEffect(() => {
    if (selectedId) localStorage.setItem(selectedKey, selectedId);
    else localStorage.removeItem(selectedKey);
  }, [selectedId]);

  const reload = useCallback(async () => {
    const request = ++epoch.current;
    try {
      const [active, archivedList] = await Promise.all([
        window.myNotebook.projects.list(),
        window.myNotebook.projects.listArchived()
      ]);
      if (request !== epoch.current) return;
      setProjects(active);
      setArchived(archivedList);
      setLoaded(true);
      setSelectedId((current) => current && active.some((project) => project.id === current)
        ? current
        : current && archivedList.some((project) => project.id === current)
          ? current
          : active[0]?.id);
    } catch {
      if (request !== epoch.current) return;
      setLoaded(true);
      toast.error(t("error.loadProjects"), { actionLabel: t("common.retry"), onAction: () => void reload() });
    }
  }, [t]);

  useEffect(() => { void reload(); }, [reload]);

  const select = useCallback((id: string | undefined) => setSelectedId(id), []);

  const create = useCallback(async (name: string) => {
    try {
      const project = await window.myNotebook.projects.create({ name });
      setProjects((current) => [project, ...current]);
      setSelectedId(project.id);
      return true;
    } catch {
      toast.error(t("error.createProject"));
      return false;
    }
  }, [t]);

  const rename = useCallback(async (id: string, name: string) => {
    try {
      const next = await window.myNotebook.projects.rename({ id, name });
      setProjects((current) => current.map((project) => (project.id === id ? next : project)));
      setArchived((current) => current.map((project) => (project.id === id ? next : project)));
      return true;
    } catch {
      toast.error(t("error.renameProject"));
      return false;
    }
  }, [t]);

  const archive = useCallback(async (id: string) => {
    try {
      const next = await window.myNotebook.projects.archive({ id });
      setProjects((current) => current.filter((project) => project.id !== id));
      setArchived((current) => [next, ...current]);
      setSelectedId((current) => (current === id ? undefined : current));
      toast.success(t("project.archivedToast"));
      return true;
    } catch {
      toast.error(t("error.archiveProject"));
      return false;
    }
  }, [t]);

  const remove = useCallback(async (id: string) => {
    try {
      const result = await window.myNotebook.projects.remove({ id });
      await reload();
      if (result.status === "deleting") {
        toast.info(t("project.deletionPending"), {
          actionLabel: t("project.undo"),
          onAction: () => {
            void window.myNotebook.projects.undo({ id }).then(() => reload()).catch(() => toast.error(t("error.restoreProject")));
          }
        });
      }
      return true;
    } catch {
      toast.error(t("error.removeProject"));
      return false;
    }
  }, [t, reload]);

  const restore = useCallback(async (id: string) => {
    try {
      await window.myNotebook.projects.restore({ id });
      await reload();
    } catch {
      toast.error(t("error.restoreProject"));
    }
  }, [reload]);

  const retryDelete = useCallback(async (id: string) => {
    try {
      await window.myNotebook.projects.retryDelete({ id });
      await reload();
    } catch {
      toast.error(t("error.retryDeleteProject"));
    }
  }, [reload]);

  const selected = [...projects, ...archived].find((project) => project.id === selectedId);
  return { projects, archived, loaded, selectedId, select, selected, reload, create, rename, archive, remove, restore, retryDelete };
}
