import {
  modelTaskKindSchema,
  modelOutputKind,
  type ModelProfileDto,
  type ModelTaskKind
} from "../../shared/models";
import type { RouteRepository } from "./route-repository";

const generationTasks = new Set<ModelTaskKind>([
  "chat",
  "note-title",
  "summary",
  "key-points",
  "qa",
  "custom-transformation",
  "podcast"
]);

export type ModelProfileSnapshot = Readonly<ModelProfileDto>;

export class ModelRouter {
  constructor(
    private readonly routes: Pick<RouteRepository, "getProfile" | "getRoute">
  ) {}

  resolve(taskKind: ModelTaskKind, explicitProfileId?: string): readonly ModelProfileSnapshot[] {
    const task = modelTaskKindSchema.parse(taskKind);
    const requiredCapability = generationTasks.has(task) ? "generation" : "embedding";
    if (task === "embedding") {
      const profileId = explicitProfileId ?? [...this.routes.getRoute(task)]
        .sort((a, b) => a.position - b.position)[0]?.profileId;
      const profile = profileId === undefined ? undefined : this.routes.getProfile(profileId);
      if (!profile || !profile.enabled || profile.capability !== requiredCapability) return Object.freeze([]);
      return Object.freeze([Object.freeze({ ...profile })]);
    }

    const configuredRoutes = this.routes.getRoute(task);
    // Specialized transformation routes are optional. If one is absent,
    // reuse the configured chat route so a missing per-task setting does not
    // turn a valid transformation into a generic failure.
    const fallbackRoutes = explicitProfileId === undefined && configuredRoutes.length === 0 && task !== "chat" && task !== "podcast"
      ? this.routes.getRoute("chat")
      : configuredRoutes;
    const candidates = [
      ...(explicitProfileId === undefined ? [] : [explicitProfileId]),
      ...[...fallbackRoutes].sort((a, b) => a.position - b.position).map((route) => route.profileId)
    ];
    const seen = new Set<string>();
    const resolved: ModelProfileSnapshot[] = [];

    for (const profileId of candidates) {
      if (seen.has(profileId)) continue;
      seen.add(profileId);
      const profile = this.routes.getProfile(profileId);
      if (!profile || !profile.enabled || profile.capability !== requiredCapability) continue;
      if (task !== "podcast" && modelOutputKind(profile) === "speech") continue;
      resolved.push(Object.freeze({ ...profile }));
    }

    return Object.freeze(resolved);
  }
}
