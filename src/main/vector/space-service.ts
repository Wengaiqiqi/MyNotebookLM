import { SpaceRepository } from "./space-repository";
import type { SpaceSpec } from "./space-repository";
export class SpaceService {
  constructor(private repo:SpaceRepository) {}
  async build(spec:SpaceSpec, work:()=>Promise<void>, signal?:AbortSignal):Promise<void> { const space=this.repo.createOrReuse(spec); try { if(signal?.aborted) throw new Error("cancelled"); await work(); if(signal?.aborted) throw new Error("cancelled"); this.repo.activate(spec.projectId,space.id); } catch(error) { this.repo.fail(space.id); throw error; } }
}
