import * as React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { DefaultModelRoutesDto, ModelProfileListDto } from "../../../shared/models";
import ModelProfileForm, { type ModelProfileDraft } from "./ModelProfileForm";

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

  for (const draft of ordered) {
    if (!draft) continue;
    const routed = await window.myNotebook.models.setDefaultRoute({
      capability: draft.profile.capability,
      profileId: draft.profile.id
    });
    if (!routed.ok) return { ok: false, messageKey: routed.error.messageKey };
  }
  return { ok: true };
}

export function ModelConfigurationForms({
  data,
  onGenerationChange,
  onEmbeddingChange
}: Readonly<{
  data: ModelSettingsData;
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
  onComplete,
  onSkip
}: Readonly<{
  data: ModelSettingsData;
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
      setError(t(result.messageKey, { defaultValue: t("model.errors.request") }));
      setBusy(false);
      return;
    }
    const completionError = await onComplete();
    if (completionError) {
      setError(t(completionError, { defaultValue: t("model.errors.request") }));
    }
    setBusy(false);
  }

  async function skip(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError("");
    const completionError = await onSkip();
    if (completionError) {
      setError(t(completionError, { defaultValue: t("model.errors.request") }));
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
      </header>
      <ModelConfigurationForms
        data={data}
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
