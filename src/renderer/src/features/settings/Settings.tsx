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

const GENERATION_TASKS: ModelTaskKind[] = ["chat", "note-title", "summary", "key-points", "qa", "custom-transformation"];
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
  return profile ? `${profile.name} / ${profile.modelId}` : fallback;
}

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
  const [editorOpen, setEditorOpen] = useState<{ capability: "generation" | "embedding"; existing?: ModelProfileDto }>();
  const [deleting, setDeleting] = useState<ModelProfileDto>();
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
                {(["generation", "embedding"] as const).map((capability) => (
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
                    {loaded && profiles.filter((profile) => profile.capability === capability).length === 0 && (
                      <p className="model-service-empty">{t("model.noProfiles")}</p>
                    )}
                    <div className="model-service-list">
                      {profiles.filter((profile) => profile.capability === capability).map((profile) => (
                        <div className="profile-row" key={profile.id}>
                          <span className="p-icon" aria-hidden="true">
                            <Icon name={capability === "generation" ? "brain" : "database"} />
                          </span>
                          <span className="copy">
                            <strong>
                              <span>{profileDisplayName(profile.name)}</span>
                              <span className="profile-model-id">{profile.modelId}</span>
                            </strong>
                          </span>
                          {!profile.enabled && <span className="badge neutral">{t("model.disabled")}</span>}
                          <span className="row-actions">
                            <button type="button" className="icon-btn" aria-label={`${t("common.edit")}: ${profile.name}`} onClick={() => setEditorOpen({ capability, existing: profile })}>
                              <Icon name="edit" />
                            </button>
                            <button type="button" className="icon-btn danger" aria-label={`${t("common.delete")}: ${profile.name}`} onClick={() => setDeleting(profile)}>
                              <Icon name="trash" />
                            </button>
                          </span>
                        </div>
                      ))}
                      {capability === "embedding" && builtIns.map((builtIn) => (
                        <div className="profile-row" key={builtIn.id} style={{ opacity: 0.85 }}>
                          <span className="p-icon" aria-hidden="true"><Icon name="cpu" /></span>
                          <span className="copy">
                            <strong>{builtIn.name}</strong>
                            <small>{t("model.builtInHint", { dimension: builtIn.dimension })}</small>
                          </span>
                          <span className="badge accent">{t("model.builtIn")}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </>
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
          <h2 id="model-editor-title">{editorOpen.existing ? t("model.editProfile") : t("model.newProfileTitle")}</h2>
          <div style={{ marginTop: 14 }}>
            <ModelForm
              capability={editorOpen.capability}
              existing={editorOpen.existing}
              {...(editorOpen.capability === "embedding" ? { builtIn: builtIns[0], initialProvider: "local" as const } : {})}
              onCancel={() => setEditorOpen(undefined)}
              onSaved={() => { setEditorOpen(undefined); void reload(); }}
            />
          </div>
        </Modal>
      )}

      {deleting && (
        <DeleteProfileDialog
          profile={deleting}
          onDone={() => { setDeleting(undefined); void reload(); }}
          onClose={() => setDeleting(undefined)}
        />
      )}
    </div>
  );
}

function DeleteProfileDialog({ profile, onClose, onDone }: {
  profile: ModelProfileDto;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  async function confirm(): Promise<void> {
    setBusy(true);
    const result = await window.myNotebook.models.deleteProfile({ id: profile.id }).catch(() => undefined);
    setBusy(false);
    if (!result?.ok) { toast.error(t(result?.error.messageKey ?? "errors.internal")); return; }
    toast.success(t("model.profileDeleted"));
    onDone();
  }
  return (
    <Modal open alert onClose={onClose} labelledBy="delete-profile-title">
      <DialogHead id="delete-profile-title" icon="trash" title={t("model.deleteProfile")} body={t("model.deleteProfileBody", { name: profile.name })} />
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

  useEffect(() => {
    let alive = true;
    setDirty(false);
    void window.myNotebook.models.getRoutes?.({ taskKind }).then((result) => {
      if (!alive) return;
      setRoute(result.ok ? [...result.value].sort((a, b) => a.position - b.position) : []);
    }).catch(() => undefined);
    if (projectId) {
      void window.myNotebook.models.listRouteAttempts?.({ projectId, taskKind, limit: 10 }).then((result) => {
        if (!alive) return;
        setAttempts(result.ok ? result.value : []);
      }).catch(() => undefined);
    } else {
      setAttempts([]);
    }
    return () => { alive = false; };
  }, [taskKind, projectId]);

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

  const taskLabels: Record<ModelTaskKind, string> = {
    chat: t("routing.tasks.chat"),
    "note-title": t("routing.tasks.note-title"),
    summary: t("routing.tasks.summary"),
    "key-points": t("routing.tasks.key-points"),
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
            options={ALL_TASKS.map((kind) => ({ value: kind, label: taskLabels[kind] }))}
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

        <div className="input-row">
          <RoundedSelect
            ariaLabel={addProfileLabel}
            value=""
            options={[
              { value: "", label: addProfileLabel },
              ...unused.map((profile) => ({ value: profile.id, label: routeModelLabel(profile, profile.id) }))
            ]}
            onChange={addProfile}
          />
          <button type="button" className="btn primary" disabled={busy || !dirty || route.length === 0} onClick={() => void save()}>
            {busy ? <span className="spinner light" aria-hidden="true" /> : <Icon name="check" />}
            {t("routing.saveRoute")}
          </button>
        </div>
      </div>

      {projectId && attempts.length > 0 && (
        <div className="pref-card card">
          <h3>{t("routing.fallbackHistory")}</h3>
          {attempts.map((attempt) => (
            <div className="route-attempt" key={attempt.id}>
              <span className={`badge ${attempt.state === "completed" ? "ok" : attempt.state === "failed" ? "danger" : "neutral"}`}>
                {t(`routing.states.${attempt.state}`, attempt.state)}
              </span>
              <span className="model">{providerLabel(t, attempt.provider)} / {attempt.model}</span>
              {attempt.errorCode && <span style={{ color: "var(--danger)" }}>{attempt.errorCode}</span>}
              <span className="when">{new Date(attempt.startedAt).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RoundedSelect({ value, options, ariaLabel, onChange, className = "" }: {
  value: string;
  options: Array<{ value: string; label: string }>;
  ariaLabel: string;
  onChange: (value: string) => void;
  className?: string;
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
    <div className={`rounded-select ${className}`.trim()} ref={rootRef}>
      <button
        type="button"
        className="select rounded-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="select-value">{selected?.label}</span>
        <Icon name={open ? "chevron-up" : "chevron-down"} />
      </button>
      {open && (
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
