export type FinishKind = "stop" | "length" | "context-limit" | "other";

/**
 * Maps a provider finish reason onto the app's four terminal kinds. Unknown
 * reasons (content filters, tool calls, refusals) must not read as length.
 */
export function normalizeFinishReason(value: string | undefined): FinishKind {
  const reason = value?.trim().toLowerCase();
  if (reason === "length" || reason === "max_tokens" || reason === "max_tokens_reached" || reason === "max-tokens" || reason === "max_output_tokens") return "length";
  if (reason === "context_limit" || reason === "context-limit" || reason === "context_length_exceeded" || reason === "model_context_window_exceeded" || reason === "context-window-exceeded" || reason === "prompt_too_long" || reason === "input_too_long") return "context-limit";
  if (reason === undefined || reason === "stop" || reason === "end_turn" || reason === "end" || reason === "done" || reason === "stop_sequence") return "stop";
  return "other";
}
