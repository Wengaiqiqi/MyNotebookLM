import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BuiltInModelProfileDto, DefaultModelRoutesDto, ModelProfileDto } from "../../../../shared/models";
import ModelForm from "../models/ModelForm";
import Icon from "../../ui/Icon";
import type { AppLanguage, AppTheme } from "../../i18n";

export interface OnboardingProps {
  language: AppLanguage;
  theme: AppTheme;
  onLanguage: (language: AppLanguage) => void;
  onTheme: (theme: AppTheme) => void;
  onFinish: (result: { generationProfileId?: string | undefined; embeddingProfileId?: string | undefined }) => Promise<void>;
}

/**
 * First-launch setup: configure a generation model and an embedding provider.
 */
export default function Onboarding({ theme, onTheme, onFinish }: OnboardingProps) {
  const { t } = useTranslation();
  const [generationProfile, setGenerationProfile] = useState<ModelProfileDto>();
  const [embeddingSelectionId, setEmbeddingSelectionId] = useState<string>();
  const [builtIns, setBuiltIns] = useState<BuiltInModelProfileDto[]>([]);
  const [routes, setRoutes] = useState<DefaultModelRoutesDto>({});
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void window.myNotebook.models.listProfiles().then((result) => {
      if (result.ok) {
        setBuiltIns(result.value.builtInProfiles);
        const first = result.value.builtInProfiles[0];
        if (first) setEmbeddingSelectionId((current) => current ?? first.id);
      }
    }).catch(() => undefined);
    void window.myNotebook.models.getDefaultRoutes().then((result) => {
      if (result.ok) {
        setRoutes(result.value);
        if (result.value.embeddingProfileId) setEmbeddingSelectionId((current) => current ?? result.value.embeddingProfileId);
      }
    }).catch(() => undefined);
  }, []);

  const builtinEmbedding = builtIns[0];
  const selectedEmbeddingProfileId = embeddingSelectionId;

  async function finish(): Promise<void> {
    setFinishing(true); setError("");
    const generationProfileId = generationProfile?.id ?? routes.generationProfileId;
    const embeddingProfileId = selectedEmbeddingProfileId;
    try {
      if (generationProfileId && embeddingProfileId) {
        const saved = await window.myNotebook.models.setDefaultRoutes({ generationProfileId, embeddingProfileId });
        if (!saved.ok) {
          setError(t(saved.error.messageKey));
          return;
        }
      }
      await onFinish({ generationProfileId, embeddingProfileId });
    } finally {
      setFinishing(false);
    }
  }

  return (
    <div className="center-stage fade-in">
      <div className="stage-inner">
        <header className="stage-head">
          <h1>{t("onboarding.title")}</h1>
          <p>{t("onboarding.subtitle")}</p>
          <p className="hint" style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--ink-3)", fontSize: 12.5, marginTop: 8 }}>
            <Icon name="key" />{t("onboarding.localCredential")}
          </p>
          <div className="seg" style={{ marginTop: 14 }}>
            <button type="button" aria-pressed={theme === "light"} onClick={() => onTheme("light")}><Icon name="sun" />{t("common.light")}</button>
            <button type="button" aria-pressed={theme === "dark"} onClick={() => onTheme("dark")}><Icon name="moon" />{t("common.dark")}</button>
          </div>
        </header>

        <div className="model-grid">
          <ModelForm capability="generation" onSaved={setGenerationProfile} />

          <ModelForm
            capability="embedding"
            initialProvider="local"
            builtIn={builtinEmbedding}
            onProfileSelected={(profile) => setEmbeddingSelectionId(profile?.id)}
            onSaved={(profile) => setEmbeddingSelectionId(profile.id)}
          />
        </div>

        {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}

        <div className="stage-actions card">
          <span className="note">
            {generationProfile
              ? t("onboarding.readySummary")
              : t("onboarding.skipHint")}
          </span>
          <span className="spacer" />
          <button type="button" className="btn" disabled={finishing} onClick={() => void finish()}>
            {finishing ? <span className="spinner" aria-hidden="true" /> : null}
            {t("onboarding.skip")}
          </button>
          <button type="button" className="btn primary" disabled={finishing || (!generationProfile && !(routes.generationProfileId)) || !selectedEmbeddingProfileId} onClick={() => void finish()}>
            {finishing ? <span className="spinner light" aria-hidden="true" /> : <Icon name="check" />}
            {t("onboarding.finish")}
          </button>
        </div>
      </div>
    </div>
  );
}
