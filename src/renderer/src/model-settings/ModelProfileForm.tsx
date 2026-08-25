import * as React from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopApi } from "../../../shared/ipc";
import type {
  BuiltInModelProfileDto,
  CredentialStatusDto,
  ModelCapability,
  ModelProfileDto,
  ModelProfileInput,
  ProviderKind
} from "../../../shared/models";
import { modelErrorText } from "./model-error-text";

const providerDefaults: Record<Exclude<ProviderKind, "local">, string> = {
  openai: "https://api.openai.com/v1",
  "openai-compatible": "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  ollama: "http://127.0.0.1:11434"
};

const providersByCapability: Record<ModelCapability, ProviderKind[]> = {
  generation: ["openai-compatible", "openai", "anthropic", "gemini", "ollama"],
  embedding: ["local", "openai-compatible", "openai", "gemini", "ollama"]
};

const providerMarks: Record<ProviderKind, string> = {
  openai: "◎",
  "openai-compatible": "◎",
  anthropic: "A",
  gemini: "✦",
  ollama: "◌",
  local: "⌂"
};

const fixedCredentialMask = "••••••••";
function needsCredential(provider: ProviderKind): boolean {
  return provider !== "ollama" && provider !== "local";
}

function validAddress(provider: ProviderKind, baseUrl: string): boolean {
  if (provider === "local") return true;
  try {
    const address = new URL(baseUrl);
    return address.protocol === "http:" || address.protocol === "https:";
  } catch {
    return false;
  }
}

function newProfileId(): string {
  return crypto.randomUUID();
}

export type ModelProfileDraft = Readonly<{
  profile: ModelProfileInput | BuiltInModelProfileDto;
  apiKey?: string;
  hasStoredCredential: boolean;
  valid: boolean;
}>;

type Props = Readonly<{
  capability: ModelCapability;
  profiles: readonly ModelProfileDto[];
  builtInProfiles: readonly BuiltInModelProfileDto[];
  credentials: readonly CredentialStatusDto[];
  initialProfileId?: string;
  disabled?: boolean;
  onChange(draft: ModelProfileDraft): void;
}>;

