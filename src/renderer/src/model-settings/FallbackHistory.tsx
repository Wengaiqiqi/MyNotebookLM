import * as React from "react";
import { useTranslation } from "react-i18next";
import type { ModelRouteAttemptDto } from "../../../shared/models";

export default function FallbackHistory({ attempts }: Readonly<{ attempts: readonly ModelRouteAttemptDto[] }>) {
  const { t } = useTranslation();
  return (
    <section className="fallback-history" aria-labelledby="fallback-history-title">
      <h4 id="fallback-history-title">{t("routing.fallbackHistory")}</h4>
      {attempts.length === 0 ? <p>{t("routing.noFallbacks")}</p> : (
        <ul>
          {attempts.map((attempt) => (
            <li key={attempt.id}>
              <span>{attempt.provider} · {attempt.model}</span>
              <span className={`route-attempt-state route-attempt-${attempt.state}`}>{t(`routing.states.${attempt.state}`)}</span>
              {attempt.errorCode && <span>{attempt.errorCode}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
