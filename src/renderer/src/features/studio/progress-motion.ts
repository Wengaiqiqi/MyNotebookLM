/**
 * Displayed progress for a running transformation.
 *
 * The main process only reports milestones (20 = inputs ready, 40 = provider
 * answered, 80 = text generated, 100 = persisted). The renderer walks the shown
 * number toward those ceilings at a per-segment rate so the percentage always
 * climbs instead of jumping, and never overtakes a milestone the main process
 * has not confirmed yet.
 */

/**
 * Highest percentage the card may show for the reported milestone.
 *
 * 0 = nothing confirmed yet, 20 = inputs ready, 80 = text generated, 100 =
 * persisted. The number is free to climb on its own between milestones, so a
 * long generation still reads as motion, but it never crosses one the main
 * process has not confirmed.
 */
export function progressCeiling(backendPercent: number): number {
  if (backendPercent >= 100) return 100;
  // 99 keeps the last point for the persisted result.
  if (backendPercent >= 80) return 99;
  // The provider answered: content streams at 6%/s up to 80 (10s for the span).
  if (backendPercent >= 40) return 80;
  // Inputs ready, provider silent: hold at 20 rather than fake generation.
  return 20;
}

/** Percentage points per second for the segment the number is currently in. */
function percentPerSecond(current: number): number {
  // 0 -> 20 takes 4s, so "preparing" is always visible for at least that long.
  if (current < 20) return 5;
  // 20 -> 80 while content generates: the whole stretch takes 10s.
  if (current < 80) return 6;
  // 80 -> 99 while the result is written; settles in about a second.
  return 20;
}

/** Walks the displayed number toward the ceiling; never decreases. */
export function advancePercent(current: number, ceiling: number, elapsedMs: number): number {
  if (current >= ceiling) return current;
  return Math.min(ceiling, current + (percentPerSecond(current) * elapsedMs) / 1000);
}

/**
 * Phase copy.
 *
 * "generating"/"saving" follow the confirmed milestone. "preparing" owns the
 * animated climb to 20%, so the phase reads for its full 4 seconds even when the
 * main process has inputs ready instantly; the wait for the provider's first
 * byte then shows as "connecting" instead of pretending generation started.
 */
export function progressPhase(
  displayedPercent: number,
  backendPercent: number
): "preparing" | "connecting" | "generating" | "saving" {
  if (backendPercent >= 80) return "saving";
  if (backendPercent >= 40) return "generating";
  return displayedPercent < 20 ? "preparing" : "connecting";
}