export default function ModelProfileForm({
  capability,
  profiles,
  builtInProfiles,
  credentials,
  initialProfileId,
  disabled = false,
  onChange
}: Props) {
  const { t } = useTranslation();
  const prefix = useId();
  const availableProfiles = useMemo(
    () => profiles.filter((profile) => profile.capability === capability),
    [capability, profiles]
  );
  const builtIn = builtInProfiles.find((profile) => profile.capability === capability);
  const initial = availableProfiles.find((profile) => profile.id === initialProfileId);
  const initialBuiltIn = builtIn?.id === initialProfileId ? builtIn : undefined;
  const initialProvider: ProviderKind = initial?.provider ?? initialBuiltIn?.provider ?? "openai-compatible";
  const [profileId, setProfileId] = useState(initial?.id ?? initialBuiltIn?.id ?? newProfileId);
  const [selectedProfileId, setSelectedProfileId] = useState(initial?.id ?? "");
  const [provider, setProvider] = useState<ProviderKind>(initialProvider);
  const [baseUrl, setBaseUrl] = useState(
    initial?.baseUrl ?? initialBuiltIn?.baseUrl
      ?? providerDefaults[initialProvider as Exclude<ProviderKind, "local">]
  );
  const [modelId, setModelId] = useState(initial?.modelId ?? initialBuiltIn?.modelId ?? "");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [credentialConnection, setCredentialConnection] = useState(
    initial ? `${initial.provider}\n${initial.baseUrl}` : ""
  );
  const [manual, setManual] = useState(false);
  const [models, setModels] = useState<Array<{ id: string; displayName: string }>>(
    initial ? [{ id: initial.modelId, displayName: initial.modelId }] : []
  );
  const [discoveryState, setDiscoveryState] = useState<"idle" | "busy" | "success">("idle");
  const [error, setError] = useState("");
  const discoveryEpoch = useRef(0);
  const mounted = useRef(true);
  const previousCapability = useRef(capability);
  const keyInput = useRef<HTMLInputElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const modelInput = useRef<HTMLInputElement>(null);
  const storedCredential = credentials.some(
    (credential) => credential.profileId === profileId && credential.hasCredential
  );
  const hasStoredCredential = storedCredential
    && credentialConnection === `${provider}\n${baseUrl}`;
  const requiresKey = needsCredential(provider);
  const valid = provider === "local"
    ? Boolean(builtIn)
    : validAddress(provider, baseUrl)
      && Boolean(modelId.trim())
      && (!requiresKey || Boolean(apiKey.trim()) || hasStoredCredential);

  useEffect(() => {
    if (provider === "local" && builtIn) {
      onChange({ profile: builtIn, hasStoredCredential: false, valid: true });
      return;
    }
    const profile: ModelProfileInput = {
      id: profileId,
      name: modelId.trim() || t(`model.newProfile.${capability}`),
      provider,
      capability,
      baseUrl,
      modelId,
      enabled: true
    };
    onChange({
      profile,
      ...(apiKey.trim() ? { apiKey } : {}),
      hasStoredCredential,
      valid
    });
  }, [
    apiKey,
    baseUrl,
    builtIn,
    capability,
    hasStoredCredential,
    modelId,
    onChange,
    profileId,
    provider,
    t,
    valid
  ]);

  useEffect(() => {
    if (manual) modelInput.current?.focus();
  }, [manual]);

  useEffect(() => () => {
    mounted.current = false;
    discoveryEpoch.current += 1;
  }, []);

  useEffect(() => {
    if (previousCapability.current === capability) return;
    previousCapability.current = capability;
    resetDiscovery();
  }, [capability]);

  function resetDiscovery(): void {
    discoveryEpoch.current += 1;
    setDiscoveryState("idle");
    setModels([]);
    setError("");
  }

  function chooseProvider(next: ProviderKind): void {
    const previousDefault = provider === "local" ? "" : providerDefaults[provider];
    const nextDefault = next === "local" ? "" : providerDefaults[next];
    if (!baseUrl || baseUrl === previousDefault) setBaseUrl(nextDefault);
    setProvider(next);
    setSelectedProfileId("");
    setProfileId(next === "local" && builtIn ? builtIn.id : newProfileId());
    setCredentialConnection("");
    setApiKey("");
    setShowApiKey(false);
    setModelId(next === "local" && builtIn ? builtIn.modelId : "");
    setManual(false);
    resetDiscovery();
  }

  function chooseSavedProfile(id: string): void {
    setSelectedProfileId(id);
    if (!id) {
      chooseProvider("openai-compatible");
      return;
    }
    const selected = availableProfiles.find((profile) => profile.id === id);
    if (!selected) return;
    setProfileId(selected.id);
    setProvider(selected.provider);
    setBaseUrl(selected.baseUrl);
    setModelId(selected.modelId);
    setApiKey("");
    setShowApiKey(false);
    setCredentialConnection(`${selected.provider}\n${selected.baseUrl}`);
    setModels([{ id: selected.modelId, displayName: selected.modelId }]);
    setManual(false);
    setDiscoveryState("idle");
    setError("");
  }

  async function discoverModels(): Promise<void> {
    setError("");
    if (!validAddress(provider, baseUrl)) {
      setError(t("model.validation.address"));
      addressInput.current?.focus();
      return;
    }
    if (requiresKey && !apiKey.trim() && !hasStoredCredential) {
      setError(t("model.validation.apiKey"));
      keyInput.current?.focus();
      return;
    }
    if (provider === "local") return;

    const requestEpoch = ++discoveryEpoch.current;
    setDiscoveryState("busy");
    let result: Awaited<ReturnType<DesktopApi["models"]["discover"]>>;
    try {
      result = await window.myNotebook.models.discover({
        ...(hasStoredCredential ? { profileId } : {}),
        provider,
        capability,
        baseUrl,
        ...(apiKey.trim() ? { apiKey } : {})
      });
    } catch {
      if (!mounted.current || requestEpoch !== discoveryEpoch.current) return;
      setDiscoveryState("idle");
      setError(t("model.errors.request"));
      return;
    }
    if (!mounted.current || requestEpoch !== discoveryEpoch.current) return;
    if (!result.ok) {
      setDiscoveryState("idle");
      setError(modelErrorText(t, result.error.messageKey));
      return;
    }
    const filtered = result.value.filter((candidate) =>
      candidate.capabilityEvidence === "probe-required"
      || candidate.capabilities.includes(capability)
    );
    setModels(filtered.map(({ id, displayName }) => ({ id, displayName })));
    setModelId(filtered[0]?.id ?? "");
    setManual(filtered.length === 0);
    setDiscoveryState("success");
  }

  return (
    <section className="model-profile-form" aria-label={t(`model.${capability}.title`)}>
      <div className="model-form-heading">
        <span className="model-step" aria-hidden="true">{capability === "generation" ? "01" : "02"}</span>
        <span className="provider-mark" data-provider={provider} aria-hidden="true">
          {(provider === "openai" || provider === "openai-compatible")
            ? capability === "generation" ? "✾" : "♞"
            : providerMarks[provider]}
        </span>
        <div>
          <h3>{t(`model.${capability}.title`)}</h3>
          <p>{t(`model.${capability}.description`)}</p>
        </div>
      </div>

      <fieldset className="model-profile-fields" disabled={disabled || discoveryState === "busy"}>
      {availableProfiles.length > 0 && (
        <label htmlFor={`${prefix}-saved`}>
          {t("model.savedProfile")}
          <select
            id={`${prefix}-saved`}
            value={selectedProfileId}
            onChange={(event) => chooseSavedProfile(event.target.value)}
          >
            <option value="">{t("model.newProfileOption")}</option>
            {availableProfiles.map((profile) => (
              <option value={profile.id} key={profile.id}>{profile.name}</option>
            ))}
          </select>
        </label>
      )}

      <label htmlFor={`${prefix}-provider`}>
        {t("model.provider")}
        <select
          id={`${prefix}-provider`}
          value={provider}
          onChange={(event) => chooseProvider(event.target.value as ProviderKind)}
        >
          {providersByCapability[capability].map((kind) => (
            <option value={kind} key={kind}>
              {kind === "local" && builtIn
                ? `${t("model.providers.local")} · ${builtIn.modelId}`
                : t(`model.providers.${kind}`)}
            </option>
          ))}
        </select>
      </label>

      {provider === "local" && builtIn ? (
        <div className="built-in-model" role="status">
          <strong>{builtIn.name}</strong>
          <span>{builtIn.modelId}</span>
        </div>
      ) : (
        <>
          <label htmlFor={`${prefix}-address`}>
            {t("model.apiAddress")}
            <input
              ref={addressInput}
              id={`${prefix}-address`}
              name="baseUrl"
              value={baseUrl}
              onChange={(event) => {
                setBaseUrl(event.target.value);
                resetDiscovery();
              }}
              autoComplete="url"
              spellCheck={false}
            />
          </label>

          {requiresKey && (
            <div className="model-field">
              <label htmlFor={`${prefix}-key`}>{t("model.apiKey")}</label>
              <span className="secret-field">
                <input
                  ref={keyInput}
                  id={`${prefix}-key`}
                  name="apiKey"
                  type={showApiKey ? "text" : "password"}
                  value={apiKey}
                  placeholder={hasStoredCredential ? fixedCredentialMask : ""}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    resetDiscovery();
                  }}
                  autoComplete="new-password"
                  spellCheck={false}
                />
                <button
                  type="button"
                  aria-label={t(showApiKey ? "model.hideApiKey" : "model.showApiKey")}
                  onClick={() => setShowApiKey((current) => !current)}
                >{showApiKey ? "◉" : "◎"}</button>
              </span>
            </div>
          )}

          <div className="discovery-row">
            <button
              className="outline-button"
              type="button"
              disabled={discoveryState === "busy"}
              onClick={() => void discoverModels()}
            >{discoveryState === "busy" ? t("model.fetching") : t("model.getModels")}</button>
            <span role="status" aria-live="polite">
              {discoveryState === "success" ? `✓ ${t("model.fetchSuccess")}` : ""}
            </span>
          </div>

          {error && <p className="model-error" role="alert">{error}</p>}

          {manual ? (
            <label htmlFor={`${prefix}-manual-model`}>
              {t("model.modelName")}
              <input
                ref={modelInput}
                id={`${prefix}-manual-model`}
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                maxLength={200}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          ) : (
            <label htmlFor={`${prefix}-model`}>
              {t("model.model")}
              <select
                id={`${prefix}-model`}
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                disabled={models.length === 0}
              >
                <option value="">{t("model.chooseModel")}</option>
                {models.map((model) => (
                  <option value={model.id} key={model.id}>{model.displayName}</option>
                ))}
              </select>
            </label>
          )}
          <button className="manual-model-button" type="button" onClick={() => setManual((current) => !current)}>
            {manual ? t("model.chooseDiscovered") : t("model.manualModel")}
          </button>
        </>
      )}
      </fieldset>
    </section>
  );
}
