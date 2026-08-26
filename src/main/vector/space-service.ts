import { SpaceRepository } from "./space-repository";
import type { SpaceSpec } from "./space-repository";
export class SpaceService {
  constructor(private repo:SpaceRepository) {}
  async build(spec:SpaceSpec, work:()=>Promise<void>, signal?:AbortSignal):Promise<void> { const space=this.repo.createOrReuse(spec); try { if(signal?.aborted) throw Object.assign(new Error("Space build cancelled"), { code:"SPACE_BUILD_CANCELLED" }); await work(); if(signal?.aborted) throw Object.assign(new Error("Space build cancelled"), { code:"SPACE_BUILD_CANCELLED" }); this.repo.activate(spec.projectId,space.id); } catch(error) { if((error as any)?.code==="SPACE_BUILD_CANCELLED") this.repo.cancel(space.id); else this.repo.fail(space.id); throw error; } }
}
