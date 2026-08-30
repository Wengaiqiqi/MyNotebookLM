import type { Result } from "../../../shared/app-errors";
import type { AppLanguage } from "../i18n";

export function formatDate(value: string, language: AppLanguage): string {
  return new Intl.DateTimeFormat(language, { year: "numeric", month: "short", day: "numeric" }).format(new Date(value));
}

export function formatDateTime(value: string, language: AppLanguage): string {
  return new Intl.DateTimeFormat(language, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit === 0 ? Math.round(value) : Number(value.toFixed(1))} ${units[unit]}`;
}

export function formatPercent(progress: number): string {
  return `${Math.max(0, Math.min(100, Math.round(progress / 10)))}%`;
}

/** True when a source is fully parsed + embedded and can be cited in chat. */
export function sourceReady(source: { status: string; currentRevisionState?: string | undefined; currentRevisionId: string | null }): boolean {
  return source.status === "active" && source.currentRevisionState === "ready" && Boolean(source.currentRevisionId);
}

/** Human label for a source kind (file badge). */
export function kindLabel(kind: string): string {
  switch (kind) {
    case "markdown": return "MD";
    case "text": return "TXT";
    case "url": return "URL";
    default: return kind.toUpperCase();
  }
}

export const cssKindClass = (kind: string): string => {
  switch (kind) {
    case "markdown": return "kind-md";
    case "text": return "kind-txt";
    case "url": return "kind-url";
    default: return `kind-${kind}`;
  }
};

/** Translate a Result error messageKey with a graceful fallback. */
export function errorText(result: { ok: false; error: { messageKey: string; code: string } }, t: (key: string) => string): string {
  const translated = t(result.error.messageKey);
  return translated === result.error.messageKey ? t("errors.internal") : translated;
}

export const isResultOk = <T,>(result: Result<T>): result is Extract<Result<T>, { ok: true }> => result.ok;
