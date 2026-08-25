import { z } from "zod";

export const appErrorCodeSchema = z.enum([
  "VALIDATION",
  "NOT_FOUND",
  "CONFLICT",
  "CANCELLED",
  "AUTH",
  "RATE_LIMITED",
  "TIMEOUT",
  "NETWORK",
  "PROVIDER",
  "UNSUPPORTED_FORMAT",
  "UNSAFE_INPUT",
  "INDEX_UNAVAILABLE",
  "INTERNAL"
]);

const appErrorDetailSchema = z.union([z.string(), z.number(), z.boolean()]);

export const appErrorDtoSchema = z.object({
  code: appErrorCodeSchema,
  messageKey: z.string().min(1),
  recoverable: z.boolean(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  details: z.record(z.string(), appErrorDetailSchema).optional()
}).strict();

export type AppErrorCode = z.infer<typeof appErrorCodeSchema>;
export type AppErrorDto = z.infer<typeof appErrorDtoSchema>;

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: AppErrorDto };
