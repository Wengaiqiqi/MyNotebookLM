import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BuiltInModelProfileDto, DefaultModelRoutesDto, ModelProfileDto } from "../../../../shared/models";
import ModelForm from "../models/ModelForm";
import Icon from "../../ui/Icon";
import { formatDate } from "../../lib/format";
import type { AppLanguage, AppTheme } from "../../i18n";

export interface OnboardingProps {
  language: AppLanguage;
  theme: AppTheme;
  onLanguage: (language: AppLanguage) => void;
  onTheme: (theme: AppTheme) => void;
  onFinish: (result: { generationProfileId?: string | undefined; embeddingProfileId?: string | undefined }) => Promise<void>;
}

/**
 * First-launch setup: configure a generation model and (optionally pick the
 * built-in local embedding model or configure a remote one), then enter the app.
 */
export default function Onboarding({ theme, onTheme, onFinish }: OnboardingProps) {
  const { t } = useTranslation();
  const [generationProfile, setGenerationProfile] = useState<ModelProfileDto>();
  const [embeddingProfile, setEmbeddingProfile] = useState<ModelProfileDto>();
  const [useBuiltinEmbedding, setUseBuiltinEmbedding] = useState(true);
  const [builtIns, setBuiltIns] = useState<BuiltInModelProfileDto[]>([]);
  const [routes, setRoutes] = useState<DefaultModelRoutesDto>({});
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void window.myNotebook.models.listProfiles().then((result) => {
      if (result.ok) setBuiltIns(result.value.builtInProfiles);
    }).catch(() => undefined);
    void window.myNotebook.models.getDefaultRoutes().then((result) => {
      if (result.ok) setRoutes(result.value);
    }).catch(() => undefined);
  }, []);

  const builtinEmbedding = builtIns[0];

  async function finish(): Promise<void> {
    setFinishing(true); setError("");
    const generationProfileId = generationProfile?.id ?? routes.generationProfileId;
    const embeddingProfileId = useBuiltinEmbedding
      ? (builtinEmbedding?.id ?? routes.embeddingProfileId)
      : (embeddingProfile?.id ?? routes.embeddingProfileId);
    try {
      if (generationProfileId && embeddingProfileId) {
        const saved = await window.myNotebook.models.setDefaultRoutes({ generationProfileId, embeddingProfileId });
        if (!saved.ok) setError(t(saved.error.messageKey));
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

          <div style={{ display: "grid", gap: 12 }}>
            {builtinEmbedding && (
              <button type="button" className="card" style={{ display: "flex", gap: 12, padding: "14px 16px", alignItems: "center", textAlign: "left", cursor: "pointer", borderColor: useBuiltinEmbedding ? "var(--accent)" : "var(--line)" }} aria-pressed={useBuiltinEmbedding} onClick={() => setUseBuiltinEmbedding(true)}>
                <span className="model-card-glyph" aria-hidden="true"><Icon name="cpu" /></span>
                <span style={{ flex: 1 }}>
                  <strong style={{ display: "block", fontSize: 14 }}>{builtinEmbedding.name}</strong>
                  <small style={{ color: "var(--ink-2)" }}>{t("model.builtInHint", { dimension: builtinEmbedding.dimension })}</small>
                </span>
                {useBuiltinEmbedding && <span className="badge accent"><Icon name="check" />{t("model.builtInSelected")}</span>}
              </button>
            )}
            {useBuiltinEmbedding
              ? null
              : <ModelForm capability="embedding" onSaved={setEmbeddingProfile} onCancel={() => setUseBuiltinEmbedding(true)} />}
            {builtinEmbedding && !useBuiltinEmbedding && (
              <button type="button" className="btn ghost sm" style={{ justifySelf: "start" }} onClick={() => setUseBuiltinEmbedding(true)}>
                <Icon name="cpu" />{t("model.useBuiltinInstead")}
              </button>
            )}
          </div>
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
          <button type="button" className="btn primary" disabled={finishing || (!generationProfile && !(routes.generationProfileId))} onClick={() => void finish()}>
            {finishing ? <span className="spinner light" aria-hidden="true" /> : <Icon name="check" />}
            {t("onboarding.finish")}
          </button>
        </div>
      </div>
    </div>
  );
}
