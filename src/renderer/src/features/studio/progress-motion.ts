import type { TaskStage } from "../../../../shared/tasks";

/** Where a running transformation is, in steps the main process actually reports. */
export type StepProgress<Step extends string> = { steps: readonly Step[]; index: number };

const textSteps = ["preparing", "connecting", "generating", "saving"] as const;
const mindMapSteps = ["preparing", "generating", "verifying", "saving"] as const;

/** Text transformations: 200 = started, 400 = model answered, 800 = saving. */
export function textStepProgress(stage: TaskStage, progress: number): StepProgress<typeof textSteps[number]> {
  const index = stage === "saving" || progress >= 800 ? 3 : progress >= 400 ? 2 : progress >= 200 ? 1 : 0;
  return { steps: textSteps, index };
}

/** Mind maps: one milestone per stage. */
export function mindMapStepProgress(stage: TaskStage): StepProgress<typeof mindMapSteps[number]> {
  const index = stage === "saving" ? 3 : stage === "verifying" ? 2 : stage === "generating" ? 1 : 0;
  return { steps: mindMapSteps, index };
}

/** Catch-up toward a finished stage's boundary: the boundary and its fixed speed (% per ms). */
export type CatchUp = { target: number; rate: number } | null;

/**
 * Mind-map percentage. Each of the four stages owns 25%. The number creeps at
 * 1% per second and waits at the current stage's limit (99% for the last
 * stage; only the saved result shows 100%). When the main process reports a
 * later stage, the number rises to that stage's start within two seconds and
 * then creeps again.
 */
export function advanceMindMapPercent(current: number, stageIndex: number, elapsedMs: number, catchUp: CatchUp): { percent: number; catchUp: CatchUp } {
  const floor = stageIndex * 25;
  if (current < floor) {
    const rate = catchUp?.target === floor ? catchUp.rate : (floor - current) / 2000;
    const percent = Math.min(floor, current + rate * Math.max(0, elapsedMs));
    return { percent, catchUp: percent < floor ? { target: floor, rate } : null };
  }
  const cap = stageIndex >= 3 ? 99 : floor + 25;
  return { percent: current >= cap ? current : Math.min(cap, current + Math.max(0, elapsedMs) / 1000), catchUp: null };
}

/** Animate podcast preparation for three seconds, then use actual milestones. */
export function advancePodcastPercent(current: number, backendPercent: number, elapsedMs: number): number {
  return Math.max(current, current < 20 ? Math.min(20, (Math.max(0, elapsedMs) * 20) / 3000) : backendPercent);
}
