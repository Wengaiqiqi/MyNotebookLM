import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  BuiltInModelProfileDto,
  ModelCapability,
  ModelDescriptorDto,
  ModelProfileDto,
  ProviderKind
} from "../../../../shared/models";
import Icon from "../../ui/Icon";
import { modelOutputKind } from "../../../../shared/models";
import { toast } from "../../ui/Toast";

export type SavedProfile = { profile: ModelProfileDto; credentialMask?: string };

const PROVIDER_DEFAULT_BASE_URL: Partial<Record<ProviderKind, string>> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  ollama: "http://localhost:11434"
};

const GENERATION_PROVIDERS: ProviderKind[] = ["openai", "openai-compatible", "anthropic", "gemini", "ollama"];
const EMBEDDING_PROVIDERS: ProviderKind[] = ["openai", "openai-compatible", "gemini", "ollama", "local"];

export const providerLabelKey = (provider: ProviderKind): string => `model.providers.${provider}`;

function cleanDisplayName(name: string): string {
  return name.replace(/\s+\/\s+\d+$/, "").trim() || name;
}

/**
 * Create-or-edit form for one model profile or a provider group. Calls models.discover for model
 * listing and models.saveProfile (which persists the credential server-side).
 */
export default function ModelForm({ capability, existing, existingProfiles, initialProvider, builtIn: builtInModel, onProfileSelected, onSaved, onCancel }: {
  capability: ModelCapability;
  existing?: ModelProfileDto | BuiltInModelProfileDto | undefined;
  existingProfiles?: ModelProfileDto[] | undefined;
  initialProvider?: ProviderKind;
  builtIn?: BuiltInModelProfileDto | undefined;
  onProfileSelected?: (profile: ModelProfileDto | BuiltInModelProfileDto | undefined) => void;
  onSaved: (profile: ModelProfileDto) => void;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const existingBuiltIn = existing && "editable" in existing ? existing : undefined;
  const userExisting = existing && !("editable" in existing) ? existing : undefined;
  const allExistingProfiles: ModelProfileDto[] = existingProfiles && existingProfiles.length > 0
    ? existingProfiles
    : (userExisting ? [userExisting] : []);
  const primaryExisting = allExistingProfiles[0];
  const existingText = allExistingProfiles.filter((profile) => capability !== "generation" || modelOutputKind(profile) === "text");
  const existingSpeech = allExistingProfiles.filter((profile) => capability === "generation" && modelOutputKind(profile) === "speech");
  const isEdit = allExistingProfiles.length > 0;

  const initialProviderValue = primaryExisting?.provider ?? initialProvider ?? "openai";
  const [provider, setProvider] = useState<ProviderKind>(initialProviderValue);
  const [localMode, setLocalMode] = useState<"builtin" | "custom">(
    primaryExisting?.provider === "local" && primaryExisting.baseUrl
      ? "custom"
      : initialProviderValue === "local" && builtInModel
        ? "builtin"
        : "custom"
  );
  const [name, setName] = useState(primaryExisting ? cleanDisplayName(primaryExisting.name) : "");
  const [baseUrl, setBaseUrl] = useState(primaryExisting?.baseUrl ?? (initialProviderValue === "local" ? "" : PROVIDER_DEFAULT_BASE_URL.openai ?? ""));
  const [modelId, setModelId] = useState(existingText[0]?.modelId ?? (initialProviderValue === "local" && builtInModel ? builtInModel.modelId : ""));
  const [speechModelId, setSpeechModelId] = useState(existingSpeech[0]?.modelId ?? "");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  const initialDescriptors: ModelDescriptorDto[] = useMemo(() => {
    return allExistingProfiles.map((p) => ({
      id: p.modelId,
      displayName: p.modelId,
      capabilities: [capability],
      capabilityEvidence: "authoritative" as const
    }));
  }, [allExistingProfiles, capability]);

  const [discovered, setDiscovered] = useState<ModelDescriptorDto[]>(initialDescriptors);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>(existingText.map((p) => p.modelId));
  const [selectedSpeechModelIds, setSelectedSpeechModelIds] = useState<string[]>(existingSpeech.map((p) => p.modelId));
  const [discovering, setDiscovering] = useState<"text" | "speech" | null>(null);
  const [discoveredNotes, setDiscoveredNotes] = useState({ text: "", speech: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const localTouched = useRef(Boolean(primaryExisting?.provider === "local"));

  const providers = capability === "generation" ? GENERATION_PROVIDERS : EMBEDDING_PROVIDERS;
  const needsKey = provider !== "ollama" && provider !== "local";
  const supportsSpeech = capability === "generation" && ["openai", "openai-compatible", "gemini"].includes(provider);
  const modelSelections = [
    ...(selectedModelIds.length ? selectedModelIds : modelId.trim() ? [modelId.trim()] : []).map((id) => ({ modelId: id, outputKind: "text" as const })),
    ...(supportsSpeech ? (selectedSpeechModelIds.length ? selectedSpeechModelIds : speechModelId.trim() ? [speechModelId.trim()] : []) : []).map((id) => ({ modelId: id, outputKind: "speech" as const }))
  ];
  const namePlaceholder = useMemo(() =>
    `${t(`model.providers.${provider}`)} · ${capability === "generation" ? t("model.generation.title") : t("model.embedding.title")}`,
  [provider, capability, t]);

  useEffect(() => {
    if (provider !== "local" || !builtInModel || localTouched.current || baseUrl.trim() || modelId.trim()) return;
    setLocalMode("builtin");
    setModelId(builtInModel.modelId);
    onProfileSelected?.(builtInModel);
  }, [baseUrl, builtInModel, modelId, onProfileSelected, provider]);

  function chooseProvider(next: ProviderKind): void {
    if (next === provider) return;
    setProvider(next);
    setDiscovered([]);
    setDiscoveredNotes({ text: "", speech: "" });
    setSpeechModelId("");
    setSelectedSpeechModelIds([]);
    setError("");
    localTouched.current = true;
    if (next === "local") {
      const nextMode = builtInModel ? "builtin" : "custom";
      setLocalMode(nextMode);
      setBaseUrl("");
      setModelId(nextMode === "builtin" ? builtInModel!.modelId : "");
      setSelectedModelIds([]);
      onProfileSelected?.(nextMode === "builtin" ? builtInModel : undefined);
      return;
    }
    setLocalMode("custom");
    setBaseUrl(PROVIDER_DEFAULT_BASE_URL[next] ?? "");
    setModelId("");
    setSelectedModelIds([]);
    onProfileSelected?.(undefined);
  }

  function chooseLocalMode(next: "builtin" | "custom"): void {
    localTouched.current = true;
    setError("");
    if (next === "builtin" && builtInModel) {
      setLocalMode("builtin");
      setBaseUrl("");
      setModelId(builtInModel.modelId);
      setSelectedModelIds([]);
      onProfileSelected?.(builtInModel);
      return;
    }
    setLocalMode("custom");
    setBaseUrl("");
    setModelId("");
    setSelectedModelIds([]);
    onProfileSelected?.(undefined);
  }

  async function chooseLocalModel(): Promise<void> {
    const chooser = window.myNotebook.models.chooseLocalModel;
    if (!chooser) { setError(t("errors.internal")); return; }
    const result = await chooser().catch(() => undefined);
    if (!result?.ok) { setError(t(result?.error.messageKey ?? "errors.internal")); return; }
    if (!result.value) return;
    localTouched.current = true;
    setLocalMode("custom");
    setBaseUrl(result.value);
    setSelectedModelIds([]);
    if (!modelId.trim()) setModelId(modelNameFromPath(result.value));
    setError("");
    onProfileSelected?.(undefined);
  }

  async function discover(kind: "text" | "speech"): Promise<void> {
    if (provider === "local") return;
    if (!baseUrl.trim()) { setError(t("model.validation.address")); return; }
    if (needsKey && !apiKey.trim() && !isEdit) { setError(t("model.validation.apiKey")); return; }
    setDiscovering(kind); setError(""); setDiscoveredNotes((current) => ({ ...current, [kind]: "" }));
    const result = await window.myNotebook.models.discover({
      provider,
      capability,
      baseUrl: baseUrl.trim(),
      ...(primaryExisting?.id ? { profileId: primaryExisting.id } : {}),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
    }).catch(() => undefined);
    setDiscovering(null);
    if (!result?.ok) { setError(t(result?.error.messageKey ?? "errors.internal")); return; }
    // Model catalogs usually cannot prove capabilities from the listing alone
    // (OpenAI-compatible and official DeepSeek endpoints return an empty
    // capabilities array). Keep those probe-required entries selectable; the
    // save/test path performs the authoritative capability check.
    const usable = result.value.filter((descriptor) =>
      descriptor.capabilityEvidence === "probe-required"
      || descriptor.capabilities.includes(capability)
    );
    const mergedMap = new Map<string, ModelDescriptorDto>();
    for (const descriptor of usable) {
      mergedMap.set(descriptor.id, descriptor);
    }
    for (const d of initialDescriptors) {
      if (!mergedMap.has(d.id)) {
        mergedMap.set(d.id, d);
      }
    }
    setDiscovered(Array.from(mergedMap.values()));
    setDiscoveredNotes((current) => ({ ...current, [kind]: t("model.fetchSuccess") }));
  }

  async function save(): Promise<void> {
    if (provider === "local" && localMode === "builtin" && builtInModel) {
      onProfileSelected?.(builtInModel);
      return;
    }
    if (!name.trim() || modelSelections.length === 0 || saving) return;
    if (!baseUrl.trim()) { setError(provider === "local" ? t("model.validation.localModelPath") : t("model.validation.address")); return; }
    setSaving(true); setError("");

    let savedProfile: ModelProfileDto | undefined;
    for (const selection of modelSelections) {
      const selectedId = selection.modelId;
      const match = allExistingProfiles.find((profile) => profile.modelId === selectedId && (capability !== "generation" || modelOutputKind(profile) === selection.outputKind));
      const profile = {
        id: match?.id ?? crypto.randomUUID(),
        name: name.trim(),
        provider,
        capability,
        baseUrl: baseUrl.trim(),
        modelId: selectedId,
        ...(capability === "generation" ? { outputKind: selection.outputKind } : {}),
        ...(match?.speechVoices && match.provider === provider && match.baseUrl === baseUrl.trim()
          && selection.outputKind === "speech"
          ? { speechVoices: match.speechVoices } : {}),
        enabled: match ? match.enabled : true
      };
      const result = await window.myNotebook.models.saveProfile({
        profile,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
      }).catch(() => undefined);
      if (!result?.ok) {
        setSaving(false);
        setError(t(result?.error.messageKey ?? "errors.internal"));
        return;
      }
      // Onboarding needs a text model for the default chat route.
      if (!savedProfile || selection.outputKind === "text") savedProfile = result.value;
    }
    // Preserve existing profiles until all new selections have saved successfully.
    const removedProfiles = allExistingProfiles.filter((profile) => !modelSelections.some((selection) => selection.modelId === profile.modelId && (capability !== "generation" || selection.outputKind === modelOutputKind(profile))));
    for (const removed of removedProfiles) {
      const result = await window.myNotebook.models.deleteProfile({ id: removed.id }).catch(() => undefined);
      if (!result?.ok) { setSaving(false); setError(t(result?.error.messageKey ?? "errors.internal")); return; }
    }
    setSaving(false);
    if (!savedProfile) return;
    toast.success(t("model.savedProfile"));
    onSaved(savedProfile);
    onProfileSelected?.(savedProfile);
  }

  if (existingBuiltIn) {
    return (
      <div className="model-card card">
        <div className="model-card-head">
          <span className="model-card-glyph" aria-hidden="true"><Icon name="cpu" /></span>
          <div>
            <h3>{existingBuiltIn.name}</h3>
            <p>{t("model.builtInHint", { dimension: existingBuiltIn.dimension })}</p>
          </div>
        </div>
      </div>
    );
  }

  const showingBuiltin = provider === "local" && localMode === "builtin" && Boolean(builtInModel);

  return (
    <div className="model-card card">
      <div className="model-card-head">
        <span className="model-card-glyph" aria-hidden="true"><Icon name={capability === "generation" ? "brain" : "database"} /></span>
        <div>
          <h3>{isEdit ? t("model.editProvider") : capability === "generation" ? t("model.generation.title") : t("model.embedding.title")}</h3>
          <p>{capability === "generation" ? t("model.generation.description") : t("model.embedding.description")}</p>
        </div>
      </div>

      {!isEdit && (
        <div className="provider-opts" role="group" aria-label={t("model.provider")}>
          {providers.map((option) => (
            <React.Fragment key={option}>
              {capability === "embedding" && option === "local" && <span className="provider-row-break" aria-hidden="true" />}
              <button type="button" className="provider-chip" data-provider={option} aria-pressed={provider === option} onClick={() => chooseProvider(option)}>
                {t(providerLabelKey(option))}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}

      {provider === "local" && builtInModel && (
        <div className="local-model-options" role="group" aria-label={t("model.localModelMode")}>
          <button type="button" aria-pressed={showingBuiltin} onClick={() => chooseLocalMode("builtin")}>
            <Icon name="cpu" />{t("model.localModelBuiltIn")}
          </button>
          <button type="button" aria-pressed={!showingBuiltin} onClick={() => chooseLocalMode("custom")}>
            <Icon name="file" />{t("model.localModelCustom")}
          </button>
        </div>
      )}

      {showingBuiltin ? (
        <div className="local-model-card card">
          <span className="model-card-glyph" aria-hidden="true"><Icon name="cpu" /></span>
          <span className="local-model-copy">
            <strong>{builtInModel!.name}</strong>
            <small>{t("model.builtInHint", { dimension: builtInModel!.dimension })}</small>
          </span>
          <span className="badge accent"><Icon name="check" />{t("model.builtInSelected")}</span>
        </div>
      ) : (
        <>
          <label className="field" htmlFor={`model-name-${capability}`}>
            {t("model.profileName")}
            <input
              id={`model-name-${capability}`}
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={namePlaceholder}
              maxLength={100}
            />
          </label>

          {provider === "local" ? (
            <label className="field" htmlFor={`model-local-path-${capability}`}>
              {t("model.localModelPath")}
              <div className="input-row local-model-path">
                <input
                  id={`model-local-path-${capability}`}
                  className="input"
                  value={baseUrl}
                  readOnly
                  placeholder={t("model.localModelPathPlaceholder")}
                  aria-label={t("model.localModelPath")}
                  spellCheck={false}
                />
                <button type="button" className="btn outline" onClick={() => void chooseLocalModel()}>
                  <Icon name="file" />{t("model.chooseLocalModel")}
                </button>
              </div>
            </label>
          ) : (
            <label className="field" htmlFor={`model-baseurl-${capability}`}>
              {t("model.apiAddress")}
              <input
                id={`model-baseurl-${capability}`}
                className="input"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://"
                spellCheck={false}
              />
            </label>
          )}

          {needsKey && (
            <label className="field" htmlFor={`model-key-${capability}`}>
              {t("model.apiKey")}
              <span className="secret">
                <input
                  id={`model-key-${capability}`}
                  className="input"
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={isEdit ? t("model.apiKeyKeep") : "sk-…"}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="button" className="reveal" aria-label={showKey ? t("model.hideApiKey") : t("model.showApiKey")} onClick={() => setShowKey((value) => !value)}>
                  <Icon name={showKey ? "eye-off" : "eye"} />
                </button>
              </span>
            </label>
          )}

          {(supportsSpeech ? ["text", "speech"] as const : ["text"] as const).map((kind) => {
            const speech = kind === "speech";
            const label = capability === "generation" ? t(speech ? "model.selectSpeechModel" : "model.selectTextModel") : t("model.modelName");
            return <div className="field" key={kind} role="group" aria-label={capability === "generation" ? t(speech ? "model.speechOutput" : "model.textOutput") : t("model.embedding.title")}>
              <div className="input-row">
                {provider === "local" ? (
                  <input
                    className="input"
                    value={modelId}
                    onChange={(event) => { setSelectedModelIds([]); setModelId(event.target.value); }}
                    placeholder={t("model.modelName")}
                    aria-label={t("model.modelName")}
                    spellCheck={false}
                  />
                ) : (
                  <ModelPicker
                    id={`model-id-${capability}-${kind}`}
                    value={speech ? speechModelId : modelId}
                    selectedIds={speech ? selectedSpeechModelIds : selectedModelIds}
                    descriptors={discovered}
                    multiple
                    placeholder={label}
                    ariaLabel={label}
                    selectedLabel={(count) => t("model.selectedModels", { count })}
                    emptyLabel={t("model.noDiscoveredModels")}
                    doneLabel={t("common.confirm")}
                    onValueChange={(value) => { if (speech) { setSelectedSpeechModelIds([]); setSpeechModelId(value); } else { setSelectedModelIds([]); setModelId(value); } }}
                    onSelectionChange={(values) => { if (speech) { setSelectedSpeechModelIds(values); setSpeechModelId(values[0] ?? ""); } else { setSelectedModelIds(values); setModelId(values[0] ?? ""); } }}
                  />
                )}
                {provider !== "local" && (
                  <button type="button" className="btn outline" disabled={discovering !== null} onClick={() => void discover(kind)}>
                    {discovering === kind ? <span className="spinner" aria-hidden="true" /> : <Icon name="retry" />}
                    {discovering === kind ? t("model.fetching") : t("model.getModels")}
                  </button>
                )}
              </div>
              {discoveredNotes[kind] && <span className="form-ok"><Icon name="check" />{discoveredNotes[kind]}</span>}
            </div>;
          })}

          <div className="dialog-foot" style={{ marginTop: 2 }}>
            {onCancel && <button type="button" className="btn" onClick={onCancel}>{t("common.cancel")}</button>}
            <button type="button" className="btn primary" disabled={saving || !name.trim() || modelSelections.length === 0 || (provider === "local" && !baseUrl.trim())} onClick={() => void save()}>
              {saving ? <span className="spinner light" aria-hidden="true" /> : <Icon name="check" />}
              {t("common.save")}
            </button>
          </div>
        </>
      )}

      {showingBuiltin && onCancel && (
        <div className="dialog-foot" style={{ marginTop: 2 }}>
          <button type="button" className="btn" onClick={onCancel}>{t("common.cancel")}</button>
        </div>
      )}

      {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
    </div>
  );
}

function modelNameFromPath(value: string): string {
  const normalized = value.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || "local-model";
}

function ModelPicker({ id, value, selectedIds, descriptors, multiple, placeholder, ariaLabel, selectedLabel, emptyLabel, doneLabel, onValueChange, onSelectionChange }: {
  id: string;
  value: string;
  selectedIds: string[];
  descriptors: ModelDescriptorDto[];
  multiple: boolean;
  placeholder: string;
  ariaLabel: string;
  selectedLabel: (count: number) => string;
  emptyLabel: string;
  doneLabel: string;
  onValueChange: (value: string) => void;
  onSelectionChange: (values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<"up" | "down">("down");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    if (root) {
      const rect = root.getBoundingClientRect();
      setPlacement(window.innerHeight - rect.bottom < 300 && rect.top > 300 ? "up" : "down");
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

  const displayValue = selectedIds.length > 1
    ? selectedLabel(selectedIds.length)
    : selectedIds[0] ?? value;

  function toggle(idToToggle: string): void {
    const checked = selectedIds.includes(idToToggle);
    const next = checked
      ? selectedIds.filter((item) => item !== idToToggle)
      : multiple ? [...selectedIds, idToToggle] : [idToToggle];
    onSelectionChange(next);
    if (!multiple) setOpen(false);
  }

  return (
    <div className="model-picker-field" ref={rootRef}>
      <div className="model-picker-control">
        <input
          id={id}
          className="input model-picker-input"
          value={displayValue}
          readOnly={selectedIds.length > 1}
          onChange={(event) => onValueChange(event.target.value)}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          role="combobox"
          aria-label={ariaLabel}
          aria-autocomplete="none"
          aria-expanded={open}
          aria-controls={`${id}-menu`}
          spellCheck={false}
        />
        <button
          type="button"
          className="model-picker-toggle"
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <Icon name={open ? "chevron-up" : "chevron-down"} />
        </button>
      </div>
      {open && (
        <div id={`${id}-menu`} className="model-picker-menu" data-placement={placement} role="listbox" aria-label={ariaLabel} aria-multiselectable={multiple}>
          {descriptors.length === 0 ? (
            <p className="model-picker-empty">{emptyLabel}</p>
          ) : descriptors.map((descriptor) => {
            const checked = selectedIds.includes(descriptor.id);
            return (
              <label className={`model-picker-option${checked ? " selected" : ""}`} key={descriptor.id} role="option" aria-selected={checked}>
                <input type="checkbox" checked={checked} onChange={() => toggle(descriptor.id)} />
                <span className="model-picker-option-copy">
                  <strong>{descriptor.id}</strong>
                  {descriptor.displayName !== descriptor.id && <small>{descriptor.displayName}</small>}
                </span>
              </label>
            );
          })}
          {multiple && selectedIds.length > 0 && (
            <button type="button" className="model-picker-done" onClick={() => setOpen(false)}>
              {doneLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
