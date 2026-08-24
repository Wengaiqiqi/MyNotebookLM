import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en";
import zhCN from "./locales/zh-CN";

export type AppLanguage = "zh-CN" | "en";
export type AppTheme = "light" | "dark";

const language = localStorage.getItem("mynotebooklm.language") === "en" ? "en" : "zh-CN";

await i18n.use(initReactI18next).init({
  lng: language,
  fallbackLng: "zh-CN",
  interpolation: { escapeValue: false },
  resources: {
    en: { translation: en },
    "zh-CN": { translation: zhCN }
  }
});

export async function changeLanguage(next: AppLanguage): Promise<void> {
  localStorage.setItem("mynotebooklm.language", next);
  await i18n.changeLanguage(next);
}

export function readTheme(): AppTheme {
  return localStorage.getItem("mynotebooklm.theme") === "dark" ? "dark" : "light";
}

export function changeTheme(next: AppTheme): void {
  localStorage.setItem("mynotebooklm.theme", next);
  document.documentElement.dataset.theme = next;
}

changeTheme(readTheme());

export default i18n;
