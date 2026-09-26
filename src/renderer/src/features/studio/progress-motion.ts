/**
 * Displayed progress for a running transformation.
 *
 * The main process only reports milestones (20 = inputs ready, 40 = provider
 * answered, 80 = text generated, 100 = persisted). The renderer walks the shown
 * number toward display ceilings at a per-segment rate. Waiting for a response
 * may climb to 50%; a confirmed response catches up there within two seconds.
 */

/**
 * Highest percentage the card may show for the reported milestone.
 *
 * Model response caps at 50%, content generation at 80%, saving at 99%, and
 * the persisted result is the only state that reaches 100%.
 */
export function progressCeiling(backendPercent: number): number {
  if (backendPercent >= 100) return 100;
  // 99 keeps the last point for the persisted result.
  if (backendPercent >= 80) return 99;
  // The provider answered: catch up to 50, then stream at 6%/s up to 80.
  if (backendPercent >= 40) return 80;
  // Model response in progress: climb at 4%/s, capped at 50%.
  return 50;
}

/** Percentage points per second for the segment the number is currently in. */
function percentPerSecond(current: number, ceiling: number): number {
  // 0 -> 20 takes 4s, so "preparing" is always visible for at least that long.
  if (current < 20) return 5;
  if (ceiling <= 50) return 4;
  // Keep the existing content generation rate after reaching 50%.
  if (current < 80) return 6;
  // 80 -> 99 while the result is written; settles in about a second.
  return 20;
}

/** Walks the displayed number toward the ceiling; never decreases. */
export function advancePercent(current: number, ceiling: number, elapsedMs: number): number {
  if (current >= ceiling) return current;
  // A real response catches up to 50%, then the next tick resumes normal motion.
  if (ceiling >= 80 && current < 50) return Math.min(50, current + (30 * elapsedMs) / 1000);
  return Math.min(ceiling, current + (percentPerSecond(current, ceiling) * elapsedMs) / 1000);
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
