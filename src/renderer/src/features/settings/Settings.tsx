import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  BuiltInModelProfileDto,
  ModelProfileDto,
  ModelRouteAttemptDto,
  ModelRouteDto,
  ModelTaskKind,
  ProviderKind
} from "../../../../shared/models";
import ModelForm from "../models/ModelForm";
import Icon, { type IconName } from "../../ui/Icon";
import Modal, { DialogHead } from "../../ui/Modal";
import { toast } from "../../ui/Toast";
import IndexPanel from "./IndexPanel";
import type { AppLanguage, AppTheme } from "../../i18n";

type Section = "general" | "models" | "routes" | "index";

const GENERATION_TASKS: ModelTaskKind[] = ["chat", "note-title", "summary", "qa", "custom-transformation"];
const ALL_TASKS: ModelTaskKind[] = [...GENERATION_TASKS, "embedding"];

const providerLabel = (t: (key: string) => string, provider: ProviderKind): string =>
  t(`model.providers.${provider}`);

function profileDisplayName(name: string): string {
  // Older multi-select saves appended " / <index>". Keep those records
  // readable without carrying the implementation detail into the title.
  // ponytail: this display-only heuristic can match a user-entered numeric
  // suffix; add explicit multi-select metadata if that distinction matters.
  return name.replace(/\s+\/\s+\d+$/, "").trim() || name;
}

type RouteProfile = ModelProfileDto | BuiltInModelProfileDto;

function routeModelLabel(profile: RouteProfile | undefined, fallback: string): string {
  return profile ? `${profileDisplayName(profile.name)} / ${profile.modelId}` : fallback;
}

type ProviderGroup = {
  key: string;
  name: string;
  provider: ProviderKind;
  baseUrl: string;
  profiles: ModelProfileDto[];
};

function groupProfilesByProvider(profiles: ModelProfileDto[]): ProviderGroup[] {
  const map = new Map<string, ProviderGroup>();
  for (const profile of profiles) {
    const cleanName = profileDisplayName(profile.name);
    const key = `${profile.provider}:::${cleanName}:::${profile.baseUrl.trim()}`;
    const existing = map.get(key);
    if (existing) {
      existing.profiles.push(profile);
    } else {
      map.set(key, {
        key,
        name: cleanName,
        provider: profile.provider,
        baseUrl: profile.baseUrl.trim(),
        profiles: [profile]
      });
    }
  }
  return Array.from(map.values());
}

type DeletingTarget =
  | { kind: "single"; profile: ModelProfileDto }
  | { kind: "group"; groupName: string; profiles: ModelProfileDto[] };

