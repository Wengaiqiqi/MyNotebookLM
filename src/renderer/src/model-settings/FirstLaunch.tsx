import * as React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { DefaultModelRoutesDto, ModelProfileListDto } from "../../../shared/models";
import type { AppTheme } from "../../../shared/settings";
import ModelProfileForm, { type ModelProfileDraft } from "./ModelProfileForm";
import { modelErrorText } from "./model-error-text";

export type ModelSettingsData = Readonly<{
  profiles: ModelProfileListDto;
  routes: DefaultModelRoutesDto;
}>;

type Drafts = Readonly<{
  generation?: ModelProfileDraft | undefined;
  embedding?: ModelProfileDraft | undefined;
}>;

type PersistResult =
  | { ok: true }
  | { ok: false; messageKey: string };

export async function persistModelConfiguration(drafts: Drafts): Promise<PersistResult> {
  const ordered = [drafts.generation, drafts.embedding];
  if (ordered.some((draft) => !draft?.valid)) {
    return { ok: false, messageKey: "model.validation.complete" };
  }

  for (const draft of ordered) {
    if (!draft || draft.profile.provider === "local") continue;
    const tested = await window.myNotebook.models.test({
      profile: draft.profile,
      ...(draft.apiKey ? { apiKey: draft.apiKey } : {})
    });
    if (!tested.ok) return { ok: false, messageKey: tested.error.messageKey };
  }

  for (const draft of ordered) {
    if (!draft || draft.profile.provider === "local") continue;
    const saved = await window.myNotebook.models.saveProfile({
      profile: draft.profile,
      ...(draft.apiKey ? { apiKey: draft.apiKey } : {})
    });
    if (!saved.ok) return { ok: false, messageKey: saved.error.messageKey };
  }

  const generationProfileId = drafts.generation?.profile.id;
  const embeddingProfileId = drafts.embedding?.profile.id;
  if (!generationProfileId || !embeddingProfileId) {
    return { ok: false, messageKey: "model.validation.complete" };
  }
  const routed = await window.myNotebook.models.setDefaultRoutes({
    generationProfileId,
    embeddingProfileId
  });
  if (!routed.ok) return { ok: false, messageKey: routed.error.messageKey };
  return { ok: true };
}

export function ModelConfigurationForms({
  data,
  disabled = false,
  onGenerationChange,
  onEmbeddingChange
}: Readonly<{
  data: ModelSettingsData;
  disabled?: boolean;
  onGenerationChange(draft: ModelProfileDraft): void;
  onEmbeddingChange(draft: ModelProfileDraft): void;
}>) {
  return (
    <div className="model-forms-grid">
      <ModelProfileForm
        capability="generation"
        profiles={data.profiles.profiles}
        builtInProfiles={data.profiles.builtInProfiles}
        credentials={data.profiles.credentials}
        disabled={disabled}
        {...(data.routes.generationProfileId
          ? { initialProfileId: data.routes.generationProfileId }
          : {})}
        onChange={onGenerationChange}
      />
      <ModelProfileForm
        capability="embedding"
        profiles={data.profiles.profiles}
        builtInProfiles={data.profiles.builtInProfiles}
        credentials={data.profiles.credentials}
        disabled={disabled}
        {...(data.routes.embeddingProfileId
          ? { initialProfileId: data.routes.embeddingProfileId }
          : {})}
        onChange={onEmbeddingChange}
      />
    </div>
  );
}

export default function FirstLaunch({
  data,
  theme,
  onThemeChange,
  onComplete,
  onSkip
}: Readonly<{
  data: ModelSettingsData;
  theme: AppTheme;
  onThemeChange(theme: AppTheme): void;
  onComplete(): Promise<string | undefined> | string | undefined;
  onSkip(): Promise<string | undefined> | string | undefined;
}>) {
  const { t } = useTranslation();
  const [generation, setGeneration] = useState<ModelProfileDraft>();
  const [embedding, setEmbedding] = useState<ModelProfileDraft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function finish(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError("");
    const result = await persistModelConfiguration({ generation, embedding });
    if (!result.ok) {
      setError(modelErrorText(t, result.messageKey));
      setBusy(false);
      return;
    }
    const completionError = await onComplete();
    if (completionError) {
      setError(modelErrorText(t, completionError));
    }
    setBusy(false);
  }

  async function skip(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError("");
    const completionError = await onSkip();
    if (completionError) {
      setError(modelErrorText(t, completionError));
    }
    setBusy(false);
  }

  return (
    <main className="model-page first-launch-page">
      <header className="model-page-header title-drag-region">
        <div>
          <h2>{t("onboarding.title")}</h2>
          <p>{t("onboarding.subtitle")}</p>
        </div>
        <div className="onboarding-theme-toggle title-no-drag" role="group" aria-label={t("common.theme")}>
          <button type="button" disabled={busy} aria-pressed={theme === "light"} onClick={() => onThemeChange("light")}>
            <span aria-hidden="true">☼</span>{t("common.light")}
          </button>
          <button type="button" disabled={busy} aria-pressed={theme === "dark"} onClick={() => onThemeChange("dark")}>
            <span aria-hidden="true">◐</span>{t("common.dark")}
          </button>
        </div>
      </header>
      <ModelConfigurationForms
        data={data}
        disabled={busy}
        onGenerationChange={setGeneration}
        onEmbeddingChange={setEmbedding}
      />
      {error && <p className="model-page-error" role="alert">{error}</p>}
      <footer className="first-launch-actions">
        <button className="primary-button" type="button" disabled={busy} onClick={() => void finish()}>
          {busy ? t("common.saving") : t("onboarding.finish")}
        </button>
        <button className="text-button" type="button" disabled={busy} onClick={() => void skip()}>
          {t("onboarding.skip")}
        </button>
        <span>{t("onboarding.localCredential")}</span>
      </footer>
    </main>
  );
}
