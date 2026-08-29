import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BuiltInModelProfileDto, ModelCapability, ModelProfileDto, ModelRouteAttemptDto, ModelRouteDto, ModelTaskKind } from "../../../shared/models";
import FallbackHistory from "./FallbackHistory";
import { modelErrorText } from "./model-error-text";

const taskKinds: readonly ModelTaskKind[] = ["chat", "note-title", "summary", "key-points", "qa", "custom-transformation", "embedding"];
const generationTasks = new Set<ModelTaskKind>(taskKinds.filter((task) => task !== "embedding"));

type RouteSettingsProps = Readonly<{
  profiles: readonly ModelProfileDto[];
  builtInProfiles?: readonly BuiltInModelProfileDto[];
  projectId?: string;
}>;

function profileName(id: string, profiles: readonly ModelProfileDto[], builtIns: readonly BuiltInModelProfileDto[]): string {
  return profiles.find((profile) => profile.id === id)?.name
    ?? builtIns.find((profile) => profile.id === id)?.name
    ?? id;
}

function requiredCapability(task: ModelTaskKind): ModelCapability {
  return generationTasks.has(task) ? "generation" : "embedding";
}

export default function RouteSettings({ profiles, builtInProfiles = [], projectId }: RouteSettingsProps) {
  const { t } = useTranslation();
  const [taskKind, setTaskKind] = useState<ModelTaskKind>("chat");
  const [route, setRoute] = useState<ModelRouteDto[]>([]);
  const [attempts, setAttempts] = useState<ModelRouteAttemptDto[]>([]);
  const [selectedFallback, setSelectedFallback] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const available = useMemo(() => {
    const matching = profiles.filter((profile) => profile.enabled && profile.capability === requiredCapability(taskKind));
    if (taskKind === "embedding") {
      return [...matching, ...builtInProfiles.filter((profile) => profile.enabled && profile.capability === "embedding")];
    }
    return matching;
  }, [builtInProfiles, profiles, taskKind]);
  const unused = available.filter((profile) => !route.some((item) => item.profileId === profile.id));

  function chooseEmbedding(profileId: string): void {
    if (!profileId) {
      setRoute([]);
      return;
    }
    setRoute([{ taskKind: "embedding", position: 0, profileId }]);
  }

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      setLoading(true);
      setError("");
      setSelectedFallback("");
      try {
        const result = await window.myNotebook.models.getRoutes?.({ taskKind });
        if (!alive) return;
        if (!result) {
          setRoute([]);
        } else if (result.ok) {
          setRoute([...result.value].sort((a, b) => a.position - b.position));
        } else {
          setError(modelErrorText(t, result.error.messageKey));
        }
        if (projectId && window.myNotebook.models.listRouteAttempts) {
          const history = await window.myNotebook.models.listRouteAttempts({ projectId, taskKind, limit: 20 });
          if (!alive) return;
          if (history.ok) setAttempts(history.value);
        } else {
          setAttempts([]);
        }
      } catch {
        if (alive) setError(t("settings.loadError"));
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    return () => { alive = false; };
  }, [projectId, taskKind, t]);

  function addFallback(): void {
    if (taskKind === "embedding") return;
    const profileId = selectedFallback || unused[0]?.id;
    if (!profileId || route.some((item) => item.profileId === profileId)) return;
    setRoute((current) => [...current, { taskKind, position: current.length, profileId }]);
    setSelectedFallback("");
  }

  function move(index: number, delta: -1 | 1): void {
    setRoute((current) => {
      const next = index + delta;
      if (next < 0 || next >= current.length) return current;
      const copy = [...current];
      [copy[index], copy[next]] = [copy[next]!, copy[index]!];
      return copy.map((item, position) => ({ ...item, position }));
    });
  }

  function remove(index: number): void {
    if (taskKind === "embedding") return;
    setRoute((current) => current.filter((_, currentIndex) => currentIndex !== index).map((item, position) => ({ ...item, position })));
  }

  async function save(): Promise<void> {
    if (busy || !window.myNotebook.models.saveRoutes || route.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const result = await window.myNotebook.models.saveRoutes({ taskKind, profileIds: route.map((item) => item.profileId) });
      if (!result.ok) {
        setError(modelErrorText(t, result.error.messageKey));
      } else {
        setRoute([...result.value].sort((a, b) => a.position - b.position));
      }
    } catch {
      setError(t("settings.loadError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="route-settings" aria-labelledby="routing-title">
      <div className="route-settings-heading">
        <div>
          <h3 id="routing-title">{t("routing.title")}</h3>
          <p>{t("routing.description")}</p>
        </div>
        <label htmlFor="route-task">{t("routing.task")}
          <select id="route-task" value={taskKind} onChange={(event) => setTaskKind(event.target.value as ModelTaskKind)}>
            {taskKinds.map((task) => <option value={task} key={task}>{t(`routing.tasks.${task}`)}</option>)}
          </select>
        </label>
      </div>
      {error && <p className="model-page-error" role="alert">{error}</p>}
      {loading ? <p role="status">{t("common.loading")}</p> : (
        <>
          <p className="route-help">{taskKind === "embedding" ? t("routing.embeddingRule") : t("routing.fallbackRule")}</p>
          {route.length === 0 && <p className="route-empty" role="status">{t("routing.emptyRoute")}</p>}
          {taskKind === "embedding" && <label className="route-embedding-picker" htmlFor="route-embedding-profile">{t("routing.embeddingProfile")}
            <select id="route-embedding-profile" value={route[0]?.profileId ?? ""} onChange={(event) => chooseEmbedding(event.target.value)}>
              <option value="">{t("routing.chooseEmbeddingProfile")}</option>
              {available.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}
            </select>
          </label>}
          <ol className="route-list" aria-label={t("routing.orderedRoute")}>
            {route.map((item, index) => {
              const name = profileName(item.profileId, profiles, builtInProfiles);
              return <li key={`${item.profileId}-${index}`}>
                <span className="route-position">{index + 1}</span>
                <span className="route-profile-name">{name}</span>
                <div className="route-row-actions">
                  <button type="button" disabled={index === 0 || busy} aria-label={t("routing.moveUp", { name })} onClick={() => move(index, -1)}>↑</button>
                  <button type="button" disabled={index === route.length - 1 || busy} aria-label={t("routing.moveDown", { name })} onClick={() => move(index, 1)}>↓</button>
                  {taskKind !== "embedding" && <button type="button" disabled={busy} aria-label={t("routing.remove", { name })} onClick={() => remove(index)}>×</button>}
                </div>
              </li>;
            })}
          </ol>
          <div className="route-actions">
            {taskKind !== "embedding" && <>
              <label className="route-fallback-picker" htmlFor="route-fallback-profile">{t("routing.fallbackProfile")}
                <select id="route-fallback-profile" value={selectedFallback} onChange={(event) => setSelectedFallback(event.target.value)} disabled={busy || unused.length === 0}>
                  <option value="">{unused[0] ? profileName(unused[0].id, profiles, builtInProfiles) : t("routing.noAvailableProfiles")}</option>
                  {unused.slice(1).map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}
                </select>
              </label>
              <button type="button" disabled={busy || unused.length === 0} onClick={addFallback}>{route.length === 0 ? t("routing.addFirstProfile") : t("routing.addFallback")}</button>
            </>}
            <button className="primary-button" type="button" disabled={busy || route.length === 0} onClick={() => void save()}>{busy ? t("common.saving") : t("routing.saveRoute")}</button>
          </div>
          <FallbackHistory attempts={attempts} />
        </>
      )}
    </section>
  );
}