export default function Settings({ projectId, language, theme, onLanguage, onTheme, onRoutesChanged, onClose }: {
  projectId?: string | undefined;
  language: AppLanguage;
  theme: AppTheme;
  onLanguage: (language: AppLanguage) => void;
  onTheme: (theme: AppTheme) => void;
  onRoutesChanged: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>("models");
  const [profiles, setProfiles] = useState<ModelProfileDto[]>([]);
  const [builtIns, setBuiltIns] = useState<BuiltInModelProfileDto[]>([]);
  const [editorOpen, setEditorOpen] = useState<{ capability: "generation" | "embedding"; existing?: ModelProfileDto; existingGroup?: ProviderGroup }>();
  const [deletingTarget, setDeletingTarget] = useState<DeletingTarget>();
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const toggleExpanded = (key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    const result = await window.myNotebook.models.listProfiles();
    if (!result.ok) { toast.error(t(result.error.messageKey)); return; }
    setProfiles(result.value.profiles);
    setBuiltIns(result.value.builtInProfiles);
    setLoaded(true);
  }, [t]);

  useEffect(() => { void reload(); }, [reload]);

  const sections: Array<{ id: Section; icon: IconName; label: string }> = [
    { id: "general", icon: "sliders", label: t("settings.general") },
    { id: "models", icon: "brain", label: t("settings.modelServices") },
    { id: "routes", icon: "route", label: t("routing.title") },
    { id: "index", icon: "database", label: t("settings.dataIndex") }
  ];

  return (
    <div className="center-stage fade-in">
      <div className={`stage-inner${section === "models" ? " settings-stage-models" : ""}`}>
        <header className="stage-head" style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
          <div>
            <h1>{t("settings.title")}</h1>
            <p>{t("settings.subtitle")}</p>
          </div>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn outline" onClick={onClose}><Icon name="close" />{t("settings.back")}</button>
        </header>

        <div className={`settings-grid${section === "models" ? " settings-models-grid" : ""}`}>
          <nav className="settings-nav" aria-label={t("settings.title")}>
            {sections.map((item) => (
              <button key={item.id} type="button" aria-current={section === item.id ? "page" : undefined} onClick={() => setSection(item.id)}>
                <Icon name={item.icon} />
                {item.label}
              </button>
            ))}
          </nav>

          <div className={section === "models" ? "settings-content settings-models-content" : "settings-content"} style={{ minWidth: 0, display: "grid", gap: 12 }}>
            {section === "general" && (
              <>
                <div className="pref-card card">
                  <h3>{t("settings.languageAppearance")}</h3>
                  <div className="pref-row">
                    <span className="copy"><strong>{t("common.language")}</strong></span>
                    <div className="seg" role="group" aria-label={t("common.language")}>
                      <button type="button" aria-pressed={language === "zh-CN"} onClick={() => onLanguage("zh-CN")}>中文</button>
                      <button type="button" aria-pressed={language === "en"} onClick={() => onLanguage("en")}>English</button>
                    </div>
                  </div>
                  <div className="pref-row">
                    <span className="copy"><strong>{t("common.theme")}</strong><small>{t("settings.themeHint")}</small></span>
                    <div className="seg" role="group" aria-label={t("common.theme")}>
                      <button type="button" aria-pressed={theme === "light"} onClick={() => onTheme("light")}><Icon name="sun" />{t("common.light")}</button>
                      <button type="button" aria-pressed={theme === "dark"} onClick={() => onTheme("dark")}><Icon name="moon" />{t("common.dark")}</button>
                    </div>
                  </div>
                </div>
              </>
            )}

            {section === "models" && (
              <>
                {(["generation", "embedding"] as const).map((capability) => {
                  const capabilityProfiles = profiles.filter((profile) => profile.capability === capability);
                  const providerGroups = groupProfilesByProvider(capabilityProfiles);
                  return (
                    <div key={capability} className="pref-card card model-service-card">
                      <div className="pref-row">
                        <div className="copy">
                          <strong>{t(capability === "generation" ? "model.generation.title" : "model.embedding.title")}</strong>
                          <small>{t(capability === "generation" ? "model.generation.description" : "model.embedding.description")}</small>
                        </div>
                        <button
                          type="button"
                          className="btn primary sm"
                          onClick={() => setEditorOpen({ capability })}
                        >
                          <Icon name="plus" />{t("model.newProfile", { capability: t(capability === "generation" ? "model.generation.title" : "model.embedding.title") })}
                        </button>
                      </div>
                      {loaded && capabilityProfiles.length === 0 && (
                        <p className="model-service-empty">{t("model.noProfiles")}</p>
                      )}
                      <div className="model-service-list">
                        {providerGroups.map((group) => {
                          const isExpanded = expandedKeys.has(group.key);
                          return (
                            <div className="provider-card card" key={group.key}>
                              <div className="provider-card-main">
                                <span className="p-icon" aria-hidden="true">
                                  <Icon name={capability === "generation" ? "brain" : "database"} />
                                </span>
                                <div className="provider-card-info">
                                  <div className="provider-card-title-row">
                                    <strong className="provider-name">{group.name}</strong>
                                    <span className="badge neutral provider-tag">{providerLabel(t, group.provider)}</span>
                                    <span className="provider-count-badge">
                                      {t("model.configuredModels", { count: group.profiles.length })}
                                    </span>
                                  </div>
                                  {group.baseUrl ? (
                                    <span className="provider-url" title={group.baseUrl}>{group.baseUrl}</span>
                                  ) : null}
                                </div>
                                <div className="provider-actions">
                                  <button
                                    type="button"
                                    className="btn outline sm provider-detail-btn"
                                    onClick={() => toggleExpanded(group.key)}
                                    aria-expanded={isExpanded}
                                  >
                                    <Icon name={isExpanded ? "chevron-up" : "chevron-down"} />
                                    {isExpanded ? t("model.hideDetails") : t("model.viewDetails")}
                                  </button>
                                  <button
                                    type="button"
                                    className="icon-btn"
                                    aria-label={`${t("common.edit")}: ${group.name}`}
                                    onClick={() => setEditorOpen({ capability, existingGroup: group })}
                                    title={t("common.edit")}
                                  >
                                    <Icon name="edit" />
                                  </button>
                                  <button
                                    type="button"
                                    className="icon-btn danger"
                                    aria-label={`${t("common.delete")}: ${group.name}`}
                                    onClick={() => setDeletingTarget({ kind: "group", groupName: group.name, profiles: group.profiles })}
                                    title={t("common.delete")}
                                  >
                                    <Icon name="trash" />
                                  </button>
                                </div>
                              </div>

                              {isExpanded && (
                                <div className="provider-models-drawer">
                                  <div className="models-drawer-head">
                                    <span className="models-drawer-label">{t("model.modelsList")}</span>
                                    <span className="models-drawer-count">{t("model.configuredModels", { count: group.profiles.length })}</span>
                                  </div>
                                  <div className="models-drawer-list">
                                    {group.profiles.map((profile) => (
                                      <div className="model-chip-row" key={profile.id}>
                                        <div className="model-chip-info">
                                          <span className="model-chip-dot" />
                                          <span className="model-chip-title" title={profile.modelId}>{profile.modelId}</span>
                                          {!profile.enabled && <span className="badge neutral">{t("model.disabled")}</span>}
                                        </div>
                                        <div className="model-chip-actions">
                                          <button
                                            type="button"
                                            className="icon-btn"
                                            aria-label={`${t("common.edit")}: ${profile.modelId}`}
                                            onClick={() => setEditorOpen({ capability, existing: profile, existingGroup: group })}
                                            title={t("common.edit")}
                                          >
                                            <Icon name="edit" />
                                          </button>
                                          <button
                                            type="button"
                                            className="icon-btn danger"
                                            aria-label={`${t("common.delete")}: ${profile.modelId}`}
                                            onClick={() => setDeletingTarget({ kind: "single", profile })}
                                            title={t("common.delete")}
                                          >
                                            <Icon name="trash" />
                                          </button>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                        {capability === "embedding" && builtIns.map((builtIn) => (
                          <div className="provider-card card built-in-card" key={builtIn.id}>
                            <div className="provider-card-main">
                              <span className="p-icon" aria-hidden="true"><Icon name="cpu" /></span>
                              <div className="provider-card-info">
                                <div className="provider-card-title-row">
                                  <strong className="provider-name">{builtIn.name}</strong>
                                  <span className="badge accent">{t("model.builtIn")}</span>
                                  <span className="provider-count-badge">384 {t("model.dimension", { defaultValue: "维" })}</span>
                                </div>
                                <span className="provider-url">{t("model.builtInHint", { dimension: builtIn.dimension })}</span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}</>
            )}

            {section === "routes" && (
              <RoutesPanel profiles={profiles} builtIns={builtIns} projectId={projectId} onSaved={() => { onRoutesChanged(); }} />
            )}

            {section === "index" && (
              projectId
                ? <IndexPanel projectId={projectId} />
                : <div className="pref-card card"><p style={{ color: "var(--ink-2)" }}>{t("vector.noProject")}</p></div>
            )}
          </div>
        </div>
      </div>

      {editorOpen && (
        <Modal open wide onClose={() => setEditorOpen(undefined)} labelledBy="model-editor-title">
          <h2 id="model-editor-title">{editorOpen.existing || editorOpen.existingGroup ? t("model.editProfile") : t("model.newProfileTitle")}</h2>
          <div style={{ marginTop: 14 }}>
            <ModelForm
              capability={editorOpen.capability}
              existing={editorOpen.existing}
              existingProfiles={editorOpen.existingGroup?.profiles ?? (editorOpen.existing ? [editorOpen.existing] : undefined)}
              {...(editorOpen.capability === "embedding" ? { builtIn: builtIns[0], initialProvider: "local" as const } : {})}
              onCancel={() => setEditorOpen(undefined)}
              onSaved={() => { setEditorOpen(undefined); void reload(); }}
            />
          </div>
        </Modal>
      )}

      {deletingTarget && (
        <DeleteProfileDialog
          target={deletingTarget}
          onDone={() => { setDeletingTarget(undefined); void reload(); }}
          onClose={() => setDeletingTarget(undefined)}
        />
      )}
    </div>
  );
}

function DeleteProfileDialog({ target, onClose, onDone }: {
  target: DeletingTarget;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  async function confirm(): Promise<void> {
    setBusy(true);
    if (target.kind === "single") {
      const result = await window.myNotebook.models.deleteProfile({ id: target.profile.id }).catch(() => undefined);
      setBusy(false);
      if (!result?.ok) { toast.error(t(result?.error.messageKey ?? "errors.internal")); return; }
    } else {
      let anyFailed = false;
      for (const p of target.profiles) {
        const result = await window.myNotebook.models.deleteProfile({ id: p.id }).catch(() => undefined);
        if (!result?.ok) anyFailed = true;
      }
      setBusy(false);
      if (anyFailed) {
        toast.error(t("errors.internal"));
        onDone();
        return;
      }
    }
    toast.success(t("model.profileDeleted"));
    onDone();
  }
  const title = t("model.deleteProfile");
  const body = target.kind === "single"
    ? t("model.deleteProfileBody", { name: `${profileDisplayName(target.profile.name)} (${target.profile.modelId})` })
    : t("model.deleteProviderBody", {
        name: target.groupName,
        count: target.profiles.length,
        defaultValue: `确定要删除提供商“${target.groupName}”及其包含的 ${target.profiles.length} 个模型配置吗？`
      });

  return (
    <Modal open alert onClose={onClose} labelledBy="delete-profile-title">
      <DialogHead id="delete-profile-title" icon="trash" title={title} body={body} />
      <div className="dialog-foot">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
        <button type="button" className="btn danger" disabled={busy} onClick={() => void confirm()}>
          {busy ? <span className="spinner light" aria-hidden="true" /> : <Icon name="trash" />}
          {t("common.confirm")}
        </button>
      </div>
    </Modal>
  );
}

function RoutesPanel({ profiles, builtIns, projectId, onSaved }: {
  profiles: ModelProfileDto[];
  builtIns: BuiltInModelProfileDto[];
  projectId?: string | undefined;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [taskKind, setTaskKind] = useState<ModelTaskKind>("chat");
  const [route, setRoute] = useState<ModelRouteDto[]>([]);
  const [attempts, setAttempts] = useState<ModelRouteAttemptDto[]>([]);
  const [attemptPage, setAttemptPage] = useState(0);
  const [attemptHasNext, setAttemptHasNext] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  const isEmbedding = taskKind === "embedding";
  const available = useMemo(() => {
    const capability = isEmbedding ? "embedding" : "generation";
    const matching = profiles.filter((profile) => profile.enabled && profile.capability === capability);
    const candidates: RouteProfile[] = isEmbedding ? [...matching, ...builtIns] : matching;
    return [...candidates].sort((left, right) =>
      `${left.modelId}\u0000${left.provider}`.localeCompare(`${right.modelId}\u0000${right.provider}`, undefined, { numeric: true, sensitivity: "base" })
    );
  }, [profiles, builtIns, isEmbedding]);
  const unused = available.filter((profile) => !route.some((item) => item.profileId === profile.id));
  const profileLabel = (id: string): string => routeModelLabel(
    profiles.find((profile) => profile.id === id) ?? builtIns.find((profile) => profile.id === id),
    id
  );
  const addProfileLabel = isEmbedding
    ? t("routing.chooseEmbeddingProfile")
    : route.length === 0
      ? t("routing.emptyRoute")
      : t("routing.fallbackProfile");

  const [selectedProviderKey, setSelectedProviderKey] = useState<string>("");

  const unusedProviderGroups = useMemo(() => {
    const groups = new Map<string, { key: string; name: string; provider: ProviderKind | "builtin"; models: RouteProfile[] }>();
    for (const p of unused) {
      const isBuiltin = "editable" in p && !p.editable;
      const groupKey = isBuiltin ? "builtin" : `${p.provider}:::${profileDisplayName(p.name)}`;
      const groupName = isBuiltin ? t("model.builtIn") : profileDisplayName(p.name);
      const existing = groups.get(groupKey);
      if (existing) {
        existing.models.push(p);
      } else {
        groups.set(groupKey, {
          key: groupKey,
          name: groupName,
          provider: isBuiltin ? "builtin" : p.provider,
          models: [p]
        });
      }
    }
    return Array.from(groups.values());
  }, [unused, t]);

  useEffect(() => {
    if (selectedProviderKey && !unusedProviderGroups.some((g) => g.key === selectedProviderKey)) {
      setSelectedProviderKey("");
    }
  }, [selectedProviderKey, unusedProviderGroups]);

  const currentProviderGroup = unusedProviderGroups.find((g) => g.key === selectedProviderKey);
  const currentGroupModels = currentProviderGroup?.models ?? [];

  const providerOptions = [
    { value: "", label: t("model.chooseProvider") },
    ...unusedProviderGroups.map((group) => {
      const pLabel = group.provider === "builtin" ? t("model.builtIn") : providerLabel(t, group.provider as ProviderKind);
      return {
        value: group.key,
        label: `${group.name} (${pLabel}) · ${group.models.length} ${t("model.modelsCount")}`
      };
    })
  ];

  const modelOptions = [
    {
      value: "",
      label: !selectedProviderKey
        ? t("model.selectProviderFirst")
        : currentGroupModels.length === 0
          ? t("model.noProfiles")
          : addProfileLabel
    },
    ...currentGroupModels.map((p) => ({
      value: p.id,
      label: p.modelId
    }))
  ];

  useEffect(() => {
    setAttemptPage(0);
    setDirty(false);
  }, [taskKind, projectId]);

  useEffect(() => {
    let alive = true;
    void window.myNotebook.models.getRoutes?.({ taskKind }).then((result) => {
      if (!alive) return;
      setRoute(result.ok ? [...result.value].sort((a, b) => a.position - b.position) : []);
    }).catch(() => undefined);
    if (projectId) {
      void window.myNotebook.models.listRouteAttempts?.({ projectId, taskKind, limit: 6, offset: attemptPage * 5 }).then((result) => {
        if (!alive) return;
        if (!result.ok) {
          setAttempts([]);
          setAttemptHasNext(false);
          return;
        }
        setAttempts(result.value.slice(0, 5));
        setAttemptHasNext(result.value.length > 5);
      }).catch(() => undefined);
    } else {
      setAttempts([]);
      setAttemptHasNext(false);
    }
    return () => { alive = false; };
  }, [taskKind, projectId, attemptPage]);

  function move(index: number, delta: -1 | 1): void {
    setRoute((current) => {
      const next = index + delta;
      if (next < 0 || next >= current.length) return current;
      const copy = [...current];
      [copy[index], copy[next]] = [copy[next]!, copy[index]!];
      return copy.map((item, position) => ({ ...item, position }));
    });
    setDirty(true);
  }

  function removeAt(index: number): void {
    setRoute((current) => current.filter((_, at) => at !== index).map((item, position) => ({ ...item, position })));
    setDirty(true);
  }

  function addProfile(profileId: string): void {
    if (!profileId) return;
    setRoute((current) => isEmbedding
      ? [{ taskKind, position: 0, profileId }]
      : [...current, { taskKind, position: current.length, profileId }]);
    setDirty(true);
  }

  async function save(): Promise<void> {
    if (busy || route.length === 0) return;
    const saveRoutes = window.myNotebook.models.saveRoutes;
    if (!saveRoutes) return;
    setBusy(true);
    const result = await saveRoutes({ taskKind, profileIds: route.map((item) => item.profileId) });
    setBusy(false);
    if (!result.ok) { toast.error(t(result.error.messageKey)); return; }
    setRoute([...result.value].sort((a, b) => a.position - b.position));
    setDirty(false);
    onSaved();
    toast.success(t("routing.saved"));
  }

  const taskLabels: Partial<Record<ModelTaskKind, string>> = {
    chat: t("routing.tasks.chat"),
    "note-title": t("routing.tasks.note-title"),
    summary: t("routing.tasks.summary"),
    qa: t("routing.tasks.qa"),
    "custom-transformation": t("routing.tasks.custom-transformation"),
    embedding: t("routing.tasks.embedding")
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className="pref-card card">
        <div className="pref-row" style={{ flexWrap: "wrap", gap: 8 }}>
          <span className="copy"><strong>{t("routing.title")}</strong><small>{t("routing.description")}</small></span>
          <RoundedSelect
            className="route-task-select"
            ariaLabel={t("routing.task")}
            value={taskKind}
            options={ALL_TASKS.map((kind) => ({ value: kind, label: taskLabels[kind] ?? kind }))}
            onChange={(value) => setTaskKind(value as ModelTaskKind)}
          />
        </div>

        <div className="route-chain">
          {route.map((step, index) => (
            <div className="route-step" key={`${step.profileId}-${index}`}>
              <span className="pos" aria-hidden="true">{index + 1}</span>
              <span className="name">{profileLabel(step.profileId)}</span>
              <span className="step-actions">
                <button type="button" className="icon-btn" aria-label={t("routing.moveUp", { name: profileLabel(step.profileId) })} disabled={index === 0} onClick={() => move(index, -1)}><Icon name="arrow-up" /></button>
                <button type="button" className="icon-btn" aria-label={t("routing.moveDown", { name: profileLabel(step.profileId) })} disabled={index === route.length - 1} onClick={() => move(index, 1)}><Icon name="arrow-down" /></button>
                {!isEmbedding && <button type="button" className="icon-btn danger" aria-label={t("routing.remove", { name: profileLabel(step.profileId) })} onClick={() => removeAt(index)}><Icon name="close" /></button>}
              </span>
            </div>
          ))}
          {!isEmbedding && route.length > 1 && <span className="fallback-hint">{t("routing.fallbackRule")}</span>}
        </div>

        <div className="input-row route-cascade-picker">
          <RoundedSelect
            className="cascade-provider-select"
            ariaLabel={t("model.chooseProvider")}
            value={selectedProviderKey}
            options={providerOptions}
            onChange={(val) => setSelectedProviderKey(val)}
          />
          <RoundedSelect
            className="cascade-model-select"
            ariaLabel={selectedProviderKey ? addProfileLabel : t("model.selectProviderFirst")}
            value=""
            disabled={!selectedProviderKey || currentGroupModels.length === 0}
            options={modelOptions}
            onChange={(profileId) => {
              if (profileId) addProfile(profileId);
            }}
          />
          <button type="button" className="btn primary" disabled={busy || !dirty || route.length === 0} onClick={() => void save()}>
            {busy ? <span className="spinner light" aria-hidden="true" /> : <Icon name="check" />}
            {t("routing.saveRoute")}
          </button>
        </div>
      </div>

      {projectId && (attempts.length > 0 || attemptPage > 0) && (
        <div className="pref-card card">
          <h3>{t("routing.fallbackHistory")}</h3>
          {attempts.map((attempt) => (
            <div className="route-attempt" key={attempt.id}>
              <span className={`badge ${attempt.state === "completed" ? "ok" : attempt.state === "failed" ? "danger" : "neutral"}`}>
                {t(`routing.states.${attempt.state}`, attempt.state)}
              </span>
              <span className="model">{profileDisplayName(profiles.find((profile) => profile.id === attempt.profileId)?.name ?? providerLabel(t, attempt.provider))} / {attempt.model}</span>
              {attempt.errorCode && <span style={{ color: "var(--danger)" }}>{attempt.errorCode}</span>}
              <span className="when">{new Date(attempt.startedAt).toLocaleString()}</span>
            </div>
          ))}
          <div className="route-history-pagination" aria-label={t("routing.fallbackHistory")}>
            <button type="button" className="btn outline sm" disabled={attemptPage === 0} onClick={() => setAttemptPage((page) => Math.max(0, page - 1))}>
              {t("routing.previousPage")}
            </button>
            <span>{t("routing.page", { page: attemptPage + 1 })}</span>
            <button type="button" className="btn outline sm" disabled={!attemptHasNext} onClick={() => setAttemptPage((page) => page + 1)}>
              {t("routing.nextPage")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RoundedSelect({ value, options, ariaLabel, onChange, className = "", disabled = false }: {
  value: string;
  options: Array<{ value: string; label: string }>;
  ariaLabel: string;
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<"up" | "down">("down");
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    if (root) {
      const rect = root.getBoundingClientRect();
      setPlacement(window.innerHeight - rect.bottom < 280 && rect.top > 280 ? "up" : "down");
    }
    const close = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className={`rounded-select ${className}${disabled ? " is-disabled" : ""}`.trim()} ref={rootRef}>
      <button
        type="button"
        className="select rounded-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (!disabled) setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="select-value">{selected?.label}</span>
        <Icon name={open ? "chevron-up" : "chevron-down"} />
      </button>
      {open && !disabled && (
        <div className="rounded-select-menu" data-placement={placement} role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className="rounded-select-option"
              key={option.value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
