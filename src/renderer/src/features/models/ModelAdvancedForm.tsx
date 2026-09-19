import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelProfileDto } from "../../../../shared/models";
import Icon from "../../ui/Icon";
import { toast } from "../../ui/Toast";

const UNKNOWN_CONTEXT_TOKENS = 32_768;
const DEFAULT_OUTPUT_TOKENS = 8_192;

/** Automatic (unoverridden) context capacity: provider data, else the conservative default. */
function effectiveContext(profile: ModelProfileDto): number {
  const limits = profile.generationLimits;
  if (limits?.windowKind === "input-only") return limits.inputTokenLimit ?? UNKNOWN_CONTEXT_TOKENS;
  return limits?.contextWindowTokens ?? UNKNOWN_CONTEXT_TOKENS;
}

/** Automatic output allowance: provider cap, else the conservative default. */
function effectiveOutput(profile: ModelProfileDto): number {
  return Math.min(profile.generationLimits?.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS, DEFAULT_OUTPUT_TOKENS);
}

/** Where the displayed automatic value came from, so the hint can say which. */
function contextSource(profile: ModelProfileDto): "provider" | "default" {
  const limits = profile.generationLimits;
  return limits?.windowKind === "input-only"
    ? (limits.inputTokenLimit === undefined ? "default" : "provider")
    : (limits?.contextWindowTokens === undefined ? "default" : "provider");
}

function parsePositive(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647 ? parsed : null;
}

export default function ModelAdvancedForm({ profile, onSaved, onCancel }: {
  profile: ModelProfileDto;
  onSaved: (profile: ModelProfileDto) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [contextValue, setContextValue] = useState(profile.contextTokensOverride?.toString() ?? "");
  const [outputValue, setOutputValue] = useState(profile.maxOutputTokensOverride?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const limits = profile.generationLimits;
  const contextDefault = useMemo(() => effectiveContext(profile), [profile]);
  const outputDefault = useMemo(() => effectiveOutput(profile), [profile]);
  const contextFromProvider = contextSource(profile) === "provider";

  function validate(value: string, label: string): number | null | undefined {
    if (!value.trim()) return null;
    const parsed = parsePositive(value);
    if (parsed === null) {
      setError(t("model.validation.positiveTokens", { field: label }));
      return undefined;
    }
    return parsed;
  }

  async function save(): Promise<void> {
    if (saving) return;
    setError("");
    const context = validate(contextValue, t("model.contextTokens"));
    const output = validate(outputValue, t("model.maxOutputTokens"));
    if (context === undefined || output === undefined) return;
    setSaving(true);
    const update = window.myNotebook.models.updateGenerationSettings;
    const result = await update?.({
      profileId: profile.id,
      contextTokensOverride: context,
      maxOutputTokensOverride: output
    }).catch(() => undefined);
    setSaving(false);
    if (!result?.ok) {
      setError(t(result?.error.messageKey ?? "errors.internal", result && !result.ok ? result.error.details ?? {} : {}));
      return;
    }
    toast.success(t("model.generationSettingsSaved"));
    onSaved(result.value);
  }

  return (
    <div className="model-card card model-advanced-form">
      <div className="model-card-head">
        <span className="model-card-glyph" aria-hidden="true"><Icon name="cpu" /></span>
        <div>
          <h3>{profile.modelId}</h3>
        </div>
      </div>

      <p className="field-hint">{t("model.generationScopeHint")}</p>
      <label className="field" htmlFor="model-context-tokens">
        {t("model.contextTokens")}
        <input
          id="model-context-tokens"
          className="input"
          type="number"
          min={1}
          step={1}
          value={contextValue}
          placeholder={String(contextDefault)}
          onChange={(event) => setContextValue(event.target.value)}
          inputMode="numeric"
        />
        <small className="field-hint">{limits?.windowKind === "input-only"
          ? t("model.contextInputOnlyHint", { value: contextDefault })
          : contextFromProvider
            ? t("model.contextAutomaticHint", { value: contextDefault })
            : t("model.contextDefaultHint", { value: contextDefault })}</small>
        <button type="button" className="btn outline sm" onClick={() => setContextValue("")}>{t("model.restoreAutomatic")}</button>
      </label>

      <label className="field" htmlFor="model-max-output-tokens">
        {t("model.maxOutputTokens")}
        <input
          id="model-max-output-tokens"
          className="input"
          type="number"
          min={1}
          step={1}
          value={outputValue}
          placeholder={String(outputDefault)}
          onChange={(event) => setOutputValue(event.target.value)}
          inputMode="numeric"
        />
        <small className="field-hint">{limits?.maxOutputTokens === undefined
          ? t("model.outputDefaultHint", { value: outputDefault })
          : t("model.outputAutomaticHint", { value: outputDefault })}</small>
        {limits?.maxOutputTokens !== undefined && <small className="field-hint">{t("model.outputCeilingHint", { value: limits.maxOutputTokens })}</small>}
        <button type="button" className="btn outline sm" onClick={() => setOutputValue("")}>{t("model.restoreAutomatic")}</button>
      </label>

      {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}

      <div className="dialog-foot" style={{ marginTop: 2 }}>
        <button type="button" className="btn" disabled={saving} onClick={onCancel}>{t("common.cancel")}</button>
        <button type="button" className="btn primary" disabled={saving} onClick={() => void save()}>
          {saving ? <span className="spinner light" aria-hidden="true" /> : <Icon name="check" />}
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}
