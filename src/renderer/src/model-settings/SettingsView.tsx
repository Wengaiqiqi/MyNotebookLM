import * as React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ModelConfigurationForms, persistModelConfiguration, type ModelSettingsData } from "./FirstLaunch";
import type { ModelProfileDraft } from "./ModelProfileForm";
import { modelErrorText } from "./model-error-text";

export default function SettingsView({
  data,
  onCancel,
  onSaved
}: Readonly<{
  data: ModelSettingsData;
  onCancel(): void;
  onSaved(): Promise<string | undefined> | string | undefined;
}>) {
  const { t } = useTranslation();
  const [generation, setGeneration] = useState<ModelProfileDraft>();
  const [embedding, setEmbedding] = useState<ModelProfileDraft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError("");
    const result = await persistModelConfiguration({ generation, embedding });
    if (!result.ok) {
      setError(modelErrorText(t, result.messageKey));
      setBusy(false);
      return;
    }
    const completionError = await onSaved();
    if (completionError) {
      setError(modelErrorText(t, completionError));
    }
    setBusy(false);
  }

  return (
    <main className="model-page settings-page">
      <header className="model-page-header title-drag-region">
        <div>
          <h2>{t("settings.title")}</h2>
          <p>{t("settings.subtitle")}</p>
        </div>
      </header>
      <div className="settings-center">
        <nav aria-label={t("settings.title")}>
          <span>{t("settings.general")}</span>
          <span>{t("settings.languageAppearance")}</span>
          <strong aria-current="page">{t("settings.modelServices")}</strong>
          <span>{t("settings.dataIndex")}</span>
        </nav>
        <section className="settings-model-content" aria-labelledby="model-services-title">
          <h3 id="model-services-title">{t("settings.modelServices")}</h3>
          <ModelConfigurationForms
            data={data}
            disabled={busy}
            onGenerationChange={setGeneration}
            onEmbeddingChange={setEmbedding}
          />
        </section>
      </div>
      {error && <p className="model-page-error" role="alert">{error}</p>}
      <footer className="settings-actions">
        <span>{t("onboarding.localCredential")}</span>
        <button type="button" disabled={busy} onClick={onCancel}>{t("common.cancel")}</button>
        <button className="primary-button" type="button" disabled={busy} onClick={() => void save()}>
          {busy ? t("common.saving") : t("common.save")}
        </button>
      </footer>
    </main>
  );
}
