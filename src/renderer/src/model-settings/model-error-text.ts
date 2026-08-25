import type { TFunction } from "i18next";

const knownModelMessages = new Set([
  "errors.authentication",
  "errors.authorization",
  "errors.builtInModelImmutable",
  "errors.cancelled",
  "errors.configuration",
  "errors.credentialBinding",
  "errors.internal",
  "errors.invalidResponse",
  "errors.modelCapability",
  "errors.modelNotFound",
  "errors.modelProfileNotFound",
  "errors.modelRouteInconsistent",
  "errors.network",
  "errors.provider",
  "errors.rateLimited",
  "errors.timeout",
  "errors.validation",
  "model.validation.complete"
]);

export function modelErrorText(t: TFunction, messageKey: string): string {
  return knownModelMessages.has(messageKey)
    ? t(messageKey, { defaultValue: t("model.errors.request") })
    : t("model.errors.request");
}
