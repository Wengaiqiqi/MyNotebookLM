import { z } from "zod";

export const appLanguageSchema = z.enum(["zh-CN", "en"]);
export const appThemeSchema = z.enum(["light", "dark"]);

export const appSettingsDtoSchema = z.object({
  onboardingCompleted: z.boolean(),
  locale: appLanguageSchema,
  theme: appThemeSchema
}).strict();

export const updateAppSettingsInputSchema = appSettingsDtoSchema.partial().strict().refine(
  (input) => Object.keys(input).length > 0,
  "At least one setting is required"
);

export type AppLanguage = z.infer<typeof appLanguageSchema>;
export type AppTheme = z.infer<typeof appThemeSchema>;
export type AppSettingsDto = z.infer<typeof appSettingsDtoSchema>;
export type UpdateAppSettingsInput = z.infer<typeof updateAppSettingsInputSchema>;
