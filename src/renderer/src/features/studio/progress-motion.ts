import type { TaskStage } from "../../../../shared/tasks";

/**
 * Where a running transformation is, in steps the main process actually
 * reports. Model generation has no measurable total, so `fraction` is only set
 * while a step reports a real fraction; otherwise the card shows the step as
 * in progress without inventing a percentage.
 */
export type StepProgress<Step extends string> = { steps: readonly Step[]; index: number; fraction: number | null };

const textSteps = ["preparing", "connecting", "generating", "saving"] as const;
const mindMapSteps = ["preparing", "generating", "verifying", "saving"] as const;

/** Text transformations: 200 = started, 400 = model answered, 800 = saving. */
export function textStepProgress(stage: TaskStage, progress: number): StepProgress<typeof textSteps[number]> {
  const index = stage === "saving" || progress >= 800 ? 3 : progress >= 400 ? 2 : progress >= 200 ? 1 : 0;
  return { steps: textSteps, index, fraction: null };
}

/** Mind maps: preparation reports 100-350 while chunking input, then one milestone per stage. */
export function mindMapStepProgress(stage: TaskStage, progress: number): StepProgress<typeof mindMapSteps[number]> {
  const index = stage === "saving" ? 3 : stage === "verifying" ? 2 : stage === "generating" ? 1 : 0;
  const fraction = index === 0 && progress >= 100 ? Math.min(1, (progress - 100) / 250) : null;
  return { steps: mindMapSteps, index, fraction };
}

/** Animate podcast preparation for three seconds, then use actual milestones. */
export function advancePodcastPercent(current: number, backendPercent: number, elapsedMs: number): number {
  return Math.max(current, current < 20 ? Math.min(20, (Math.max(0, elapsedMs) * 20) / 3000) : backendPercent);
}
