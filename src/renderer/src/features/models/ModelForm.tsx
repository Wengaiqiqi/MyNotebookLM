import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  BuiltInModelProfileDto,
  ModelCapability,
  ModelDescriptorDto,
  ModelProfileDto,
  ProviderKind
} from "../../../../shared/models";
import Icon from "../../ui/Icon";
import { toast } from "../../ui/Toast";

export type SavedProfile = { profile: ModelProfileDto; credentialMask?: string };

const PROVIDER_DEFAULT_BASE_URL: Partial<Record<ProviderKind, string>> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  ollama: "http://localhost:11434"
};

const GENERATION_PROVIDERS: ProviderKind[] = ["openai", "openai-compatible", "anthropic", "gemini", "ollama"];
const EMBEDDING_PROVIDERS: ProviderKind[] = ["openai", "openai-compatible", "ollama"];

export const providerLabelKey = (provider: ProviderKind): string => `model.providers.${provider}`;

/**
 * Create-or-edit form for one model profile. Calls models.discover for model
 * listing and models.saveProfile (which persists the credential server-side).
 */
export default function ModelForm({ capability, existing, onSaved, onCancel }: {
  capability: ModelCapability;
  existing?: ModelProfileDto | BuiltInModelProfileDto | undefined;
  onSaved: (profile: ModelProfileDto) => void;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const builtIn = existing && "editable" in existing ? existing : undefined;
  const userExisting = existing && !("editable" in existing) ? existing : undefined;
  const isEdit = Boolean(userExisting);

  const [provider, setProvider] = useState<ProviderKind>(userExisting?.provider ?? "openai");
  const [name, setName] = useState(userExisting?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(userExisting?.baseUrl ?? (PROVIDER_DEFAULT_BASE_URL.openai ?? ""));
  const [modelId, setModelId] = useState(userExisting?.modelId ?? "");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [discovered, setDiscovered] = useState<ModelDescriptorDto[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoveredNote, setDiscoveredNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const providers = capability === "generation" ? GENERATION_PROVIDERS : EMBEDDING_PROVIDERS;
  const needsKey = provider !== "ollama" && provider !== "local";
  const namePlaceholder = useMemo(() =>
    `${t(`model.providers.${provider}`)} · ${capability === "generation" ? t("model.generation.title") : t("model.embedding.title")}`,
  [provider, capability, t]);

  function chooseProvider(next: ProviderKind): void {
    setProvider(next);
    setBaseUrl(PROVIDER_DEFAULT_BASE_URL[next] ?? "");
    setDiscovered([]);
    setDiscoveredNote("");
  }

  async function discover(): Promise<void> {
    if (!baseUrl.trim()) { setError(t("model.validation.address")); return; }
    if (needsKey && !apiKey.trim() && !isEdit) { setError(t("model.validation.apiKey")); return; }
    setDiscovering(true); setError(""); setDiscoveredNote("");
    const result = await window.myNotebook.models.discover({
      provider,
      capability,
      baseUrl: baseUrl.trim(),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
    }).catch(() => undefined);
    setDiscovering(false);
    if (!result?.ok) { setError(t(result?.error.messageKey ?? "errors.internal")); return; }
    const usable = result.value.filter((descriptor) => descriptor.capabilities.includes(capability));
    setDiscovered(usable);
    setDiscoveredNote(t("model.fetchSuccess"));
    if (usable.length > 0 && !modelId) setModelId(usable[0]!.id);
  }

  async function save(): Promise<void> {
    if (!name.trim() || !modelId.trim() || saving) return;
    if (!baseUrl.trim() && provider !== "local") { setError(t("model.validation.address")); return; }
    setSaving(true); setError("");
    const profile = {
      id: userExisting?.id ?? crypto.randomUUID(),
      name: name.trim(),
      provider,
      capability,
      baseUrl: baseUrl.trim(),
      modelId: modelId.trim(),
      enabled: true
    };
    const result = await window.myNotebook.models.saveProfile({
      profile,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
    }).catch(() => undefined);
    setSaving(false);
    if (!result?.ok) { setError(t(result?.error.messageKey ?? "errors.internal")); return; }
    toast.success(t("model.savedProfile"));
    onSaved(result.value);
  }

  if (builtIn) {
    return (
      <div className="model-card card">
        <div className="model-card-head">
          <span className="model-card-glyph" aria-hidden="true"><Icon name="cpu" /></span>
          <div>
            <h3>{builtIn.name}</h3>
            <p>{t("model.builtInHint", { dimension: builtIn.dimension })}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="model-card card">
      <div className="model-card-head">
        <span className="model-card-glyph" aria-hidden="true"><Icon name={capability === "generation" ? "brain" : "database"} /></span>
        <div>
          <h3>{isEdit ? t("model.editProfile") : capability === "generation" ? t("model.generation.title") : t("model.embedding.title")}</h3>
          <p>{capability === "generation" ? t("model.generation.description") : t("model.embedding.description")}</p>
        </div>
      </div>

      {!isEdit && (
        <div className="provider-opts" role="group" aria-label={t("model.provider")}>
          {providers.map((option) => (
            <button key={option} type="button" className="provider-chip" aria-pressed={provider === option} onClick={() => chooseProvider(option)}>
              {t(providerLabelKey(option))}
            </button>
          ))}
        </div>
      )}

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

      <div className="field">
        <div className="input-row">
          <input
            className="input"
            list={`model-descriptors-${capability}`}
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            placeholder={t("model.modelName")}
            aria-label={t("model.modelName")}
            spellCheck={false}
          />
          <datalist id={`model-descriptors-${capability}`}>
            {discovered.map((descriptor) => <option key={descriptor.id} value={descriptor.id}>{descriptor.displayName}</option>)}
          </datalist>
          <button type="button" className="btn outline" disabled={discovering} onClick={() => void discover()}>
            {discovering ? <span className="spinner" aria-hidden="true" /> : <Icon name="retry" />}
            {discovering ? t("model.fetching") : t("model.getModels")}
          </button>
        </div>
        {discoveredNote && <span className="form-ok"><Icon name="check" />{discoveredNote}</span>}
      </div>

      {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}

      <div className="dialog-foot" style={{ marginTop: 2 }}>
        {onCancel && <button type="button" className="btn" onClick={onCancel}>{t("common.cancel")}</button>}
        <button type="button" className="btn primary" disabled={saving || !name.trim() || !modelId.trim()} onClick={() => void save()}>
          {saving ? <span className="spinner light" aria-hidden="true" /> : <Icon name="check" />}
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}
