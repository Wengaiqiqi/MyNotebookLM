import { z } from "zod";

export const appLanguageSchema = z.enum(["zh-CN", "en"]);
export const appThemeSchema = z.enum(["light", "dark"]);
/** How model-provider and model-download requests reach the network. */
export const proxyModeSchema = z.enum(["system", "direct", "manual"]);

const PROXY_URL_PATTERN = /^(https?|socks4|socks5):\/\/(\[[0-9a-f:.]+\]|[^\s/:@]+)(:\d{1,5})?\/?$/i;
export const proxyUrlSchema = z.string().trim().max(500)
  .refine((value) => value === "" || PROXY_URL_PATTERN.test(value), "Invalid proxy address");

const appSettingsFields = z.object({
  onboardingCompleted: z.boolean(),
  locale: appLanguageSchema,
  theme: appThemeSchema,
  proxyMode: proxyModeSchema,
  proxyUrl: proxyUrlSchema,
  /** Hosts that always connect directly, separated by commas, semicolons or new lines. */
  proxyBypass: z.string().max(4000)
}).strict();

export const appSettingsDtoSchema = appSettingsFields.refine(
  (settings) => settings.proxyMode !== "manual" || settings.proxyUrl !== "",
  { message: "Manual proxy mode needs a proxy address", path: ["proxyUrl"] }
);

export const updateAppSettingsInputSchema = appSettingsFields.partial().strict().refine(
  (input) => Object.keys(input).length > 0,
  "At least one setting is required"
);

export type AppLanguage = z.infer<typeof appLanguageSchema>;
export type AppTheme = z.infer<typeof appThemeSchema>;
export type ProxyMode = z.infer<typeof proxyModeSchema>;
export type AppSettingsDto = z.infer<typeof appSettingsDtoSchema>;
export type UpdateAppSettingsInput = z.infer<typeof updateAppSettingsInputSchema>;
